package service

import (
	"context"
	"encoding/csv"
	"fmt"
	"io"
	"strings"
	"time"

	"github.com/gaucho-racing/ulid-go"
	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/database"
	"github.com/gaucho-racing/workbench/workbench/model"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/jackc/pgx/v5"
)

const importTimeout = 5 * time.Minute

type ImportResult struct {
	TransferID string `json:"transfer_id"`
	RowCount   int64  `json:"row_count"`
}

func ExportQueryCSV(ctx context.Context, target model.DatabaseTarget, statement string, actorEntityID string, destination io.Writer) (string, error) {
	transferID, err := startDataTransferRun(ctx, target, actorEntityID, "EXPORT", "", "", "", statement)
	if err != nil {
		return "", err
	}
	startedAt := time.Now()
	exportContext, cancel := context.WithTimeout(ctx, config.QueryTimeoutDuration)
	defer cancel()

	pool, err := TargetPool(exportContext, target)
	if err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return transferID, err
	}
	defer pool.Release()

	transaction, err := pool.BeginTx(exportContext, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return transferID, err
	}
	defer transaction.Rollback(context.Background())

	rows, err := transaction.Query(exportContext, statement)
	if err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return transferID, err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	if len(fields) == 0 {
		err = fmt.Errorf("export query must return columns")
		finishDataTransferRun(transferID, 0, startedAt, err)
		return transferID, err
	}

	writer := csv.NewWriter(destination)
	header := make([]string, len(fields))
	for index, field := range fields {
		header[index] = field.Name
	}
	if err := writer.Write(header); err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return transferID, err
	}

	var rowCount int64
	for rows.Next() {
		values, valuesErr := rows.Values()
		if valuesErr != nil {
			err = valuesErr
			break
		}
		record := make([]string, len(values))
		for index, value := range formatValues(values) {
			if value != nil {
				record[index] = fmt.Sprint(value)
			}
		}
		if writeErr := writer.Write(record); writeErr != nil {
			err = writeErr
			break
		}
		rowCount += 1
		if rowCount%256 == 0 {
			writer.Flush()
			if flushErr := writer.Error(); flushErr != nil {
				err = flushErr
				break
			}
		}
	}
	if err == nil {
		err = rows.Err()
	}
	writer.Flush()
	if err == nil {
		err = writer.Error()
	}
	if err == nil {
		err = transaction.Commit(exportContext)
	}
	finishDataTransferRun(transferID, rowCount, startedAt, err)
	return transferID, err
}

func ImportCSV(ctx context.Context, target model.DatabaseTarget, schemaName string, tableName string, fileName string, source io.ReadSeeker, actorEntityID string) (ImportResult, error) {
	transferID, err := startDataTransferRun(ctx, target, actorEntityID, "IMPORT", schemaName, tableName, fileName, "")
	if err != nil {
		return ImportResult{}, err
	}
	startedAt := time.Now()
	result := ImportResult{TransferID: transferID}
	importContext, cancel := context.WithTimeout(ctx, importTimeout)
	defer cancel()

	headerReader := csv.NewReader(source)
	header, err := headerReader.Read()
	if err != nil {
		err = fmt.Errorf("read CSV header: %w", err)
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}
	if len(header) == 0 {
		err = fmt.Errorf("CSV header must contain at least one column")
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}
	header[0] = strings.TrimPrefix(header[0], "\ufeff")

	pool, err := TargetPool(importContext, target)
	if err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}
	defer pool.Release()

	transaction, err := pool.Begin(importContext)
	if err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}
	defer transaction.Rollback(context.Background())
	if _, err = transaction.Exec(importContext, "SET LOCAL statement_timeout = '5min'"); err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}

	availableColumns, err := tableColumns(importContext, transaction, schemaName, tableName)
	if err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}
	seenColumns := make(map[string]struct{}, len(header))
	for _, column := range header {
		if column == "" {
			err = fmt.Errorf("CSV header contains a blank column")
			finishDataTransferRun(transferID, 0, startedAt, err)
			return result, err
		}
		if _, duplicate := seenColumns[column]; duplicate {
			err = fmt.Errorf("CSV header contains duplicate column %q", column)
			finishDataTransferRun(transferID, 0, startedAt, err)
			return result, err
		}
		if _, exists := availableColumns[column]; !exists {
			err = fmt.Errorf("column %q does not exist on %s.%s", column, schemaName, tableName)
			finishDataTransferRun(transferID, 0, startedAt, err)
			return result, err
		}
		seenColumns[column] = struct{}{}
	}
	if _, err = source.Seek(0, io.SeekStart); err != nil {
		finishDataTransferRun(transferID, 0, startedAt, err)
		return result, err
	}

	quotedColumns := make([]string, len(header))
	for index, column := range header {
		quotedColumns[index] = pgx.Identifier{column}.Sanitize()
	}
	copyStatement := fmt.Sprintf(
		"COPY %s (%s) FROM STDIN WITH (FORMAT csv, HEADER true, ENCODING 'UTF8')",
		pgx.Identifier{schemaName, tableName}.Sanitize(),
		strings.Join(quotedColumns, ", "),
	)
	commandTag, err := transaction.Conn().PgConn().CopyFrom(importContext, source, copyStatement)
	if err == nil {
		result.RowCount = commandTag.RowsAffected()
		err = transaction.Commit(importContext)
	}
	finishDataTransferRun(transferID, result.RowCount, startedAt, err)
	return result, err
}

func tableColumns(ctx context.Context, transaction pgx.Tx, schemaName string, tableName string) (map[string]struct{}, error) {
	rows, err := transaction.Query(ctx, `
		SELECT attribute.attname
		FROM pg_catalog.pg_attribute attribute
		JOIN pg_catalog.pg_class relation ON relation.oid = attribute.attrelid
		JOIN pg_catalog.pg_namespace namespace ON namespace.oid = relation.relnamespace
		WHERE namespace.nspname = $1 AND relation.relname = $2
		  AND relation.relkind IN ('r', 'p')
		  AND attribute.attnum > 0 AND NOT attribute.attisdropped`, schemaName, tableName)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	columns := make(map[string]struct{})
	for rows.Next() {
		var name string
		if err := rows.Scan(&name); err != nil {
			return nil, err
		}
		columns[name] = struct{}{}
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	if len(columns) == 0 {
		return nil, fmt.Errorf("table %s.%s does not exist or cannot accept imports", schemaName, tableName)
	}
	return columns, nil
}

func startDataTransferRun(ctx context.Context, target model.DatabaseTarget, actorEntityID string, direction string, schemaName string, tableName string, fileName string, statement string) (string, error) {
	id := ulid.Make().Prefixed("xfer")
	_, err := database.Pool.Exec(ctx, `
		INSERT INTO data_transfer_run (
			id, target_id, database_name, actor_entity_id, direction, schema_name,
			table_name, file_name, statement, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'RUNNING')`,
		id, target.ID, target.DatabaseName, actorEntityID, direction, schemaName, tableName, fileName, statement,
	)
	return id, err
}

func finishDataTransferRun(id string, rowCount int64, startedAt time.Time, transferError error) {
	status := "SUCCEEDED"
	errorMessage := ""
	if transferError != nil {
		status = "FAILED"
		errorMessage = transferError.Error()
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	completedAt := time.Now()
	if _, err := database.Pool.Exec(ctx, `
		UPDATE data_transfer_run
		SET status = $2, row_count = $3, duration_ms = $4, error_message = $5, completed_at = $6
		WHERE id = $1`, id, status, rowCount, completedAt.Sub(startedAt).Milliseconds(), errorMessage, completedAt); err != nil {
		logger.SugarLogger.Errorf("Failed to finalize data transfer %s: %v", id, err)
	}
}

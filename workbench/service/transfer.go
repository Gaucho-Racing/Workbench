package service

import (
	"context"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
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
	"github.com/parquet-go/parquet-go"
)

const (
	importTimeout         = 5 * time.Minute
	exportPreviewMaxRows  = 20
	exportPreviewMaxBytes = 512 << 10
)

type ImportResult struct {
	TransferID string `json:"transfer_id"`
	RowCount   int64  `json:"row_count"`
}

type ExportPreview struct {
	Columns   []model.QueryColumn `json:"columns"`
	Rows      [][]interface{}     `json:"rows"`
	RowCount  int                 `json:"row_count"`
	Truncated bool                `json:"truncated"`
}

type ExportFormat string

const (
	ExportFormatCSV     ExportFormat = "csv"
	ExportFormatJSON    ExportFormat = "json"
	ExportFormatParquet ExportFormat = "parquet"
	ExportFormatSQL     ExportFormat = "sql"
)

type ExportOptions struct {
	Format       ExportFormat
	SQLTableName string
}

func ParseExportFormat(value string) (ExportFormat, error) {
	format := ExportFormat(strings.ToLower(strings.TrimSpace(value)))
	switch format {
	case ExportFormatCSV, ExportFormatJSON, ExportFormatParquet, ExportFormatSQL:
		return format, nil
	default:
		return "", fmt.Errorf("format must be one of: csv, json, parquet, sql")
	}
}

func (format ExportFormat) Extension() string {
	return string(format)
}

func (format ExportFormat) ContentType() string {
	switch format {
	case ExportFormatCSV:
		return "text/csv; charset=utf-8"
	case ExportFormatJSON:
		return "application/json; charset=utf-8"
	case ExportFormatParquet:
		return "application/vnd.apache.parquet"
	case ExportFormatSQL:
		return "application/sql; charset=utf-8"
	default:
		return "application/octet-stream"
	}
}

func PreviewExportQuery(ctx context.Context, target model.DatabaseTarget, statement string) (ExportPreview, error) {
	previewContext, cancel := context.WithTimeout(ctx, config.QueryTimeoutDuration)
	defer cancel()

	pool, err := TargetPool(previewContext, target)
	if err != nil {
		return ExportPreview{}, err
	}
	defer pool.Release()

	transaction, err := pool.BeginTx(previewContext, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ExportPreview{}, err
	}
	defer transaction.Rollback(context.Background())

	rows, err := transaction.Query(previewContext, statement)
	if err != nil {
		return ExportPreview{}, err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	if len(fields) == 0 {
		return ExportPreview{}, fmt.Errorf("export query must return columns")
	}
	rawColumnNames := make([]string, len(fields))
	for index, field := range fields {
		rawColumnNames[index] = field.Name
	}
	columnNames := uniqueExportColumnNames(rawColumnNames)
	columns := make([]model.QueryColumn, len(fields))
	for index, field := range fields {
		columns[index] = model.QueryColumn{Name: columnNames[index], DataTypeOID: field.DataTypeOID}
	}

	previewRows := make([][]interface{}, 0, exportPreviewMaxRows)
	previewBytes := 0
	truncated := false
	for rows.Next() {
		if len(previewRows) >= exportPreviewMaxRows {
			truncated = true
			break
		}
		values, valuesErr := rows.Values()
		if valuesErr != nil {
			return ExportPreview{}, valuesErr
		}
		normalizedValues := normalizeExportValues(values)
		rowBytes := estimateRowBytes(normalizedValues)
		if previewBytes+rowBytes > exportPreviewMaxBytes {
			truncated = true
			break
		}
		previewBytes += rowBytes
		previewRows = append(previewRows, normalizedValues)
	}
	if err := rows.Err(); err != nil {
		return ExportPreview{}, err
	}
	rows.Close()
	if err := transaction.Commit(previewContext); err != nil {
		return ExportPreview{}, err
	}
	return ExportPreview{Columns: columns, Rows: previewRows, RowCount: len(previewRows), Truncated: truncated}, nil
}

func ExportQuery(ctx context.Context, target model.DatabaseTarget, statement string, actorEntityID string, options ExportOptions, destination io.Writer) (string, error) {
	if _, err := ParseExportFormat(string(options.Format)); err != nil {
		return "", err
	}
	if options.Format == ExportFormatSQL && strings.TrimSpace(options.SQLTableName) == "" {
		return "", fmt.Errorf("SQL table name is required")
	}
	transferID, err := startDataTransferRun(ctx, target, actorEntityID, "EXPORT", "", "", "", statement, string(options.Format))
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

	columnNames := make([]string, len(fields))
	for index, field := range fields {
		columnNames[index] = field.Name
	}
	columnNames = uniqueExportColumnNames(columnNames)
	encoder, err := newExportEncoder(options, columnNames, destination)
	if err != nil {
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
		if writeErr := encoder.WriteRow(normalizeExportValues(values)); writeErr != nil {
			err = writeErr
			break
		}
		rowCount += 1
	}
	if err == nil {
		err = rows.Err()
	}
	if err == nil {
		err = encoder.Close()
	} else {
		_ = encoder.Close()
	}
	if err == nil {
		err = transaction.Commit(exportContext)
	}
	finishDataTransferRun(transferID, rowCount, startedAt, err)
	return transferID, err
}

type exportEncoder interface {
	WriteRow([]interface{}) error
	Close() error
}

func newExportEncoder(options ExportOptions, columnNames []string, destination io.Writer) (exportEncoder, error) {
	switch options.Format {
	case ExportFormatCSV:
		writer := csv.NewWriter(destination)
		if err := writer.Write(columnNames); err != nil {
			return nil, err
		}
		return &csvExportEncoder{writer: writer}, nil
	case ExportFormatJSON:
		if _, err := io.WriteString(destination, "[\n"); err != nil {
			return nil, err
		}
		return &jsonExportEncoder{destination: destination, columnNames: columnNames}, nil
	case ExportFormatParquet:
		return newParquetExportEncoder(columnNames, destination)
	case ExportFormatSQL:
		return newSQLExportEncoder(options.SQLTableName, columnNames, destination)
	default:
		return nil, fmt.Errorf("unsupported export format %q", options.Format)
	}
}

type csvExportEncoder struct {
	writer   *csv.Writer
	rowCount int
}

func (encoder *csvExportEncoder) WriteRow(values []interface{}) error {
	record := make([]string, len(values))
	for index, value := range values {
		if value != nil {
			record[index] = fmt.Sprint(value)
		}
	}
	if err := encoder.writer.Write(record); err != nil {
		return err
	}
	encoder.rowCount += 1
	if encoder.rowCount%256 == 0 {
		encoder.writer.Flush()
		return encoder.writer.Error()
	}
	return nil
}

func (encoder *csvExportEncoder) Close() error {
	encoder.writer.Flush()
	return encoder.writer.Error()
}

type jsonExportEncoder struct {
	destination io.Writer
	columnNames []string
	wroteRow    bool
}

func (encoder *jsonExportEncoder) WriteRow(values []interface{}) error {
	record := make(map[string]interface{}, len(encoder.columnNames))
	for index, columnName := range encoder.columnNames {
		record[columnName] = values[index]
	}
	contents, err := json.Marshal(record)
	if err != nil {
		return err
	}
	prefix := "  "
	if encoder.wroteRow {
		prefix = ",\n  "
	}
	if _, err := io.WriteString(encoder.destination, prefix); err != nil {
		return err
	}
	if _, err := encoder.destination.Write(contents); err != nil {
		return err
	}
	encoder.wroteRow = true
	return nil
}

func (encoder *jsonExportEncoder) Close() error {
	_, err := io.WriteString(encoder.destination, "\n]\n")
	return err
}

type parquetExportEncoder struct {
	writer        *parquet.Writer
	columnIndexes []int
	rows          []parquet.Row
}

func newParquetExportEncoder(columnNames []string, destination io.Writer) (exportEncoder, error) {
	group := make(parquet.Group, len(columnNames))
	inputIndexes := make(map[string]int, len(columnNames))
	for index, columnName := range columnNames {
		group[columnName] = parquet.Optional(parquet.String())
		inputIndexes[columnName] = index
	}
	schema := parquet.NewSchema("workbench_export", group)
	columnIndexes := make([]int, len(columnNames))
	for index, path := range schema.Columns() {
		columnIndexes[index] = inputIndexes[path[len(path)-1]]
	}
	return &parquetExportEncoder{
		writer:        parquet.NewWriter(destination, schema),
		columnIndexes: columnIndexes,
		rows:          make([]parquet.Row, 0, 256),
	}, nil
}

func (encoder *parquetExportEncoder) WriteRow(values []interface{}) error {
	row := make(parquet.Row, len(encoder.columnIndexes))
	for columnIndex, inputIndex := range encoder.columnIndexes {
		if values[inputIndex] == nil {
			row[columnIndex] = parquet.NullValue().Level(0, 0, columnIndex)
		} else {
			row[columnIndex] = parquet.ValueOf(fmt.Sprint(values[inputIndex])).Level(0, 1, columnIndex)
		}
	}
	encoder.rows = append(encoder.rows, row)
	if len(encoder.rows) < cap(encoder.rows) {
		return nil
	}
	return encoder.flush()
}

func (encoder *parquetExportEncoder) Close() error {
	if err := encoder.flush(); err != nil {
		return err
	}
	return encoder.writer.Close()
}

func (encoder *parquetExportEncoder) flush() error {
	if len(encoder.rows) == 0 {
		return nil
	}
	written, err := encoder.writer.WriteRows(encoder.rows)
	if err == nil && written != len(encoder.rows) {
		err = io.ErrShortWrite
	}
	encoder.rows = encoder.rows[:0]
	return err
}

type sqlExportEncoder struct {
	destination io.Writer
	tableName   string
	columns     string
}

func newSQLExportEncoder(tableName string, columnNames []string, destination io.Writer) (exportEncoder, error) {
	quotedColumns := make([]string, len(columnNames))
	definitions := make([]string, len(columnNames))
	for index, columnName := range columnNames {
		quotedColumns[index] = pgx.Identifier{columnName}.Sanitize()
		definitions[index] = quotedColumns[index] + " text"
	}
	quotedTable := pgx.Identifier{tableName}.Sanitize()
	if _, err := fmt.Fprintf(destination, "CREATE TABLE %s (\n  %s\n);\n\n", quotedTable, strings.Join(definitions, ",\n  ")); err != nil {
		return nil, err
	}
	return &sqlExportEncoder{destination: destination, tableName: quotedTable, columns: strings.Join(quotedColumns, ", ")}, nil
}

func (encoder *sqlExportEncoder) WriteRow(values []interface{}) error {
	literals := make([]string, len(values))
	for index, value := range values {
		if value == nil {
			literals[index] = "NULL"
		} else {
			literals[index] = "'" + strings.ReplaceAll(fmt.Sprint(value), "'", "''") + "'"
		}
	}
	_, err := fmt.Fprintf(encoder.destination, "INSERT INTO %s (%s) VALUES (%s);\n", encoder.tableName, encoder.columns, strings.Join(literals, ", "))
	return err
}

func (encoder *sqlExportEncoder) Close() error {
	return nil
}

func uniqueExportColumnNames(columnNames []string) []string {
	uniqueNames := make([]string, len(columnNames))
	used := make(map[string]struct{}, len(columnNames))
	for index, columnName := range columnNames {
		base := strings.TrimSpace(columnName)
		if base == "" {
			base = fmt.Sprintf("column_%d", index+1)
		}
		candidate := base
		for suffix := 2; ; suffix += 1 {
			if _, exists := used[candidate]; !exists {
				break
			}
			candidate = fmt.Sprintf("%s_%d", base, suffix)
		}
		used[candidate] = struct{}{}
		uniqueNames[index] = candidate
	}
	return uniqueNames
}

func normalizeExportValues(values []interface{}) []interface{} {
	normalized := make([]interface{}, len(values))
	for index, value := range values {
		switch typed := value.(type) {
		case nil:
			normalized[index] = nil
		case []byte:
			normalized[index] = "\\x" + hex.EncodeToString(typed)
		case time.Time:
			normalized[index] = typed.Format(time.RFC3339Nano)
		case string, bool, int8, int16, int32, int64, int, uint8, uint16, uint32, uint64, uint, float32, float64:
			normalized[index] = typed
		default:
			normalized[index] = fmt.Sprint(typed)
		}
	}
	return normalized
}

func ImportCSV(ctx context.Context, target model.DatabaseTarget, schemaName string, tableName string, fileName string, source io.ReadSeeker, actorEntityID string) (ImportResult, error) {
	transferID, err := startDataTransferRun(ctx, target, actorEntityID, "IMPORT", schemaName, tableName, fileName, "", "csv")
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

func startDataTransferRun(ctx context.Context, target model.DatabaseTarget, actorEntityID string, direction string, schemaName string, tableName string, fileName string, statement string, format string) (string, error) {
	id := ulid.Make().Prefixed("xfer")
	_, err := database.Pool.Exec(ctx, `
		INSERT INTO data_transfer_run (
			id, target_id, database_name, actor_entity_id, direction, schema_name,
			table_name, file_name, statement, format, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, 'RUNNING')`,
		id, target.ID, target.DatabaseName, actorEntityID, direction, schemaName, tableName, fileName, statement, format,
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

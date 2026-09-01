package service

import (
	"archive/zip"
	"bytes"
	"context"
	"encoding/csv"
	"encoding/hex"
	"encoding/json"
	"errors"
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
	"github.com/jackc/pgx/v5/pgconn"
	"github.com/parquet-go/parquet-go"
)

const (
	importTimeout          = 5 * time.Minute
	importPreviewMaxRows   = 20
	importErrorSampleLimit = 100
	importBatchSize        = 512
	exportPreviewMaxRows   = 20
	exportPreviewMaxBytes  = 512 << 10
)

type ImportResult struct {
	TransferID string           `json:"transfer_id"`
	RowCount   int64            `json:"row_count"`
	ErrorCount int64            `json:"error_count"`
	Errors     []ImportRowError `json:"errors"`
}

type ImportRowError struct {
	Row     int64  `json:"row"`
	Message string `json:"message"`
}

type ImportPreview struct {
	Columns   []string   `json:"columns"`
	Rows      [][]string `json:"rows"`
	RowCount  int64      `json:"row_count"`
	Truncated bool       `json:"truncated"`
}

type ImportErrorPolicy string

const (
	ImportErrorPolicyAbort    ImportErrorPolicy = "abort"
	ImportErrorPolicyContinue ImportErrorPolicy = "continue"
)

type ImportOptions struct {
	ErrorPolicy ImportErrorPolicy
}

func ParseImportErrorPolicy(value string) (ImportErrorPolicy, error) {
	policy := ImportErrorPolicy(strings.ToLower(strings.TrimSpace(value)))
	switch policy {
	case ImportErrorPolicyAbort, ImportErrorPolicyContinue:
		return policy, nil
	default:
		return "", fmt.Errorf("error policy must be one of: abort, continue")
	}
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
	Format        ExportFormat
	SQLSchemaName string
	SQLTableName  string
	SQLIncludeDDL bool
	SchemaName    string
	TableName     string
	FileName      string
}

type ExportTable struct {
	Schema string
	Name   string
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
	transferID, err := startDataTransferRun(
		ctx,
		target,
		actorEntityID,
		"EXPORT",
		options.SchemaName,
		options.TableName,
		options.FileName,
		statement,
		string(options.Format),
	)
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

func ExportTablesArchive(
	ctx context.Context,
	target model.DatabaseTarget,
	tables []ExportTable,
	actorEntityID string,
	format ExportFormat,
	timestamp time.Time,
	destination io.Writer,
) error {
	if _, err := ParseExportFormat(string(format)); err != nil {
		return err
	}
	if len(tables) == 0 {
		return fmt.Errorf("at least one table is required")
	}
	schemaDDL, err := GetTablesDDL(ctx, target, tables)
	if err != nil {
		return fmt.Errorf("build schema export: %w", err)
	}

	archive := zip.NewWriter(destination)
	schemaEntry, err := archive.CreateHeader(&zip.FileHeader{
		Name:     "schema.sql",
		Method:   zip.Deflate,
		Modified: timestamp,
	})
	if err != nil {
		_ = archive.Close()
		return fmt.Errorf("create schema archive entry: %w", err)
	}
	if _, err := io.WriteString(schemaEntry, schemaDDL); err != nil {
		_ = archive.Close()
		return fmt.Errorf("write schema archive entry: %w", err)
	}
	timestampValue := timestamp.Format("20060102-150405")
	for _, table := range tables {
		sourceName := table.Schema + "-" + table.Name
		fileName := fmt.Sprintf(
			"%s-%s-%s-%s.%s",
			safeTransferFilePart(target.Name),
			safeTransferFilePart(target.DatabaseName),
			safeTransferFilePart(sourceName),
			timestampValue,
			format.Extension(),
		)
		entry, err := archive.CreateHeader(&zip.FileHeader{
			Name:     fileName,
			Method:   zip.Deflate,
			Modified: timestamp,
		})
		if err != nil {
			_ = archive.Close()
			return fmt.Errorf("create archive entry for %s.%s: %w", table.Schema, table.Name, err)
		}
		statement := fmt.Sprintf("SELECT * FROM %s", pgx.Identifier{table.Schema, table.Name}.Sanitize())
		_, err = ExportQuery(
			ctx,
			target,
			statement,
			actorEntityID,
			ExportOptions{
				Format:        format,
				SQLSchemaName: table.Schema,
				SQLTableName:  table.Name,
				SQLIncludeDDL: false,
				SchemaName:    table.Schema,
				TableName:     table.Name,
				FileName:      fileName,
			},
			entry,
		)
		if err != nil {
			_ = archive.Close()
			return fmt.Errorf("export %s.%s: %w", table.Schema, table.Name, err)
		}
	}
	if err := archive.Close(); err != nil {
		return fmt.Errorf("finish export archive: %w", err)
	}
	return nil
}

func safeTransferFilePart(value string) string {
	value = strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' {
			return character
		}
		return '-'
	}, value)
	value = strings.Trim(value, "-")
	if value == "" {
		return "table"
	}
	return value
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
		return newSQLExportEncoder(options.SQLSchemaName, options.SQLTableName, columnNames, options.SQLIncludeDDL, destination)
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

func newSQLExportEncoder(schemaName string, tableName string, columnNames []string, includeDDL bool, destination io.Writer) (exportEncoder, error) {
	quotedColumns := make([]string, len(columnNames))
	definitions := make([]string, len(columnNames))
	for index, columnName := range columnNames {
		quotedColumns[index] = pgx.Identifier{columnName}.Sanitize()
		definitions[index] = quotedColumns[index] + " text"
	}
	tableIdentifier := pgx.Identifier{tableName}
	if strings.TrimSpace(schemaName) != "" {
		tableIdentifier = pgx.Identifier{schemaName, tableName}
	}
	quotedTable := tableIdentifier.Sanitize()
	if includeDDL {
		if _, err := fmt.Fprintf(destination, "CREATE TABLE %s (\n  %s\n);\n\n", quotedTable, strings.Join(definitions, ",\n  ")); err != nil {
			return nil, err
		}
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

func PreviewCSVImport(ctx context.Context, target model.DatabaseTarget, schemaName string, tableName string, source io.Reader) (ImportPreview, error) {
	header, rows, rowCount, err := inspectCSV(source, importPreviewMaxRows)
	if err != nil {
		return ImportPreview{}, err
	}
	previewContext, cancel := context.WithTimeout(ctx, config.QueryTimeoutDuration)
	defer cancel()

	pool, err := TargetPool(previewContext, target)
	if err != nil {
		return ImportPreview{}, err
	}
	defer pool.Release()
	transaction, err := pool.BeginTx(previewContext, pgx.TxOptions{AccessMode: pgx.ReadOnly})
	if err != nil {
		return ImportPreview{}, err
	}
	defer transaction.Rollback(context.Background())
	availableColumns, err := tableColumns(previewContext, transaction, schemaName, tableName)
	if err != nil {
		return ImportPreview{}, err
	}
	if err := validateImportHeader(header, availableColumns, schemaName, tableName); err != nil {
		return ImportPreview{}, err
	}
	return ImportPreview{Columns: header, Rows: rows, RowCount: rowCount, Truncated: rowCount > int64(len(rows))}, nil
}

func ImportCSV(ctx context.Context, target model.DatabaseTarget, schemaName string, tableName string, fileName string, source io.ReadSeeker, actorEntityID string, options ImportOptions) (ImportResult, error) {
	if _, err := ParseImportErrorPolicy(string(options.ErrorPolicy)); err != nil {
		return ImportResult{}, err
	}
	transferID, err := startDataTransferRunWithPolicy(ctx, target, actorEntityID, "IMPORT", schemaName, tableName, fileName, "", "csv", string(options.ErrorPolicy))
	if err != nil {
		return ImportResult{}, err
	}
	startedAt := time.Now()
	result := ImportResult{TransferID: transferID, Errors: []ImportRowError{}}
	importContext, cancel := context.WithTimeout(ctx, importTimeout)
	defer cancel()

	var contents []byte
	var records []csvImportRecord
	var header []string
	if options.ErrorPolicy == ImportErrorPolicyContinue {
		contents, err = io.ReadAll(source)
		if err == nil {
			header, records, err = parseCSVRecords(contents)
		}
	} else {
		header, err = readCSVHeader(source)
	}
	if err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}

	pool, err := TargetPool(importContext, target)
	if err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}
	defer pool.Release()

	transaction, err := pool.Begin(importContext)
	if err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}
	defer transaction.Rollback(context.Background())
	if _, err = transaction.Exec(importContext, "SET LOCAL statement_timeout = '5min'"); err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}

	availableColumns, err := tableColumns(importContext, transaction, schemaName, tableName)
	if err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}
	if err = validateImportHeader(header, availableColumns, schemaName, tableName); err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}
	if options.ErrorPolicy == ImportErrorPolicyAbort {
		if _, err = source.Seek(0, io.SeekStart); err != nil {
			finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
			return result, err
		}
	} else if _, err = transaction.Exec(importContext, "SET CONSTRAINTS ALL IMMEDIATE"); err != nil {
		finishDataTransferRunWithErrors(transferID, 0, 0, startedAt, err)
		return result, err
	}

	quotedColumns := make([]string, len(header))
	for index, column := range header {
		quotedColumns[index] = pgx.Identifier{column}.Sanitize()
	}
	copyOptions := "FORMAT csv, ENCODING 'UTF8'"
	if options.ErrorPolicy == ImportErrorPolicyAbort {
		copyOptions += ", HEADER true"
	}
	copyStatement := fmt.Sprintf(
		"COPY %s (%s) FROM STDIN WITH (%s)",
		pgx.Identifier{schemaName, tableName}.Sanitize(),
		strings.Join(quotedColumns, ", "),
		copyOptions,
	)
	if options.ErrorPolicy == ImportErrorPolicyAbort {
		var commandTag pgconn.CommandTag
		commandTag, err = transaction.Conn().PgConn().CopyFrom(importContext, source, copyStatement)
		if err == nil {
			result.RowCount = commandTag.RowsAffected()
		}
	} else {
		err = importCSVRecords(importContext, transaction, copyStatement, contents, records, &result)
	}
	if err == nil {
		err = transaction.Commit(importContext)
	}
	if err != nil {
		result.RowCount = 0
	}
	finishDataTransferRunWithErrors(transferID, result.RowCount, result.ErrorCount, startedAt, err)
	return result, err
}

type csvImportRecord struct {
	rowNumber int64
	start     int
	end       int
}

func inspectCSV(source io.Reader, previewLimit int) ([]string, [][]string, int64, error) {
	reader := csv.NewReader(source)
	header, err := reader.Read()
	if err != nil {
		return nil, nil, 0, fmt.Errorf("read CSV header: %w", err)
	}
	header = normalizeCSVHeader(header)
	rows := make([][]string, 0, previewLimit)
	var rowCount int64
	for {
		record, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, nil, 0, fmt.Errorf("read CSV row %d: %w", rowCount+2, readErr)
		}
		rowCount++
		if len(rows) < previewLimit {
			rows = append(rows, record)
		}
	}
	return header, rows, rowCount, nil
}

func readCSVHeader(source io.Reader) ([]string, error) {
	header, err := csv.NewReader(source).Read()
	if err != nil {
		return nil, fmt.Errorf("read CSV header: %w", err)
	}
	return normalizeCSVHeader(header), nil
}

func parseCSVRecords(contents []byte) ([]string, []csvImportRecord, error) {
	reader := csv.NewReader(bytes.NewReader(contents))
	header, err := reader.Read()
	if err != nil {
		return nil, nil, fmt.Errorf("read CSV header: %w", err)
	}
	header = normalizeCSVHeader(header)
	records := []csvImportRecord{}
	for rowNumber := int64(2); ; rowNumber++ {
		start := int(reader.InputOffset())
		_, readErr := reader.Read()
		if errors.Is(readErr, io.EOF) {
			break
		}
		if readErr != nil {
			return nil, nil, fmt.Errorf("read CSV row %d: %w", rowNumber, readErr)
		}
		records = append(records, csvImportRecord{rowNumber: rowNumber, start: start, end: int(reader.InputOffset())})
	}
	return header, records, nil
}

func normalizeCSVHeader(header []string) []string {
	if len(header) > 0 {
		header[0] = strings.TrimPrefix(header[0], "\ufeff")
	}
	return header
}

func validateImportHeader(header []string, availableColumns map[string]struct{}, schemaName string, tableName string) error {
	if len(header) == 0 {
		return fmt.Errorf("CSV header must contain at least one column")
	}
	seenColumns := make(map[string]struct{}, len(header))
	for _, column := range header {
		if column == "" {
			return fmt.Errorf("CSV header contains a blank column")
		}
		if _, duplicate := seenColumns[column]; duplicate {
			return fmt.Errorf("CSV header contains duplicate column %q", column)
		}
		if _, exists := availableColumns[column]; !exists {
			return fmt.Errorf("column %q does not exist on %s.%s", column, schemaName, tableName)
		}
		seenColumns[column] = struct{}{}
	}
	return nil
}

func importCSVRecords(ctx context.Context, transaction pgx.Tx, copyStatement string, contents []byte, records []csvImportRecord, result *ImportResult) error {
	for start := 0; start < len(records); start += importBatchSize {
		end := min(start+importBatchSize, len(records))
		if err := importCSVBatch(ctx, transaction, copyStatement, contents, records[start:end], result); err != nil {
			return err
		}
	}
	return nil
}

func importCSVBatch(ctx context.Context, transaction pgx.Tx, copyStatement string, contents []byte, records []csvImportRecord, result *ImportResult) error {
	if len(records) == 0 {
		return nil
	}
	savepoint, err := transaction.Begin(ctx)
	if err != nil {
		return err
	}
	input := bytes.NewReader(contents[records[0].start:records[len(records)-1].end])
	commandTag, copyErr := savepoint.Conn().PgConn().CopyFrom(ctx, input, copyStatement)
	if copyErr == nil {
		if err := savepoint.Commit(ctx); err != nil {
			return err
		}
		result.RowCount += commandTag.RowsAffected()
		return nil
	}
	if rollbackErr := savepoint.Rollback(ctx); rollbackErr != nil {
		return fmt.Errorf("rollback failed CSV batch: %w", rollbackErr)
	}
	if ctx.Err() != nil || !isRecoverableImportError(copyErr) {
		return copyErr
	}
	if len(records) == 1 {
		result.ErrorCount++
		if len(result.Errors) < importErrorSampleLimit {
			result.Errors = append(result.Errors, ImportRowError{Row: records[0].rowNumber, Message: importRowErrorMessage(copyErr)})
		}
		return nil
	}
	middle := len(records) / 2
	if err := importCSVBatch(ctx, transaction, copyStatement, contents, records[:middle], result); err != nil {
		return err
	}
	return importCSVBatch(ctx, transaction, copyStatement, contents, records[middle:], result)
}

func isRecoverableImportError(err error) bool {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return false
	}
	return strings.HasPrefix(postgresError.Code, "22") || strings.HasPrefix(postgresError.Code, "23") || postgresError.Code == "P0001"
}

func importRowErrorMessage(err error) string {
	var postgresError *pgconn.PgError
	if !errors.As(err, &postgresError) {
		return err.Error()
	}
	if postgresError.Detail != "" {
		return postgresError.Message + ": " + postgresError.Detail
	}
	return postgresError.Message
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
	return startDataTransferRunWithPolicy(ctx, target, actorEntityID, direction, schemaName, tableName, fileName, statement, format, "abort")
}

func startDataTransferRunWithPolicy(ctx context.Context, target model.DatabaseTarget, actorEntityID string, direction string, schemaName string, tableName string, fileName string, statement string, format string, errorPolicy string) (string, error) {
	id := ulid.Make().Prefixed("xfer")
	_, err := database.Pool.Exec(ctx, `
		INSERT INTO data_transfer_run (
			id, target_id, database_name, actor_entity_id, direction, schema_name,
			table_name, file_name, statement, format, error_policy, status
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, 'RUNNING')`,
		id, target.ID, target.DatabaseName, actorEntityID, direction, schemaName, tableName, fileName, statement, format, errorPolicy,
	)
	return id, err
}

func finishDataTransferRun(id string, rowCount int64, startedAt time.Time, transferError error) {
	finishDataTransferRunWithErrors(id, rowCount, 0, startedAt, transferError)
}

func finishDataTransferRunWithErrors(id string, rowCount int64, errorCount int64, startedAt time.Time, transferError error) {
	status := "SUCCEEDED"
	errorMessage := ""
	if transferError != nil {
		status = "FAILED"
		errorMessage = transferError.Error()
	} else if errorCount > 0 {
		status = "SUCCEEDED_WITH_ERRORS"
	}
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	completedAt := time.Now()
	if _, err := database.Pool.Exec(ctx, `
		UPDATE data_transfer_run
		SET status = $2, row_count = $3, error_count = $4, duration_ms = $5, error_message = $6, completed_at = $7
		WHERE id = $1`, id, status, rowCount, errorCount, completedAt.Sub(startedAt).Milliseconds(), errorMessage, completedAt); err != nil {
		logger.SugarLogger.Errorf("Failed to finalize data transfer %s: %v", id, err)
	}
}

package service

import (
	"context"
	"crypto/tls"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"reflect"
	"strconv"
	"strings"
	"time"
	"unicode"

	"github.com/ClickHouse/clickhouse-go/v2"
	"github.com/ClickHouse/clickhouse-go/v2/lib/driver"
	"github.com/gaucho-racing/workbench/workbench/model"
)

const (
	clickhouseReadOnlyErrorCode        = 164
	clickhouseUnknownTableErrorCode    = 60
	clickhouseUnknownDatabaseErrorCode = 81
	clickhouseNoCreateQueryErrorCode   = 390
)

var clickhouseRowStatements = map[string]struct{}{
	"SELECT": {}, "WITH": {}, "SHOW": {}, "DESCRIBE": {}, "DESC": {}, "EXPLAIN": {}, "EXISTS": {}, "CHECK": {},
}

type clickhouseConnection struct {
	conn           driver.Conn
	serverReadOnly bool
}

func newClickHouseConnection(ctx context.Context, target model.DatabaseTarget) (*clickhouseConnection, error) {
	password, err := decryptSecret(target.EncryptedPassword)
	if err != nil {
		return nil, err
	}
	options := &clickhouse.Options{
		Addr: []string{net.JoinHostPort(target.Host, strconv.Itoa(target.Port))},
		Auth: clickhouse.Auth{
			Database: target.DatabaseName,
			Username: target.Username,
			Password: password,
		},
		DialTimeout:     10 * time.Second,
		MaxOpenConns:    4,
		MaxIdleConns:    2,
		ConnMaxLifetime: 5 * time.Minute,
		ClientInfo: clickhouse.ClientInfo{Products: []struct {
			Name    string
			Version string
		}{{Name: "workbench", Version: target.ID}}},
	}
	switch target.SSLMode {
	case "require":
		options.TLS = &tls.Config{ServerName: target.Host, InsecureSkipVerify: true}
	case "verify-ca", "verify-full":
		options.TLS = &tls.Config{ServerName: target.Host}
	}
	conn, err := clickhouse.Open(options)
	if err != nil {
		return nil, fmt.Errorf("open ClickHouse connection: %w", err)
	}
	timeoutContext, cancelTimeout := context.WithTimeout(ctx, 10*time.Second)
	defer cancelTimeout()
	pingContext, cancel := clickhouseCallContext(timeoutContext, nil, false, 0)
	defer cancel()
	if err := conn.Ping(pingContext); err != nil {
		_ = conn.Close()
		return nil, err
	}
	var readOnly string
	if err := conn.QueryRow(pingContext, "SELECT value FROM system.settings WHERE name = 'readonly'").Scan(&readOnly); err != nil {
		_ = conn.Close()
		return nil, fmt.Errorf("read ClickHouse session settings: %w", err)
	}
	return &clickhouseConnection{conn: conn, serverReadOnly: readOnly != "0"}, nil
}

// clickhouse-go turns any context deadline into a max_execution_time setting, which servers reject for
// readonly users. Calls therefore run on a deadline-free context that is still canceled with the request,
// and the server-side limit is only sent when the session may change settings.
func clickhouseCallContext(ctx context.Context, connection *clickhouseConnection, readOnly bool, maxRows int) (context.Context, context.CancelFunc) {
	callContext, cancel := context.WithCancel(context.WithoutCancel(ctx))
	stop := context.AfterFunc(ctx, cancel)
	release := func() {
		stop()
		cancel()
	}
	if connection == nil || connection.serverReadOnly {
		return callContext, release
	}
	settings := clickhouse.Settings{}
	if deadline, ok := ctx.Deadline(); ok {
		if seconds := time.Until(deadline).Seconds(); seconds >= 1 {
			settings["max_execution_time"] = int(seconds)
		}
	}
	if readOnly {
		settings["readonly"] = 2
		settings["allow_ddl"] = 0
	}
	if maxRows > 0 {
		settings["max_result_rows"] = maxRows
		settings["result_overflow_mode"] = "break"
	}
	if len(settings) == 0 {
		return callContext, release
	}
	return clickhouse.Context(callContext, clickhouse.WithSettings(settings)), release
}

func clickhouseConn(ctx context.Context, target model.DatabaseTarget) (*targetPoolLease, error) {
	lease, err := TargetPool(ctx, target)
	if err != nil {
		return nil, err
	}
	if lease.clickhouse == nil {
		lease.Release()
		return nil, fmt.Errorf("target %s is not a ClickHouse connection", target.ID)
	}
	return lease, nil
}

func clickhouseErrorCode(err error) int32 {
	var exception *clickhouse.Exception
	if errors.As(err, &exception) {
		return exception.Code
	}
	return 0
}

func quoteClickHouseIdentifier(value string) string {
	return "`" + strings.NewReplacer(`\`, `\\`, "`", "\\`").Replace(value) + "`"
}

func leadingKeyword(statement string) string {
	remaining := statement
	for {
		remaining = strings.TrimLeftFunc(remaining, func(r rune) bool { return unicode.IsSpace(r) || r == '(' })
		switch {
		case strings.HasPrefix(remaining, "--"):
			end := strings.IndexByte(remaining, '\n')
			if end < 0 {
				return ""
			}
			remaining = remaining[end+1:]
		case strings.HasPrefix(remaining, "/*"):
			end := strings.Index(remaining, "*/")
			if end < 0 {
				return ""
			}
			remaining = remaining[end+2:]
		default:
			end := strings.IndexFunc(remaining, func(r rune) bool { return !unicode.IsLetter(r) })
			if end < 0 {
				end = len(remaining)
			}
			return strings.ToUpper(remaining[:end])
		}
	}
}

func listClickHouseDatabases(ctx context.Context, target model.DatabaseTarget) ([]ServerDatabase, error) {
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return nil, err
	}
	defer lease.Release()
	callContext, cancel := clickhouseCallContext(ctx, lease.clickhouse, false, 0)
	defer cancel()
	rows, err := lease.clickhouse.conn.Query(callContext, `
		SELECT name FROM system.databases
		WHERE lower(name) NOT IN ('system', 'information_schema')
		ORDER BY lower(name), name`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	databases := []ServerDatabase{}
	for rows.Next() {
		var database ServerDatabase
		if err := rows.Scan(&database.Name); err != nil {
			return nil, err
		}
		databases = append(databases, database)
	}
	return databases, rows.Err()
}

func getClickHouseCatalog(ctx context.Context, target model.DatabaseTarget) (Catalog, error) {
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return Catalog{}, err
	}
	defer lease.Release()
	callContext, cancel := clickhouseCallContext(ctx, lease.clickhouse, false, 0)
	defer cancel()
	rows, err := lease.clickhouse.conn.Query(callContext, `
		SELECT t.database,
		       t.name,
		       multiIf(t.engine = 'View', 'view', t.engine = 'MaterializedView', 'materialized_view',
		               t.engine = 'Dictionary', 'dictionary', 'table'),
		       c.name,
		       c.type,
		       startsWith(c.type, 'Nullable('),
		       c.is_in_primary_key = 1
		FROM system.tables t
		INNER JOIN system.columns c ON c.database = t.database AND c.table = t.name
		WHERE t.database = currentDatabase() AND NOT t.is_temporary
		ORDER BY t.name, c.position`)
	if err != nil {
		return Catalog{}, err
	}
	defer rows.Close()
	tables := []CatalogTable{}
	indexes := make(map[string]int)
	for rows.Next() {
		var schema, tableName, kind string
		var column CatalogColumn
		if err := rows.Scan(&schema, &tableName, &kind, &column.Name, &column.DataType, &column.Nullable, &column.PrimaryKey); err != nil {
			return Catalog{}, err
		}
		key := schema + "\x00" + tableName
		index, ok := indexes[key]
		if !ok {
			index = len(tables)
			indexes[key] = index
			tables = append(tables, CatalogTable{Schema: schema, Name: tableName, Kind: kind, Columns: []CatalogColumn{}})
		}
		tables[index].Columns = append(tables[index].Columns, column)
	}
	if err := rows.Err(); err != nil {
		return Catalog{}, err
	}
	return Catalog{Tables: tables, ForeignKeys: []CatalogForeignKey{}}, nil
}

func clickhouseCreateStatement(ctx context.Context, connection *clickhouseConnection, schema string, relation string) (string, error) {
	var statement string
	callContext, cancel := clickhouseCallContext(ctx, connection, false, 0)
	defer cancel()
	err := connection.conn.QueryRow(callContext, "SHOW CREATE TABLE "+quoteClickHouseIdentifier(schema)+"."+quoteClickHouseIdentifier(relation)).Scan(&statement)
	switch clickhouseErrorCode(err) {
	case clickhouseUnknownTableErrorCode, clickhouseUnknownDatabaseErrorCode, clickhouseNoCreateQueryErrorCode:
		return "", ErrRelationNotFound
	}
	if err != nil {
		return "", err
	}
	return strings.TrimSuffix(strings.TrimSpace(statement), ";") + ";", nil
}

func getClickHouseRelationDDL(ctx context.Context, target model.DatabaseTarget, schema string, relation string) (string, error) {
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return "", err
	}
	defer lease.Release()
	return clickhouseCreateStatement(ctx, lease.clickhouse, schema, relation)
}

func getClickHouseTablesDDL(ctx context.Context, target model.DatabaseTarget, tables []ExportTable) (string, error) {
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return "", err
	}
	defer lease.Release()
	statements := make([]string, 0, len(tables)+1)
	seenDatabases := make(map[string]struct{})
	for _, table := range tables {
		if _, seen := seenDatabases[table.Schema]; !seen {
			seenDatabases[table.Schema] = struct{}{}
			statements = append(statements, "CREATE DATABASE IF NOT EXISTS "+quoteClickHouseIdentifier(table.Schema)+";")
		}
		statement, err := clickhouseCreateStatement(ctx, lease.clickhouse, table.Schema, table.Name)
		if err != nil {
			return "", err
		}
		statements = append(statements, statement)
	}
	return strings.Join(statements, "\n\n") + "\n", nil
}

type clickhouseResult struct {
	rows    driver.Rows
	cancel  context.CancelFunc
	columns []model.QueryColumn
	targets []interface{}
}

func queryClickHouse(ctx context.Context, connection *clickhouseConnection, statement string, readOnly bool, maxRows int) (*clickhouseResult, error) {
	callContext, cancel := clickhouseCallContext(ctx, connection, readOnly, maxRows)
	rows, err := connection.conn.Query(callContext, statement)
	if err != nil {
		cancel()
		return nil, err
	}
	columnTypes := rows.ColumnTypes()
	result := &clickhouseResult{
		rows:    rows,
		cancel:  cancel,
		columns: make([]model.QueryColumn, len(columnTypes)),
		targets: make([]interface{}, len(columnTypes)),
	}
	for index, columnType := range columnTypes {
		result.columns[index] = model.QueryColumn{Name: columnType.Name(), DataType: columnType.DatabaseTypeName()}
		result.targets[index] = reflect.New(columnType.ScanType()).Interface()
	}
	return result, nil
}

func (result *clickhouseResult) next() ([]interface{}, bool, error) {
	if !result.rows.Next() {
		return nil, false, result.rows.Err()
	}
	if err := result.rows.Scan(result.targets...); err != nil {
		return nil, false, err
	}
	values := make([]interface{}, len(result.targets))
	for index, target := range result.targets {
		values[index] = dereferenceClickHouseValue(target)
	}
	return values, true, nil
}

func (result *clickhouseResult) close() error {
	defer result.cancel()
	return result.rows.Close()
}

func dereferenceClickHouseValue(pointer interface{}) interface{} {
	value := reflect.ValueOf(pointer).Elem()
	for value.Kind() == reflect.Pointer || value.Kind() == reflect.Interface {
		if value.IsNil() {
			return nil
		}
		value = value.Elem()
	}
	return value.Interface()
}

func formatClickHouseValue(value interface{}) interface{} {
	switch typed := value.(type) {
	case nil:
		return nil
	case time.Time:
		return typed.Format(time.RFC3339Nano)
	case string, bool:
		return typed
	case fmt.Stringer:
		return typed.String()
	case []byte:
		return "\\x" + hex.EncodeToString(typed)
	}
	reflected := reflect.ValueOf(value)
	addressable := reflect.New(reflected.Type())
	addressable.Elem().Set(reflected)
	if stringer, ok := addressable.Interface().(fmt.Stringer); ok {
		return stringer.String()
	}
	switch reflected.Kind() {
	case reflect.Slice, reflect.Array, reflect.Map, reflect.Struct:
		if encoded, err := json.Marshal(value); err == nil {
			return string(encoded)
		}
	}
	return fmt.Sprint(value)
}

func normalizeClickHouseExportValue(value interface{}) interface{} {
	switch value.(type) {
	case int8, int16, int32, int64, int, uint8, uint16, uint32, uint64, uint, float32, float64:
		return value
	}
	switch reflect.ValueOf(value).Kind() {
	case reflect.Slice, reflect.Array, reflect.Map:
		if _, isBytes := value.([]byte); !isBytes {
			if _, isStringer := value.(fmt.Stringer); !isStringer {
				return value
			}
		}
	}
	return formatClickHouseValue(value)
}

func executeClickHouseQuery(ctx context.Context, run model.QueryRun, target model.DatabaseTarget, statement string, readOnly bool, maxRows int, maxBytes int, startedAt time.Time) (model.QueryResult, error) {
	fail := func(rowCount int64, err error) (model.QueryResult, error) {
		finishQueryRun(context.Background(), run.ID, "FAILED", "", rowCount, time.Since(startedAt), err)
		return model.QueryResult{RunID: run.ID}, err
	}
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return fail(0, err)
	}
	defer lease.Release()

	commandTag := leadingKeyword(statement)
	if _, returnsRows := clickhouseRowStatements[commandTag]; !returnsRows {
		callContext, cancel := clickhouseCallContext(ctx, lease.clickhouse, readOnly, 0)
		err := lease.clickhouse.conn.Exec(callContext, statement)
		cancel()
		if err != nil {
			return fail(0, err)
		}
		duration := time.Since(startedAt)
		finishQueryRun(context.Background(), run.ID, "SUCCEEDED", commandTag, 0, duration, nil)
		return model.QueryResult{
			RunID:        run.ID,
			DatabaseName: target.DatabaseName,
			Columns:      []model.QueryColumn{},
			Rows:         [][]interface{}{},
			CommandTag:   commandTag,
			DurationMS:   duration.Milliseconds(),
		}, nil
	}

	result, err := queryClickHouse(ctx, lease.clickhouse, statement, readOnly, maxRows+1)
	if err != nil {
		return fail(0, err)
	}
	defer result.close()
	resultRows := make([][]interface{}, 0, min(maxRows, 256))
	truncated := false
	resultBytes := 0
	for {
		values, ok, err := result.next()
		if err != nil {
			return fail(int64(len(resultRows)), err)
		}
		if !ok {
			break
		}
		if len(resultRows) >= maxRows {
			truncated = true
			break
		}
		formatted := make([]interface{}, len(values))
		for index, value := range values {
			formatted[index] = formatClickHouseValue(value)
		}
		rowBytes := estimateRowBytes(formatted)
		if resultBytes+rowBytes > maxBytes {
			truncated = true
			break
		}
		resultBytes += rowBytes
		resultRows = append(resultRows, formatted)
	}
	duration := time.Since(startedAt)
	rowCount := int64(len(resultRows))
	finishQueryRun(context.Background(), run.ID, "SUCCEEDED", commandTag, rowCount, duration, nil)
	return model.QueryResult{
		RunID:        run.ID,
		DatabaseName: target.DatabaseName,
		Columns:      result.columns,
		Rows:         resultRows,
		CommandTag:   commandTag,
		RowCount:     rowCount,
		DurationMS:   duration.Milliseconds(),
		Truncated:    truncated,
	}, nil
}

var ErrImportUnsupported = errors.New("CSV import is not supported for ClickHouse connections")

func previewClickHouseExport(ctx context.Context, target model.DatabaseTarget, statement string) (ExportPreview, error) {
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return ExportPreview{}, err
	}
	defer lease.Release()
	result, err := queryClickHouse(ctx, lease.clickhouse, statement, true, exportPreviewMaxRows+1)
	if err != nil {
		return ExportPreview{}, err
	}
	defer result.close()
	if len(result.columns) == 0 {
		return ExportPreview{}, fmt.Errorf("export query must return columns")
	}
	columns := exportColumns(result.columns)
	previewRows := make([][]interface{}, 0, exportPreviewMaxRows)
	previewBytes := 0
	truncated := false
	for {
		values, ok, err := result.next()
		if err != nil {
			return ExportPreview{}, err
		}
		if !ok {
			break
		}
		if len(previewRows) >= exportPreviewMaxRows {
			truncated = true
			break
		}
		normalized := make([]interface{}, len(values))
		for index, value := range values {
			normalized[index] = normalizeClickHouseExportValue(value)
		}
		rowBytes := estimateRowBytes(normalized)
		if previewBytes+rowBytes > exportPreviewMaxBytes {
			truncated = true
			break
		}
		previewBytes += rowBytes
		previewRows = append(previewRows, normalized)
	}
	return ExportPreview{Columns: columns, Rows: previewRows, RowCount: len(previewRows), Truncated: truncated}, nil
}

func exportClickHouseQuery(ctx context.Context, target model.DatabaseTarget, statement string, options ExportOptions, destination io.Writer) (int64, error) {
	lease, err := clickhouseConn(ctx, target)
	if err != nil {
		return 0, err
	}
	defer lease.Release()
	result, err := queryClickHouse(ctx, lease.clickhouse, statement, true, 0)
	if err != nil {
		return 0, err
	}
	defer result.close()
	if len(result.columns) == 0 {
		return 0, fmt.Errorf("export query must return columns")
	}
	columns := exportColumns(result.columns)
	columnNames := make([]string, len(columns))
	for index, column := range columns {
		columnNames[index] = column.Name
	}
	encoder, err := newExportEncoder(options, columnNames, destination)
	if err != nil {
		return 0, err
	}
	var rowCount int64
	for {
		values, ok, nextErr := result.next()
		if nextErr != nil {
			err = nextErr
			break
		}
		if !ok {
			break
		}
		exportValues := make([]interface{}, len(values))
		for index, value := range values {
			if options.Format == ExportFormatJSON {
				exportValues[index] = normalizeClickHouseExportValue(value)
			} else {
				exportValues[index] = formatClickHouseValue(value)
			}
		}
		if err = encoder.WriteRow(exportValues); err != nil {
			break
		}
		rowCount += 1
	}
	if err != nil {
		_ = encoder.Close()
		return rowCount, err
	}
	return rowCount, encoder.Close()
}

func exportColumns(columns []model.QueryColumn) []model.QueryColumn {
	names := make([]string, len(columns))
	for index, column := range columns {
		names[index] = column.Name
	}
	unique := uniqueExportColumnNames(names)
	renamed := make([]model.QueryColumn, len(columns))
	for index, column := range columns {
		column.Name = unique[index]
		renamed[index] = column
	}
	return renamed
}

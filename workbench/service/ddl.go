package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/gaucho-racing/workbench/workbench/model"
	"github.com/jackc/pgx/v5"
)

var ErrRelationNotFound = errors.New("database object was not found")

type relationColumn struct {
	name         string
	dataType     string
	notNull      bool
	identity     string
	generated    string
	defaultValue *string
}

func GetRelationDDL(ctx context.Context, target model.DatabaseTarget, schema string, relation string) (string, error) {
	pool, err := TargetPool(ctx, target)
	if err != nil {
		return "", err
	}
	defer pool.Release()

	oid, relationKind, err := relationMetadata(ctx, pool, schema, relation)
	if err != nil {
		return "", err
	}

	qualifiedName := pgx.Identifier{schema, relation}.Sanitize()
	if relationKind == "v" || relationKind == "m" {
		return getViewDDL(ctx, pool, oid, qualifiedName, relationKind == "m")
	}
	return getTableDDL(ctx, pool, oid, qualifiedName, relationKind == "p")
}

func GetTablesDDL(ctx context.Context, target model.DatabaseTarget, tables []ExportTable) (string, error) {
	pool, err := TargetPool(ctx, target)
	if err != nil {
		return "", err
	}
	defer pool.Release()

	schemas := make([]string, 0)
	seenSchemas := make(map[string]struct{})
	createStatements := make([]string, 0, len(tables))
	postStatements := make([]string, 0)
	for _, table := range tables {
		if _, seen := seenSchemas[table.Schema]; !seen {
			seenSchemas[table.Schema] = struct{}{}
			schemas = append(schemas, table.Schema)
		}
		oid, relationKind, metadataErr := relationMetadata(ctx, pool, table.Schema, table.Name)
		if metadataErr != nil {
			return "", metadataErr
		}
		if relationKind != "r" && relationKind != "p" {
			return "", fmt.Errorf("%s.%s is not a table", table.Schema, table.Name)
		}
		qualifiedName := pgx.Identifier{table.Schema, table.Name}.Sanitize()
		createStatement, relationPostStatements, ddlErr := getTableDDLParts(ctx, pool, oid, qualifiedName, relationKind == "p")
		if ddlErr != nil {
			return "", ddlErr
		}
		createStatements = append(createStatements, createStatement)
		postStatements = append(postStatements, relationPostStatements...)
	}

	statements := make([]string, 0, len(schemas)+len(createStatements)+len(postStatements))
	for _, schema := range schemas {
		statements = append(statements, "CREATE SCHEMA IF NOT EXISTS "+pgx.Identifier{schema}.Sanitize()+";")
	}
	statements = append(statements, createStatements...)
	for _, statement := range postStatements {
		statements = append(statements, statement+";")
	}
	return strings.Join(statements, "\n\n") + "\n", nil
}

func relationMetadata(ctx context.Context, pool *targetPoolLease, schema string, relation string) (uint32, string, error) {
	var oid uint32
	var relationKind string
	err := pool.QueryRow(ctx, `
		SELECT c.oid, c.relkind::text
		FROM pg_catalog.pg_class c
		JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
		WHERE n.nspname = $1
		  AND c.relname = $2
		  AND c.relkind IN ('r', 'p', 'v', 'm')`, schema, relation).Scan(&oid, &relationKind)
	if errors.Is(err, pgx.ErrNoRows) {
		return 0, "", ErrRelationNotFound
	}
	if err != nil {
		return 0, "", err
	}
	return oid, relationKind, nil
}

func getViewDDL(ctx context.Context, pool *targetPoolLease, oid uint32, qualifiedName string, materialized bool) (string, error) {
	var definition string
	if err := pool.QueryRow(ctx, "SELECT pg_catalog.pg_get_viewdef($1::oid, true)", oid).Scan(&definition); err != nil {
		return "", err
	}
	viewType := "VIEW"
	if materialized {
		viewType = "MATERIALIZED VIEW"
	}
	statement := fmt.Sprintf("CREATE %s %s AS\n%s;", viewType, qualifiedName, strings.TrimSuffix(strings.TrimSpace(definition), ";"))
	if !materialized {
		return statement, nil
	}
	indexes, err := relationIndexes(ctx, pool, oid)
	if err != nil {
		return "", err
	}
	if len(indexes) > 0 {
		statement += "\n\n" + strings.Join(indexes, ";\n") + ";"
	}
	return statement, nil
}

func getTableDDL(ctx context.Context, pool *targetPoolLease, oid uint32, qualifiedName string, partitioned bool) (string, error) {
	statement, postStatements, err := getTableDDLParts(ctx, pool, oid, qualifiedName, partitioned)
	if err != nil {
		return "", err
	}
	if len(postStatements) > 0 {
		statement += "\n\n" + strings.Join(postStatements, ";\n") + ";"
	}
	return statement, nil
}

func getTableDDLParts(ctx context.Context, pool *targetPoolLease, oid uint32, qualifiedName string, partitioned bool) (string, []string, error) {
	columns, err := relationColumns(ctx, pool, oid)
	if err != nil {
		return "", nil, err
	}
	constraints, err := relationConstraints(ctx, pool, oid)
	if err != nil {
		return "", nil, err
	}

	definitions := make([]string, 0, len(columns)+len(constraints))
	postStatements := make([]string, 0)
	for _, column := range columns {
		definition := "  " + pgx.Identifier{column.name}.Sanitize() + " " + column.dataType
		switch column.identity {
		case "a":
			definition += " GENERATED ALWAYS AS IDENTITY"
		case "d":
			definition += " GENERATED BY DEFAULT AS IDENTITY"
		default:
			if column.generated != "" && column.defaultValue != nil {
				definition += " GENERATED ALWAYS AS (" + *column.defaultValue + ")"
				if column.generated == "s" {
					definition += " STORED"
				} else {
					definition += " VIRTUAL"
				}
			} else if column.defaultValue != nil {
				definition += " DEFAULT " + *column.defaultValue
			}
		}
		if column.notNull {
			definition += " NOT NULL"
		}
		definitions = append(definitions, definition)
	}
	for _, constraint := range constraints {
		constraintDefinition := "CONSTRAINT " + pgx.Identifier{constraint.name}.Sanitize() + " " + constraint.definition
		if constraint.kind == "f" {
			postStatements = append(postStatements, "ALTER TABLE "+qualifiedName+" ADD "+constraintDefinition)
			continue
		}
		definitions = append(definitions, "  "+constraintDefinition)
	}

	statement := "CREATE TABLE " + qualifiedName + " (\n" + strings.Join(definitions, ",\n") + "\n)"
	if partitioned {
		var partitionKey string
		if err := pool.QueryRow(ctx, "SELECT pg_catalog.pg_get_partkeydef($1::oid)", oid).Scan(&partitionKey); err != nil {
			return "", nil, err
		}
		statement += "\nPARTITION BY " + partitionKey
	}
	statement += ";"

	indexes, err := relationIndexes(ctx, pool, oid)
	if err != nil {
		return "", nil, err
	}
	postStatements = append(postStatements, indexes...)
	return statement, postStatements, nil
}

func relationColumns(ctx context.Context, pool *targetPoolLease, oid uint32) ([]relationColumn, error) {
	rows, err := pool.Query(ctx, `
		SELECT a.attname,
		       pg_catalog.format_type(a.atttypid, a.atttypmod),
		       a.attnotnull,
		       a.attidentity::text,
		       a.attgenerated::text,
		       pg_catalog.pg_get_expr(d.adbin, d.adrelid)
		FROM pg_catalog.pg_attribute a
		LEFT JOIN pg_catalog.pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
		WHERE a.attrelid = $1
		  AND a.attnum > 0
		  AND NOT a.attisdropped
		ORDER BY a.attnum`, oid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	columns := []relationColumn{}
	for rows.Next() {
		var column relationColumn
		if err := rows.Scan(&column.name, &column.dataType, &column.notNull, &column.identity, &column.generated, &column.defaultValue); err != nil {
			return nil, err
		}
		columns = append(columns, column)
	}
	return columns, rows.Err()
}

type relationConstraint struct {
	name       string
	kind       string
	definition string
}

func relationConstraints(ctx context.Context, pool *targetPoolLease, oid uint32) ([]relationConstraint, error) {
	rows, err := pool.Query(ctx, `
		SELECT con.conname, con.contype::text, pg_catalog.pg_get_constraintdef(con.oid, true)
		FROM pg_catalog.pg_constraint con
		WHERE con.conrelid = $1
		  AND con.contype <> 'n'
		ORDER BY con.conname`, oid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	constraints := []relationConstraint{}
	for rows.Next() {
		var constraint relationConstraint
		if err := rows.Scan(&constraint.name, &constraint.kind, &constraint.definition); err != nil {
			return nil, err
		}
		constraints = append(constraints, constraint)
	}
	return constraints, rows.Err()
}

func relationIndexes(ctx context.Context, pool *targetPoolLease, oid uint32) ([]string, error) {
	rows, err := pool.Query(ctx, `
		SELECT pg_catalog.pg_get_indexdef(i.indexrelid)
		FROM pg_catalog.pg_index i
		LEFT JOIN pg_catalog.pg_constraint con ON con.conindid = i.indexrelid
		JOIN pg_catalog.pg_class index_relation ON index_relation.oid = i.indexrelid
		WHERE i.indrelid = $1
		  AND con.oid IS NULL
		ORDER BY index_relation.relname`, oid)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	indexes := []string{}
	for rows.Next() {
		var definition string
		if err := rows.Scan(&definition); err != nil {
			return nil, err
		}
		indexes = append(indexes, strings.TrimSuffix(strings.TrimSpace(definition), ";"))
	}
	return indexes, rows.Err()
}

package service

import (
	"context"

	"github.com/gaucho-racing/workbench/workbench/model"
)

type CatalogColumn struct {
	Name       string `json:"name"`
	DataType   string `json:"data_type"`
	Nullable   bool   `json:"nullable"`
	PrimaryKey bool   `json:"primary_key"`
}

type CatalogTable struct {
	Schema  string          `json:"schema"`
	Name    string          `json:"name"`
	Kind    string          `json:"kind"`
	Columns []CatalogColumn `json:"columns"`
}

type CatalogForeignKey struct {
	Name         string `json:"name"`
	SourceSchema string `json:"source_schema"`
	SourceTable  string `json:"source_table"`
	SourceColumn string `json:"source_column"`
	TargetSchema string `json:"target_schema"`
	TargetTable  string `json:"target_table"`
	TargetColumn string `json:"target_column"`
}

type Catalog struct {
	Tables      []CatalogTable      `json:"tables"`
	ForeignKeys []CatalogForeignKey `json:"foreign_keys"`
}

func GetCatalog(ctx context.Context, target model.DatabaseTarget) (Catalog, error) {
	pool, err := TargetPool(ctx, target)
	if err != nil {
		return Catalog{}, err
	}
	defer pool.Release()
	rows, err := pool.Query(ctx, `
		SELECT n.nspname,
		       c.relname,
		       CASE c.relkind WHEN 'r' THEN 'table' WHEN 'p' THEN 'partitioned_table'
		            WHEN 'v' THEN 'view' WHEN 'm' THEN 'materialized_view' ELSE c.relkind::text END,
		       a.attname,
		       pg_catalog.format_type(a.atttypid, a.atttypmod),
		       NOT a.attnotnull,
		       EXISTS (
		           SELECT 1 FROM pg_constraint con
		           WHERE con.conrelid = c.oid AND con.contype = 'p' AND a.attnum = ANY(con.conkey)
		       )
		FROM pg_class c
		JOIN pg_namespace n ON n.oid = c.relnamespace
		JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
		WHERE c.relkind IN ('r', 'p', 'v', 'm')
		  AND n.nspname NOT IN ('pg_catalog', 'information_schema')
		  AND n.nspname !~ '^pg_toast'
		ORDER BY n.nspname, c.relname, a.attnum`)
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

	foreignKeyRows, err := pool.Query(ctx, `
		SELECT con.conname,
		       source_schema.nspname, source_table.relname, source_column.attname,
		       target_schema.nspname, target_table.relname, target_column.attname
		FROM pg_constraint con
		JOIN pg_class source_table ON source_table.oid = con.conrelid
		JOIN pg_namespace source_schema ON source_schema.oid = source_table.relnamespace
		JOIN pg_class target_table ON target_table.oid = con.confrelid
		JOIN pg_namespace target_schema ON target_schema.oid = target_table.relnamespace
		JOIN LATERAL unnest(con.conkey) WITH ORDINALITY source_key(attnum, position) ON true
		JOIN LATERAL unnest(con.confkey) WITH ORDINALITY target_key(attnum, position) ON target_key.position = source_key.position
		JOIN pg_attribute source_column ON source_column.attrelid = source_table.oid AND source_column.attnum = source_key.attnum
		JOIN pg_attribute target_column ON target_column.attrelid = target_table.oid AND target_column.attnum = target_key.attnum
		WHERE con.contype = 'f'
		  AND source_schema.nspname NOT IN ('pg_catalog', 'information_schema')
		ORDER BY source_schema.nspname, source_table.relname, con.conname, source_key.position`)
	if err != nil {
		return Catalog{}, err
	}
	defer foreignKeyRows.Close()
	foreignKeys := []CatalogForeignKey{}
	for foreignKeyRows.Next() {
		var foreignKey CatalogForeignKey
		if err := foreignKeyRows.Scan(
			&foreignKey.Name,
			&foreignKey.SourceSchema,
			&foreignKey.SourceTable,
			&foreignKey.SourceColumn,
			&foreignKey.TargetSchema,
			&foreignKey.TargetTable,
			&foreignKey.TargetColumn,
		); err != nil {
			return Catalog{}, err
		}
		foreignKeys = append(foreignKeys, foreignKey)
	}
	if err := foreignKeyRows.Err(); err != nil {
		return Catalog{}, err
	}
	return Catalog{Tables: tables, ForeignKeys: foreignKeys}, nil
}

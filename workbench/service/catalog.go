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

func GetCatalog(ctx context.Context, target model.DatabaseTarget) ([]CatalogTable, error) {
	pool, err := TargetPool(ctx, target)
	if err != nil {
		return nil, err
	}
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
		return nil, err
	}
	defer rows.Close()

	tables := []CatalogTable{}
	indexes := make(map[string]int)
	for rows.Next() {
		var schema, tableName, kind string
		var column CatalogColumn
		if err := rows.Scan(&schema, &tableName, &kind, &column.Name, &column.DataType, &column.Nullable, &column.PrimaryKey); err != nil {
			return nil, err
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
	return tables, rows.Err()
}

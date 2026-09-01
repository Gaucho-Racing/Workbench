package service

import (
	"context"
	"errors"
	"strings"

	"github.com/gaucho-racing/workbench/workbench/model"
)

var ErrDatabaseUnavailable = errors.New("database is not available to this connection")

type ServerDatabase struct {
	Name string `json:"name"`
}

func ListDatabases(ctx context.Context, target model.DatabaseTarget) ([]ServerDatabase, error) {
	pool, err := TargetPool(ctx, target)
	if err != nil {
		return nil, err
	}
	defer pool.Release()
	rows, err := pool.Query(ctx, `
		SELECT d.datname
		FROM pg_database d
		WHERE d.datallowconn
		  AND NOT d.datistemplate
		  AND has_database_privilege(d.oid, 'CONNECT')
		ORDER BY lower(d.datname), d.datname`)
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

func SelectDatabase(ctx context.Context, target model.DatabaseTarget, databaseName string) (model.DatabaseTarget, error) {
	databaseName = strings.TrimSpace(databaseName)
	if databaseName == "" || databaseName == target.DatabaseName {
		return target, nil
	}
	databases, err := ListDatabases(ctx, target)
	if err != nil {
		return model.DatabaseTarget{}, err
	}
	for _, database := range databases {
		if database.Name == databaseName {
			target.DatabaseName = databaseName
			return target, nil
		}
	}
	return model.DatabaseTarget{}, ErrDatabaseUnavailable
}

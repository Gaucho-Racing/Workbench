package database

import (
	"context"
	"net"
	"net/url"
	"time"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/jackc/pgx/v5/pgxpool"
)

var Pool *pgxpool.Pool

func Init() {
	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()

	poolConfig, err := pgxpool.ParseConfig(connectionString())
	if err != nil {
		logger.SugarLogger.Fatalf("Failed to parse database configuration: %v", err)
	}
	poolConfig.MaxConns = 10
	poolConfig.MinIdleConns = 1
	poolConfig.MaxConnIdleTime = 10 * time.Minute

	Pool, err = pgxpool.NewWithConfig(ctx, poolConfig)
	if err != nil {
		logger.SugarLogger.Fatalf("Failed to initialize database pool: %v", err)
	}
	if err := Pool.Ping(ctx); err != nil {
		logger.SugarLogger.Fatalf("Failed to connect to database: %v", err)
	}
	if err := migrate(ctx); err != nil {
		logger.SugarLogger.Fatalf("Failed to migrate database: %v", err)
	}
}

func Close() {
	if Pool != nil {
		Pool.Close()
	}
}

func connectionString() string {
	connectionURL := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(config.DatabaseUser, config.DatabasePassword),
		Host:   net.JoinHostPort(config.DatabaseHost, config.DatabasePort),
		Path:   config.DatabaseName,
	}
	query := connectionURL.Query()
	query.Set("sslmode", "disable")
	query.Set("application_name", "workbench")
	connectionURL.RawQuery = query.Encode()
	return connectionURL.String()
}

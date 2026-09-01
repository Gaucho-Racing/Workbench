package service

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"sync"
	"time"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/model"
	"github.com/jackc/pgx/v5/pgxpool"
)

type pooledTarget struct {
	pool      *pgxpool.Pool
	updatedAt time.Time
}

type targetConnectionManager struct {
	mu    sync.Mutex
	pools map[string]pooledTarget
}

var connectionManager *targetConnectionManager

func InitializeConnectionManager() {
	connectionManager = &targetConnectionManager{pools: make(map[string]pooledTarget)}
}

func CloseConnectionManager() {
	if connectionManager == nil {
		return
	}
	connectionManager.mu.Lock()
	defer connectionManager.mu.Unlock()
	for _, target := range connectionManager.pools {
		target.pool.Close()
	}
}

func TargetPool(ctx context.Context, target model.DatabaseTarget) (*pgxpool.Pool, error) {
	return connectionManager.get(ctx, target)
}

func TestTarget(ctx context.Context, target model.DatabaseTarget) error {
	pool, err := newTargetPool(ctx, target)
	if err != nil {
		return err
	}
	defer pool.Close()
	pingContext, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	return pool.Ping(pingContext)
}

func (manager *targetConnectionManager) get(ctx context.Context, target model.DatabaseTarget) (*pgxpool.Pool, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if cached, ok := manager.pools[target.ID]; ok && cached.updatedAt.Equal(target.UpdatedAt) {
		return cached.pool, nil
	} else if ok {
		cached.pool.Close()
		delete(manager.pools, target.ID)
	}
	pool, err := newTargetPool(ctx, target)
	if err != nil {
		return nil, err
	}
	manager.pools[target.ID] = pooledTarget{pool: pool, updatedAt: target.UpdatedAt}
	return pool, nil
}

func (manager *targetConnectionManager) remove(id string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	if cached, ok := manager.pools[id]; ok {
		cached.pool.Close()
		delete(manager.pools, id)
	}
}

func newTargetPool(ctx context.Context, target model.DatabaseTarget) (*pgxpool.Pool, error) {
	password, err := decryptSecret(target.EncryptedPassword)
	if err != nil {
		return nil, err
	}
	connectionURL := url.URL{
		Scheme: "postgres",
		User:   url.UserPassword(target.Username, password),
		Host:   net.JoinHostPort(target.Host, strconv.Itoa(target.Port)),
		Path:   target.DatabaseName,
	}
	query := connectionURL.Query()
	query.Set("sslmode", target.SSLMode)
	query.Set("application_name", "workbench:"+target.ID)
	connectionURL.RawQuery = query.Encode()

	poolConfig, err := pgxpool.ParseConfig(connectionURL.String())
	if err != nil {
		return nil, fmt.Errorf("parse target configuration: %w", err)
	}
	poolConfig.MaxConns = 4
	poolConfig.MaxConnIdleTime = 5 * time.Minute
	poolConfig.ConnConfig.RuntimeParams["statement_timeout"] = strconv.FormatInt(config.QueryTimeoutDuration.Milliseconds(), 10)
	poolConfig.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "15000"
	return pgxpool.NewWithConfig(ctx, poolConfig)
}

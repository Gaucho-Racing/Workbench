package service

import (
	"context"
	"fmt"
	"net"
	"net/url"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/model"
	"github.com/jackc/pgx/v5/pgxpool"
)

type pooledTarget struct {
	pool           *pgxpool.Pool
	updatedAt      time.Time
	lastUsed       time.Time
	users          int
	removeWhenIdle bool
}

type targetConnectionManager struct {
	mu    sync.Mutex
	pools map[string]*pooledTarget
}

type targetPoolLease struct {
	*pgxpool.Pool
	release func()
	once    sync.Once
}

var connectionManager *targetConnectionManager

const maxTargetPools = 32

func InitializeConnectionManager() {
	connectionManager = &targetConnectionManager{pools: make(map[string]*pooledTarget)}
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

func TargetPool(ctx context.Context, target model.DatabaseTarget) (*targetPoolLease, error) {
	return connectionManager.get(ctx, target)
}

func (lease *targetPoolLease) Release() {
	lease.once.Do(lease.release)
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

func (manager *targetConnectionManager) get(ctx context.Context, target model.DatabaseTarget) (*targetPoolLease, error) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	key := targetPoolKey(target)
	if cached, ok := manager.pools[key]; ok && cached.updatedAt.Equal(target.UpdatedAt) {
		cached.lastUsed = time.Now()
		cached.users++
		return manager.lease(key, cached), nil
	} else if ok {
		if cached.users == 0 {
			cached.pool.Close()
			delete(manager.pools, key)
		} else {
			cached.removeWhenIdle = true
			return nil, fmt.Errorf("database connection is being refreshed")
		}
	}
	pool, err := newTargetPool(ctx, target)
	if err != nil {
		return nil, err
	}
	manager.evictOldestPool()
	cached := &pooledTarget{pool: pool, updatedAt: target.UpdatedAt, lastUsed: time.Now(), users: 1}
	manager.pools[key] = cached
	return manager.lease(key, cached), nil
}

func (manager *targetConnectionManager) lease(key string, cached *pooledTarget) *targetPoolLease {
	return &targetPoolLease{
		Pool: cached.pool,
		release: func() {
			manager.mu.Lock()
			defer manager.mu.Unlock()
			current, ok := manager.pools[key]
			if !ok || current != cached {
				return
			}
			current.users--
			current.lastUsed = time.Now()
			if current.users == 0 && current.removeWhenIdle {
				current.pool.Close()
				delete(manager.pools, key)
			}
		},
	}
}

func (manager *targetConnectionManager) remove(id string) {
	manager.mu.Lock()
	defer manager.mu.Unlock()
	prefix := id + "\x00"
	for key, cached := range manager.pools {
		if strings.HasPrefix(key, prefix) {
			if cached.users == 0 {
				cached.pool.Close()
				delete(manager.pools, key)
			} else {
				cached.removeWhenIdle = true
			}
		}
	}
}

func (manager *targetConnectionManager) evictOldestPool() {
	if len(manager.pools) < maxTargetPools {
		return
	}
	oldestKey := ""
	var oldestAccess time.Time
	for key, cached := range manager.pools {
		if cached.users == 0 && (oldestKey == "" || cached.lastUsed.Before(oldestAccess)) {
			oldestKey = key
			oldestAccess = cached.lastUsed
		}
	}
	if oldestKey == "" {
		return
	}
	manager.pools[oldestKey].pool.Close()
	delete(manager.pools, oldestKey)
}

func targetPoolKey(target model.DatabaseTarget) string {
	return target.ID + "\x00" + target.DatabaseName
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
	poolConfig.ConnConfig.RuntimeParams["lock_timeout"] = "5000"
	poolConfig.ConnConfig.RuntimeParams["idle_in_transaction_session_timeout"] = "15000"
	return pgxpool.NewWithConfig(ctx, poolConfig)
}

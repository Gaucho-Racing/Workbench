package sentinel

import (
	"context"
	"fmt"
	"strings"
	"sync"
	"time"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/lestrrat-go/jwx/v2/jwk"
)

var (
	keySetMu    sync.RWMutex
	keySet      jwk.Set
	lastFetched time.Time
)

const refetchFloor = time.Minute

func InitializeKeys() {
	if err := fetchKeySet(); err != nil {
		logger.SugarLogger.Errorf("Failed to load Sentinel JWKS, will retry on first token: %v", err)
		return
	}
	keySetMu.RLock()
	defer keySetMu.RUnlock()
	logger.SugarLogger.Infof("Loaded %d Sentinel signing key(s)", keySet.Len())
}

func fetchKeySet() error {
	if strings.TrimSpace(config.SentinelURL) == "" {
		return fmt.Errorf("SENTINEL_URL is not configured")
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	set, err := jwk.Fetch(ctx, strings.TrimRight(config.SentinelURL, "/")+"/api/core/keys")
	if err != nil {
		return err
	}
	if set.Len() == 0 {
		return fmt.Errorf("no keys found in Sentinel JWKS")
	}
	keySetMu.Lock()
	keySet = set
	lastFetched = time.Now()
	keySetMu.Unlock()
	return nil
}

func lookupKey(kid string) (interface{}, error) {
	key, found := keyFromSet(kid)
	if !found {
		keySetMu.RLock()
		stale := keySet == nil || time.Since(lastFetched) > refetchFloor
		keySetMu.RUnlock()
		if stale {
			if err := fetchKeySet(); err != nil {
				return nil, fmt.Errorf("signing key %q unavailable: %w", kid, err)
			}
			key, found = keyFromSet(kid)
		}
	}
	if !found {
		return nil, fmt.Errorf("no signing key matches kid %q", kid)
	}
	var raw interface{}
	if err := key.Raw(&raw); err != nil {
		return nil, fmt.Errorf("decode signing key: %w", err)
	}
	return raw, nil
}

func keyFromSet(kid string) (jwk.Key, bool) {
	keySetMu.RLock()
	defer keySetMu.RUnlock()
	if keySet == nil || keySet.Len() == 0 {
		return nil, false
	}
	if kid != "" {
		key, ok := keySet.LookupKeyID(kid)
		return key, ok
	}
	return keySet.Key(0)
}

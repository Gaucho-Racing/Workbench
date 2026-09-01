package config

import (
	"encoding/base64"
	"strconv"
	"time"

	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
)

func Verify() {
	defaultString(&Env, "PROD", "ENV")
	defaultString(&Port, "9999", "PORT")
	defaultString(&DatabaseHost, "localhost", "DATABASE_HOST")
	defaultString(&DatabasePort, "5432", "DATABASE_PORT")
	defaultString(&DatabaseUser, "postgres", "DATABASE_USER")
	defaultString(&DatabasePassword, "password", "DATABASE_PASSWORD")
	defaultString(&DatabaseName, "workbench", "DATABASE_NAME")
	defaultString(&QueryTimeout, "30s", "QUERY_TIMEOUT")
	defaultString(&QueryMaxRows, "5000", "QUERY_MAX_ROWS")

	if SentinelURL == "" {
		logger.SugarLogger.Fatal("SENTINEL_URL is required")
	}
	if SentinelClientID == "" || SentinelClientSecret == "" {
		logger.SugarLogger.Warn("SENTINEL_CLIENT_ID and SENTINEL_CLIENT_SECRET are required for web login")
	}

	decodedKey, err := base64.StdEncoding.DecodeString(TargetEncryptionKeyEncoded)
	if err != nil || len(decodedKey) != 32 {
		logger.SugarLogger.Fatal("TARGET_ENCRYPTION_KEY must be a base64-encoded 32-byte key")
	}
	TargetEncryptionKey = decodedKey

	QueryTimeoutDuration, err = time.ParseDuration(QueryTimeout)
	if err != nil || QueryTimeoutDuration <= 0 {
		logger.SugarLogger.Fatal("QUERY_TIMEOUT must be a positive duration")
	}
	QueryMaxRowsLimit, err = strconv.Atoi(QueryMaxRows)
	if err != nil || QueryMaxRowsLimit <= 0 {
		logger.SugarLogger.Fatal("QUERY_MAX_ROWS must be a positive integer")
	}
}

func defaultString(target *string, value string, name string) {
	if *target != "" {
		return
	}
	*target = value
	logger.SugarLogger.Infof("%s is not set, defaulting to %s", name, value)
}

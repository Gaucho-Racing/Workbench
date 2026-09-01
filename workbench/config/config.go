package config

import (
	"os"
	"time"
)

const Name = "workbench"
const Version = "1.3.0"

var Env = os.Getenv("ENV")
var Port = os.Getenv("PORT")

var DatabaseHost = os.Getenv("DATABASE_HOST")
var DatabasePort = os.Getenv("DATABASE_PORT")
var DatabaseUser = os.Getenv("DATABASE_USER")
var DatabasePassword = os.Getenv("DATABASE_PASSWORD")
var DatabaseName = os.Getenv("DATABASE_NAME")

var SentinelURL = os.Getenv("SENTINEL_URL")
var SentinelClientID = os.Getenv("SENTINEL_CLIENT_ID")
var SentinelClientSecret = os.Getenv("SENTINEL_CLIENT_SECRET")
var SentinelRedirectURI = os.Getenv("SENTINEL_REDIRECT_URI")

var TargetEncryptionKeyEncoded = os.Getenv("TARGET_ENCRYPTION_KEY")
var TargetEncryptionKey []byte

var QueryTimeout = os.Getenv("QUERY_TIMEOUT")
var QueryTimeoutDuration time.Duration
var QueryMaxRows = os.Getenv("QUERY_MAX_ROWS")
var QueryMaxRowsLimit int
var QueryMaxBytes = os.Getenv("QUERY_MAX_BYTES")
var QueryMaxBytesLimit int

func IsProduction() bool {
	return Env == "PROD"
}

func FormattedNameWithVersion() string {
	return Name + " v" + Version
}

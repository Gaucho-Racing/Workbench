package model

import "time"

const (
	EnginePostgres   = "postgres"
	EngineClickHouse = "clickhouse"
)

type DatabaseTarget struct {
	ID                string     `json:"id"`
	Name              string     `json:"name"`
	Engine            string     `json:"engine"`
	Environment       string     `json:"environment"`
	Host              string     `json:"host"`
	Port              int        `json:"port"`
	DatabaseName      string     `json:"database_name"`
	Username          string     `json:"username"`
	EncryptedPassword []byte     `json:"-"`
	SSLMode           string     `json:"ssl_mode"`
	CreatedByEntityID string     `json:"created_by_entity_id"`
	CreatedAt         time.Time  `json:"created_at"`
	UpdatedAt         time.Time  `json:"updated_at"`
	DeletedAt         *time.Time `json:"-"`
}

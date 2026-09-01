package model

import "time"

type QueryRun struct {
	ID            string    `json:"id"`
	TargetID      string    `json:"target_id"`
	TargetName    string    `json:"target_name,omitempty"`
	ActorEntityID string    `json:"actor_entity_id"`
	Statement     string    `json:"statement"`
	Status        string    `json:"status"`
	CommandTag    string    `json:"command_tag"`
	RowCount      int64     `json:"row_count"`
	DurationMS    int64     `json:"duration_ms"`
	ErrorMessage  string    `json:"error_message"`
	CreatedAt     time.Time `json:"created_at"`
}

type QueryColumn struct {
	Name        string `json:"name"`
	DataTypeOID uint32 `json:"data_type_oid"`
}

type QueryResult struct {
	RunID      string          `json:"run_id"`
	Columns    []QueryColumn   `json:"columns"`
	Rows       [][]interface{} `json:"rows"`
	CommandTag string          `json:"command_tag"`
	RowCount   int64           `json:"row_count"`
	DurationMS int64           `json:"duration_ms"`
	Truncated  bool            `json:"truncated"`
}

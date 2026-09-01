CREATE TABLE data_transfer_run (
    id text PRIMARY KEY,
    target_id text NOT NULL REFERENCES database_target(id),
    database_name text NOT NULL,
    actor_entity_id text NOT NULL,
    direction text NOT NULL CHECK (direction IN ('EXPORT', 'IMPORT')),
    schema_name text NOT NULL DEFAULT '',
    table_name text NOT NULL DEFAULT '',
    file_name text NOT NULL DEFAULT '',
    statement text NOT NULL DEFAULT '',
    status text NOT NULL,
    row_count bigint NOT NULL DEFAULT 0,
    duration_ms bigint NOT NULL DEFAULT 0,
    error_message text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now(),
    completed_at timestamptz
);

CREATE INDEX data_transfer_run_actor_created_at_idx ON data_transfer_run(actor_entity_id, created_at DESC);
CREATE INDEX data_transfer_run_target_created_at_idx ON data_transfer_run(target_id, created_at DESC);

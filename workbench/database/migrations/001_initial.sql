CREATE TABLE database_target (
    id text PRIMARY KEY,
    name text NOT NULL UNIQUE,
    environment text NOT NULL,
    host text NOT NULL,
    port integer NOT NULL CHECK (port BETWEEN 1 AND 65535),
    database_name text NOT NULL,
    username text NOT NULL,
    encrypted_password bytea NOT NULL,
    ssl_mode text NOT NULL DEFAULT 'require',
    created_by_entity_id text NOT NULL,
    created_at timestamptz NOT NULL DEFAULT now(),
    updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE query_run (
    id text PRIMARY KEY,
    target_id text NOT NULL REFERENCES database_target(id) ON DELETE CASCADE,
    actor_entity_id text NOT NULL,
    statement text NOT NULL,
    status text NOT NULL,
    command_tag text NOT NULL DEFAULT '',
    row_count bigint NOT NULL DEFAULT 0,
    duration_ms bigint NOT NULL DEFAULT 0,
    error_message text NOT NULL DEFAULT '',
    created_at timestamptz NOT NULL DEFAULT now()
);

CREATE INDEX query_run_actor_created_at_idx ON query_run(actor_entity_id, created_at DESC);
CREATE INDEX query_run_target_created_at_idx ON query_run(target_id, created_at DESC);


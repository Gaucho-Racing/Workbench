ALTER TABLE database_target
ADD COLUMN IF NOT EXISTS engine text NOT NULL DEFAULT 'postgres'
CHECK (engine IN ('postgres', 'clickhouse'));

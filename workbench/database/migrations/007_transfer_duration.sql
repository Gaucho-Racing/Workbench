ALTER TABLE data_transfer_run
ADD COLUMN IF NOT EXISTS duration_ms bigint NOT NULL DEFAULT 0;

ALTER TABLE data_transfer_run
ADD COLUMN error_count bigint NOT NULL DEFAULT 0;

ALTER TABLE data_transfer_run
ADD COLUMN error_policy text NOT NULL DEFAULT 'abort'
CHECK (error_policy IN ('abort', 'continue'));

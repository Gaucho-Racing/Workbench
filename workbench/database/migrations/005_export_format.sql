ALTER TABLE data_transfer_run
ADD COLUMN format text NOT NULL DEFAULT 'csv'
CHECK (format IN ('csv', 'json', 'parquet', 'sql'));

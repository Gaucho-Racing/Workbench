package service

import (
	"context"
	"encoding/hex"
	"fmt"
	"time"

	"github.com/gaucho-racing/ulid-go"
	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/database"
	"github.com/gaucho-racing/workbench/workbench/model"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
)

func ExecuteQuery(ctx context.Context, target model.DatabaseTarget, statement string, actorEntityID string) (model.QueryResult, error) {
	run := model.QueryRun{
		ID:            ulid.Make().Prefixed("qry"),
		TargetID:      target.ID,
		ActorEntityID: actorEntityID,
		Statement:     statement,
		Status:        "RUNNING",
	}
	if _, err := database.Pool.Exec(ctx, `
		INSERT INTO query_run (id, target_id, actor_entity_id, statement, status)
		VALUES ($1, $2, $3, $4, $5)`, run.ID, run.TargetID, run.ActorEntityID, run.Statement, run.Status); err != nil {
		return model.QueryResult{}, err
	}

	startedAt := time.Now()
	queryContext, cancel := context.WithTimeout(ctx, config.QueryTimeoutDuration)
	defer cancel()

	pool, err := TargetPool(queryContext, target)
	if err != nil {
		finishQueryRun(context.Background(), run.ID, "FAILED", "", 0, time.Since(startedAt), err)
		return model.QueryResult{RunID: run.ID}, err
	}
	rows, err := pool.Query(queryContext, statement)
	if err != nil {
		finishQueryRun(context.Background(), run.ID, "FAILED", "", 0, time.Since(startedAt), err)
		return model.QueryResult{RunID: run.ID}, err
	}
	defer rows.Close()

	fields := rows.FieldDescriptions()
	columns := make([]model.QueryColumn, len(fields))
	for index, field := range fields {
		columns[index] = model.QueryColumn{Name: field.Name, DataTypeOID: field.DataTypeOID}
	}

	resultRows := make([][]interface{}, 0, min(config.QueryMaxRowsLimit, 256))
	truncated := false
	resultBytes := 0
	for rows.Next() {
		if len(resultRows) >= config.QueryMaxRowsLimit {
			truncated = true
			break
		}
		values, err := rows.Values()
		if err != nil {
			finishQueryRun(context.Background(), run.ID, "FAILED", "", int64(len(resultRows)), time.Since(startedAt), err)
			return model.QueryResult{RunID: run.ID}, err
		}
		formattedValues := formatValues(values)
		rowBytes := estimateRowBytes(formattedValues)
		if resultBytes+rowBytes > config.QueryMaxBytesLimit {
			truncated = true
			break
		}
		resultBytes += rowBytes
		resultRows = append(resultRows, formattedValues)
	}
	if err := rows.Err(); err != nil {
		finishQueryRun(context.Background(), run.ID, "FAILED", "", int64(len(resultRows)), time.Since(startedAt), err)
		return model.QueryResult{RunID: run.ID}, err
	}
	rows.Close()
	commandTag := rows.CommandTag()
	rowCount := int64(len(resultRows))
	if len(fields) == 0 {
		rowCount = commandTag.RowsAffected()
	}
	duration := time.Since(startedAt)
	finishQueryRun(context.Background(), run.ID, "SUCCEEDED", commandTag.String(), rowCount, duration, nil)
	return model.QueryResult{
		RunID:      run.ID,
		Columns:    columns,
		Rows:       resultRows,
		CommandTag: commandTag.String(),
		RowCount:   rowCount,
		DurationMS: duration.Milliseconds(),
		Truncated:  truncated,
	}, nil
}

func ListQueryRuns(ctx context.Context, actorEntityID string, limit int) ([]model.QueryRun, error) {
	rows, err := database.Pool.Query(ctx, `
		SELECT q.id, q.target_id, t.name, q.actor_entity_id, q.statement, q.status,
		       q.command_tag, q.row_count, q.duration_ms, q.error_message, q.created_at
		FROM query_run q
		JOIN database_target t ON t.id = q.target_id
		WHERE q.actor_entity_id = $1
		ORDER BY q.created_at DESC
		LIMIT $2`, actorEntityID, limit)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	runs := []model.QueryRun{}
	for rows.Next() {
		var run model.QueryRun
		if err := rows.Scan(&run.ID, &run.TargetID, &run.TargetName, &run.ActorEntityID,
			&run.Statement, &run.Status, &run.CommandTag, &run.RowCount, &run.DurationMS,
			&run.ErrorMessage, &run.CreatedAt); err != nil {
			return nil, err
		}
		runs = append(runs, run)
	}
	return runs, rows.Err()
}

func finishQueryRun(ctx context.Context, id string, status string, commandTag string, rowCount int64, duration time.Duration, queryError error) {
	errorMessage := ""
	if queryError != nil {
		errorMessage = queryError.Error()
	}
	updateContext, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	if _, err := database.Pool.Exec(updateContext, `
		UPDATE query_run
		SET status = $2, command_tag = $3, row_count = $4, duration_ms = $5, error_message = $6
		WHERE id = $1`, id, status, commandTag, rowCount, duration.Milliseconds(), errorMessage); err != nil {
		logger.SugarLogger.Errorf("Failed to finalize query run %s: %v", id, err)
	}
}

func formatValues(values []interface{}) []interface{} {
	formatted := make([]interface{}, len(values))
	for index, value := range values {
		switch typed := value.(type) {
		case nil:
			formatted[index] = nil
		case []byte:
			formatted[index] = "\\x" + hex.EncodeToString(typed)
		case time.Time:
			formatted[index] = typed.Format(time.RFC3339Nano)
		case string, bool:
			formatted[index] = typed
		default:
			formatted[index] = fmt.Sprint(typed)
		}
	}
	return formatted
}

func estimateRowBytes(values []interface{}) int {
	size := 2
	for _, value := range values {
		switch typed := value.(type) {
		case nil:
			size += 5
		case string:
			size += len(typed) + 3
		default:
			size += 8
		}
	}
	return size
}

package service

import (
	"context"
	"errors"
	"fmt"
	"strings"

	"github.com/gaucho-racing/ulid-go"
	"github.com/gaucho-racing/workbench/workbench/database"
	"github.com/gaucho-racing/workbench/workbench/model"
	"github.com/jackc/pgx/v5"
)

var ErrTargetNotFound = errors.New("database target not found")

type CreateTargetInput struct {
	Name         string `json:"name" binding:"required"`
	Environment  string `json:"environment" binding:"required"`
	Host         string `json:"host" binding:"required"`
	Port         int    `json:"port" binding:"required,min=1,max=65535"`
	DatabaseName string `json:"database_name" binding:"required"`
	Username     string `json:"username" binding:"required"`
	Password     string `json:"password" binding:"required"`
	SSLMode      string `json:"ssl_mode" binding:"required,oneof=disable allow prefer require verify-ca verify-full"`
}

func ListTargets(ctx context.Context) ([]model.DatabaseTarget, error) {
	rows, err := database.Pool.Query(ctx, `
		SELECT id, name, environment, host, port, database_name, username, ssl_mode,
		       created_by_entity_id, created_at, updated_at
		FROM database_target
		WHERE deleted_at IS NULL
		ORDER BY lower(name)`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()

	targets := []model.DatabaseTarget{}
	for rows.Next() {
		var target model.DatabaseTarget
		if err := rows.Scan(&target.ID, &target.Name, &target.Environment, &target.Host, &target.Port,
			&target.DatabaseName, &target.Username, &target.SSLMode, &target.CreatedByEntityID,
			&target.CreatedAt, &target.UpdatedAt); err != nil {
			return nil, err
		}
		targets = append(targets, target)
	}
	return targets, rows.Err()
}

func GetTarget(ctx context.Context, id string) (model.DatabaseTarget, error) {
	var target model.DatabaseTarget
	err := database.Pool.QueryRow(ctx, `
		SELECT id, name, environment, host, port, database_name, username, encrypted_password,
		       ssl_mode, created_by_entity_id, created_at, updated_at
		FROM database_target WHERE id = $1 AND deleted_at IS NULL`, id).Scan(
		&target.ID, &target.Name, &target.Environment, &target.Host, &target.Port,
		&target.DatabaseName, &target.Username, &target.EncryptedPassword, &target.SSLMode,
		&target.CreatedByEntityID, &target.CreatedAt, &target.UpdatedAt,
	)
	if errors.Is(err, pgx.ErrNoRows) {
		return model.DatabaseTarget{}, ErrTargetNotFound
	}
	return target, err
}

func CreateTarget(ctx context.Context, input CreateTargetInput, entityID string) (model.DatabaseTarget, error) {
	input.Name = strings.TrimSpace(input.Name)
	input.Environment = strings.TrimSpace(input.Environment)
	input.Host = strings.TrimSpace(input.Host)
	input.DatabaseName = strings.TrimSpace(input.DatabaseName)
	input.Username = strings.TrimSpace(input.Username)
	if input.Name == "" || input.Environment == "" || input.Host == "" || input.DatabaseName == "" || input.Username == "" {
		return model.DatabaseTarget{}, fmt.Errorf("name, environment, host, database_name, and username cannot be blank")
	}
	encryptedPassword, err := encryptSecret(input.Password)
	if err != nil {
		return model.DatabaseTarget{}, err
	}
	target := model.DatabaseTarget{
		ID:                ulid.Make().Prefixed("db"),
		Name:              input.Name,
		Environment:       strings.ToUpper(input.Environment),
		Host:              input.Host,
		Port:              input.Port,
		DatabaseName:      input.DatabaseName,
		Username:          input.Username,
		EncryptedPassword: encryptedPassword,
		SSLMode:           input.SSLMode,
		CreatedByEntityID: entityID,
	}
	if err := TestTarget(ctx, target); err != nil {
		return model.DatabaseTarget{}, fmt.Errorf("connect to target: %w", err)
	}
	err = database.Pool.QueryRow(ctx, `
		INSERT INTO database_target (
			id, name, environment, host, port, database_name, username, encrypted_password,
			ssl_mode, created_by_entity_id
		) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
		RETURNING created_at, updated_at`,
		target.ID, target.Name, target.Environment, target.Host, target.Port, target.DatabaseName,
		target.Username, target.EncryptedPassword, target.SSLMode, target.CreatedByEntityID,
	).Scan(&target.CreatedAt, &target.UpdatedAt)
	if err != nil {
		return model.DatabaseTarget{}, err
	}
	target.EncryptedPassword = nil
	return target, nil
}

func DeleteTarget(ctx context.Context, id string) error {
	result, err := database.Pool.Exec(ctx, "UPDATE database_target SET deleted_at = now(), updated_at = now() WHERE id = $1 AND deleted_at IS NULL", id)
	if err != nil {
		return err
	}
	if result.RowsAffected() == 0 {
		return ErrTargetNotFound
	}
	connectionManager.remove(id)
	return nil
}

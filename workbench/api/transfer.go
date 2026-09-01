package api

import (
	"errors"
	"fmt"
	"net/http"
	"path/filepath"
	"strings"
	"time"

	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/gaucho-racing/workbench/workbench/service"
	"github.com/gin-gonic/gin"
)

const maxImportRequestBytes = 51 << 20

func PreviewExport(c *gin.Context) {
	var request struct {
		TargetID     string `json:"target_id" binding:"required"`
		DatabaseName string `json:"database_name"`
		Statement    string `json:"statement" binding:"required"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	request.Statement = strings.TrimSpace(request.Statement)
	if request.Statement == "" || len(request.Statement) > maxStatementBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "statement must contain between 1 and 1048576 bytes"})
		return
	}
	target, err := service.GetTarget(c.Request.Context(), request.TargetID)
	if errors.Is(err, service.ErrTargetNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	target, err = service.SelectDatabase(c.Request.Context(), target, request.DatabaseName)
	if errors.Is(err, service.ErrDatabaseUnavailable) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	preview, err := service.PreviewExportQuery(c.Request.Context(), target, request.Statement)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, preview)
}

func ExportQuery(c *gin.Context) {
	var request struct {
		TargetID     string `json:"target_id" binding:"required"`
		DatabaseName string `json:"database_name"`
		Statement    string `json:"statement" binding:"required"`
		Format       string `json:"format" binding:"required"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	request.Statement = strings.TrimSpace(request.Statement)
	if request.Statement == "" || len(request.Statement) > maxStatementBytes {
		c.JSON(http.StatusBadRequest, gin.H{"error": "statement must contain between 1 and 1048576 bytes"})
		return
	}
	exportFormat, err := service.ParseExportFormat(request.Format)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	target, err := service.GetTarget(c.Request.Context(), request.TargetID)
	if errors.Is(err, service.ErrTargetNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	target, err = service.SelectDatabase(c.Request.Context(), target, request.DatabaseName)
	if errors.Is(err, service.ErrDatabaseUnavailable) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}

	timestamp := time.Now().Format("20060102-150405")
	fileName := fmt.Sprintf("%s-%s-%s.%s", safeFileName(target.Name), safeFileName(target.DatabaseName), timestamp, exportFormat.Extension())
	c.Header("Content-Type", exportFormat.ContentType())
	c.Header("Content-Disposition", fmt.Sprintf("attachment; filename=%q", fileName))
	transferID, err := service.ExportQuery(
		c.Request.Context(),
		target,
		request.Statement,
		getRequestTokenEntityID(c),
		service.ExportOptions{
			Format:       exportFormat,
			SQLTableName: safeSQLIdentifier(target.DatabaseName) + "_export_" + strings.ReplaceAll(timestamp, "-", "_"),
		},
		c.Writer,
	)
	if err == nil {
		return
	}
	if c.Writer.Written() {
		logger.SugarLogger.Errorf("%s export %s failed after streaming began: %v", exportFormat, transferID, err)
		return
	}
	c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "transfer_id": transferID})
}

func ImportCSV(c *gin.Context) {
	c.Request.Body = http.MaxBytesReader(c.Writer, c.Request.Body, maxImportRequestBytes)
	fileHeader, err := c.FormFile("file")
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "a CSV file up to 50 MB is required"})
		return
	}
	if c.Request.MultipartForm != nil {
		defer c.Request.MultipartForm.RemoveAll()
	}
	databaseName := strings.TrimSpace(c.PostForm("database_name"))
	schemaName := strings.TrimSpace(c.PostForm("schema"))
	tableName := strings.TrimSpace(c.PostForm("table"))
	if databaseName == "" || schemaName == "" || tableName == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "database_name, schema, and table are required"})
		return
	}
	target, err := service.GetTarget(c.Request.Context(), c.Param("id"))
	if errors.Is(err, service.ErrTargetNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	target, err = service.SelectDatabase(c.Request.Context(), target, databaseName)
	if errors.Is(err, service.ErrDatabaseUnavailable) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	file, err := fileHeader.Open()
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "open uploaded CSV: " + err.Error()})
		return
	}
	defer file.Close()
	result, err := service.ImportCSV(
		c.Request.Context(), target, schemaName, tableName, filepath.Base(fileHeader.Filename), file, getRequestTokenEntityID(c),
	)
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error(), "transfer_id": result.TransferID})
		return
	}
	c.JSON(http.StatusOK, result)
}

func safeFileName(value string) string {
	value = strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '-' || character == '_' {
			return character
		}
		return '-'
	}, value)
	return strings.Trim(value, "-")
}

func safeSQLIdentifier(value string) string {
	value = strings.Map(func(character rune) rune {
		if character >= 'a' && character <= 'z' || character >= 'A' && character <= 'Z' || character >= '0' && character <= '9' || character == '_' {
			return character
		}
		return '_'
	}, value)
	value = strings.Trim(value, "_")
	if value == "" {
		return "workbench"
	}
	return value
}

package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gaucho-racing/workbench/workbench/service"
	"github.com/gin-gonic/gin"
)

const maxStatementBytes = 1024 * 1024

func ExecuteQuery(c *gin.Context) {
	var request struct {
		TargetID     string `json:"target_id" binding:"required"`
		DatabaseName string `json:"database_name"`
		Statement    string `json:"statement" binding:"required"`
		ReadOnly     *bool  `json:"read_only"`
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
	readOnly := true
	if request.ReadOnly != nil {
		readOnly = *request.ReadOnly
	}
	readOnly = readOnly || !requestTokenHasGroup(c, AdminGroupName)
	result, err := service.ExecuteQuery(
		c.Request.Context(),
		target,
		request.Statement,
		getRequestTokenEntityID(c),
		readOnly,
	)
	if err != nil {
		response := gin.H{"error": err.Error(), "run_id": result.RunID}
		if readOnly && service.IsReadOnlyViolation(err) {
			response["code"] = "read_only_violation"
			response["error"] = "This statement requires Write mode."
		}
		c.JSON(http.StatusBadRequest, response)
		return
	}
	c.JSON(http.StatusOK, result)
}

func ListQueryRuns(c *gin.Context) {
	runs, err := service.ListQueryRuns(c.Request.Context(), getRequestTokenEntityID(c), 100)
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, runs)
}

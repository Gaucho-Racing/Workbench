package api

import (
	"errors"
	"net/http"
	"strings"

	"github.com/gaucho-racing/workbench/workbench/service"
	"github.com/gin-gonic/gin"
)

func GetRelationDDL(c *gin.Context) {
	schema := strings.TrimSpace(c.Query("schema"))
	relation := strings.TrimSpace(c.Query("relation"))
	if schema == "" || relation == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "schema and relation are required"})
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
	target, err = service.SelectDatabase(c.Request.Context(), target, c.Query("database"))
	if errors.Is(err, service.ErrDatabaseUnavailable) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	ddl, err := service.GetRelationDDL(c.Request.Context(), target, schema, relation)
	if errors.Is(err, service.ErrRelationNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"ddl": ddl})
}

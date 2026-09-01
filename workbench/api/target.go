package api

import (
	"errors"
	"net/http"

	"github.com/gaucho-racing/workbench/workbench/service"
	"github.com/gin-gonic/gin"
)

func ListTargets(c *gin.Context) {
	targets, err := service.ListTargets(c.Request.Context())
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, targets)
}

func CreateTarget(c *gin.Context) {
	var input service.CreateTargetInput
	if err := c.ShouldBindJSON(&input); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	target, err := service.CreateTarget(c.Request.Context(), input, getRequestTokenEntityID(c))
	if err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusCreated, target)
}

func DeleteTarget(c *gin.Context) {
	err := service.DeleteTarget(c.Request.Context(), c.Param("id"))
	if errors.Is(err, service.ErrTargetNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	c.Status(http.StatusNoContent)
}

func TestTarget(c *gin.Context) {
	target, err := service.GetTarget(c.Request.Context(), c.Param("id"))
	if errors.Is(err, service.ErrTargetNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	if err := service.TestTarget(c.Request.Context(), target); err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, gin.H{"status": "ok"})
}

func GetCatalog(c *gin.Context) {
	target, err := service.GetTarget(c.Request.Context(), c.Param("id"))
	if errors.Is(err, service.ErrTargetNotFound) {
		c.JSON(http.StatusNotFound, gin.H{"error": err.Error()})
		return
	}
	if err != nil {
		c.JSON(http.StatusInternalServerError, gin.H{"error": err.Error()})
		return
	}
	catalog, err := service.GetCatalog(c.Request.Context(), target)
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, catalog)
}

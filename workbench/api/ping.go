package api

import (
	"net/http"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gin-gonic/gin"
)

func Ping(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{"name": config.Name, "version": config.Version, "status": "ok"})
}

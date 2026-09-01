package api

import (
	"fmt"
	"net/http"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/gaucho-racing/workbench/workbench/pkg/sentinel"
	"github.com/gin-gonic/gin"
)

func LoginWithSentinel(c *gin.Context) {
	code := c.Query("code")
	if code == "" {
		c.JSON(http.StatusBadRequest, gin.H{"error": "code is required"})
		return
	}
	token, err := sentinel.ExchangeAuthorizationCode(code, callbackURL(c))
	if err != nil {
		logger.SugarLogger.Errorf("Sentinel authorization-code exchange failed: %v", err)
		c.JSON(http.StatusUnauthorized, gin.H{"error": "Sentinel sign-on failed"})
		return
	}
	c.JSON(http.StatusOK, token)
}

func RefreshSession(c *gin.Context) {
	var request struct {
		RefreshToken string `json:"refresh_token" binding:"required"`
	}
	if err := c.ShouldBindJSON(&request); err != nil {
		c.JSON(http.StatusBadRequest, gin.H{"error": "refresh_token is required"})
		return
	}
	token, err := sentinel.RefreshToken(request.RefreshToken)
	if err != nil {
		c.JSON(http.StatusUnauthorized, gin.H{"error": "session refresh failed"})
		return
	}
	c.JSON(http.StatusOK, token)
}

func Logout(c *gin.Context) {
	c.Status(http.StatusNoContent)
}

func GetSession(c *gin.Context) {
	c.JSON(http.StatusOK, gin.H{
		"entity_id": getRequestTokenEntityID(c),
		"user_id":   getRequestTokenUserID(c),
		"client_id": getRequestTokenAudience(c),
		"groups":    claimStringSlice(getRequestTokenClaims(c), "groups"),
	})
}

func GetCurrentUser(c *gin.Context) {
	user, err := sentinel.GetCurrentUser(getRequestToken(c), getRequestTokenUserID(c))
	if err != nil {
		c.JSON(http.StatusBadGateway, gin.H{"error": err.Error()})
		return
	}
	c.JSON(http.StatusOK, user)
}

func callbackURL(c *gin.Context) string {
	if config.SentinelRedirectURI != "" {
		return config.SentinelRedirectURI
	}
	protocol := c.GetHeader("X-Forwarded-Proto")
	if protocol == "" {
		protocol = "http"
		if c.Request.TLS != nil {
			protocol = "https"
		}
	}
	host := c.GetHeader("X-Forwarded-Host")
	if host == "" {
		host = c.Request.Host
	}
	return fmt.Sprintf("%s://%s/auth/login", protocol, host)
}

package api

import (
	"context"
	"errors"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/gaucho-racing/workbench/workbench/pkg/sentinel"
	"github.com/gin-contrib/cors"
	"github.com/gin-gonic/gin"
)

func Run() {
	router := initializeRouter()
	initializeRoutes(router)
	server := &http.Server{
		Addr:              ":" + config.Port,
		Handler:           router,
		ReadHeaderTimeout: 10 * time.Second,
		IdleTimeout:       60 * time.Second,
	}

	serverError := make(chan error, 1)
	go func() {
		serverError <- server.ListenAndServe()
	}()

	shutdownSignal := make(chan os.Signal, 1)
	signal.Notify(shutdownSignal, syscall.SIGINT, syscall.SIGTERM)
	select {
	case signal := <-shutdownSignal:
		logger.SugarLogger.Infof("Received %s, shutting down", signal)
	case err := <-serverError:
		if !errors.Is(err, http.ErrServerClosed) {
			logger.SugarLogger.Fatalf("Server failed: %v", err)
		}
		return
	}

	ctx, cancel := context.WithTimeout(context.Background(), 15*time.Second)
	defer cancel()
	if err := server.Shutdown(ctx); err != nil {
		logger.SugarLogger.Errorf("Server shutdown failed: %v", err)
	}
}

func initializeRouter() *gin.Engine {
	if config.IsProduction() {
		gin.SetMode(gin.ReleaseMode)
	}
	router := gin.New()
	router.Use(gin.Logger(), gin.Recovery())
	router.Use(cors.New(cors.Config{
		AllowAllOrigins:  true,
		AllowMethods:     []string{"GET", "POST", "PATCH", "DELETE", "HEAD", "OPTIONS"},
		AllowHeaders:     []string{"Origin", "Content-Length", "Content-Type", "Authorization"},
		ExposeHeaders:    []string{"Content-Disposition"},
		AllowCredentials: false,
		MaxAge:           12 * time.Hour,
	}))
	router.Use(authChecker())
	return router
}

func initializeRoutes(router *gin.Engine) {
	router.GET("/ping", Ping)
	router.POST("/auth/login", LoginWithSentinel)
	router.POST("/auth/refresh", RefreshSession)
	router.POST("/auth/logout", Logout)

	authenticated := router.Group("")
	authenticated.Use(requireAuthenticatedUser())
	authenticated.GET("/auth/session", GetSession)
	authenticated.GET("/users/@me", GetCurrentUser)

	member := authenticated.Group("")
	member.Use(requireWorkbenchMember())
	member.GET("/targets", ListTargets)
	member.GET("/targets/:id/databases", ListTargetDatabases)
	member.GET("/targets/:id/catalog", GetCatalog)
	member.POST("/queries", ExecuteQuery)
	member.GET("/queries", ListQueryRuns)

	admin := authenticated.Group("")
	admin.Use(requireWorkbenchAdmin())
	admin.POST("/exports/preview", PreviewExport)
	admin.POST("/exports", ExportQuery)
	admin.POST("/targets", CreateTarget)
	admin.PATCH("/targets/:id", UpdateTarget)
	admin.DELETE("/targets/:id", DeleteTarget)
	admin.POST("/targets/:id/test", TestTarget)
	admin.POST("/targets/:id/imports", ImportCSV)
}

func authChecker() gin.HandlerFunc {
	return func(c *gin.Context) {
		authorization := c.GetHeader("Authorization")
		if !strings.HasPrefix(authorization, "Bearer ") {
			c.Next()
			return
		}
		token := strings.TrimSpace(strings.TrimPrefix(authorization, "Bearer "))
		claims, err := sentinel.ValidateToken(token)
		if err != nil {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "invalid access token"})
			return
		}
		setAuthContext(c, token, claims)
		c.Next()
	}
}

func requireAuthenticatedUser() gin.HandlerFunc {
	return func(c *gin.Context) {
		if getRequestToken(c) == "" || getRequestTokenUserID(c) == "" || !requestTokenHasAudience(c, config.SentinelClientID) {
			c.AbortWithStatusJSON(http.StatusUnauthorized, gin.H{"error": "a Workbench user session is required"})
			return
		}
		c.Next()
	}
}

const (
	ViewerGroupName = "WorkbenchViewers"
	AdminGroupName  = "WorkbenchAdmins"
)

func requireWorkbenchMember() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requestTokenHasGroup(c, ViewerGroupName) && !requestTokenHasGroup(c, AdminGroupName) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Workbench group membership is required"})
			return
		}
		c.Next()
	}
}

func requireWorkbenchAdmin() gin.HandlerFunc {
	return func(c *gin.Context) {
		if !requestTokenHasGroup(c, AdminGroupName) {
			c.AbortWithStatusJSON(http.StatusForbidden, gin.H{"error": "Workbench administrator access is required"})
			return
		}
		c.Next()
	}
}

func requestTokenHasGroup(c *gin.Context, expected string) bool {
	for _, group := range claimStringSlice(getRequestTokenClaims(c), "groups") {
		if group == expected {
			return true
		}
	}
	return false
}

func setAuthContext(c *gin.Context, token string, claims map[string]interface{}) {
	c.Set("Auth-Token", token)
	c.Set("Auth-Claims", claims)
	c.Set("Auth-EntityID", claimString(claims, "sub"))
	c.Set("Auth-UserID", claimString(claims, "user_id"))
	audiences := claimStringSlice(claims, "aud")
	if len(audiences) > 0 {
		c.Set("Auth-Audience", audiences[0])
	}
}

func getRequestToken(c *gin.Context) string {
	value, _ := c.Get("Auth-Token")
	return contextString(value)
}

func getRequestTokenClaims(c *gin.Context) map[string]interface{} {
	value, _ := c.Get("Auth-Claims")
	claims, _ := value.(map[string]interface{})
	return claims
}

func getRequestTokenEntityID(c *gin.Context) string {
	value, _ := c.Get("Auth-EntityID")
	return contextString(value)
}

func getRequestTokenUserID(c *gin.Context) string {
	value, _ := c.Get("Auth-UserID")
	return contextString(value)
}

func getRequestTokenAudience(c *gin.Context) string {
	value, _ := c.Get("Auth-Audience")
	return contextString(value)
}

func requestTokenHasAudience(c *gin.Context, expected string) bool {
	if expected == "" {
		return false
	}
	for _, audience := range claimStringSlice(getRequestTokenClaims(c), "aud") {
		if audience == expected {
			return true
		}
	}
	return false
}

func contextString(value interface{}) string {
	result, _ := value.(string)
	return result
}

func claimString(claims map[string]interface{}, key string) string {
	value, _ := claims[key].(string)
	return value
}

func claimStringSlice(claims map[string]interface{}, key string) []string {
	switch value := claims[key].(type) {
	case string:
		if value == "" {
			return []string{}
		}
		return []string{value}
	case []string:
		return value
	case []interface{}:
		result := make([]string, 0, len(value))
		for _, item := range value {
			if entry, ok := item.(string); ok {
				result = append(result, entry)
			}
		}
		return result
	default:
		return []string{}
	}
}

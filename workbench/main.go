package main

import (
	"github.com/gaucho-racing/workbench/workbench/api"
	"github.com/gaucho-racing/workbench/workbench/config"
	"github.com/gaucho-racing/workbench/workbench/database"
	"github.com/gaucho-racing/workbench/workbench/pkg/logger"
	"github.com/gaucho-racing/workbench/workbench/pkg/sentinel"
	"github.com/gaucho-racing/workbench/workbench/service"
)

func main() {
	logger.Init(config.IsProduction())
	defer logger.Logger.Sync()

	config.Verify()
	config.PrintStartupBanner()
	sentinel.InitializeKeys()
	database.Init()
	defer database.Close()
	service.InitializeConnectionManager()
	defer service.CloseConnectionManager()

	api.Run()
}

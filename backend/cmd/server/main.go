package main

import (
	"context"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"syscall"
	"time"

	"modern-webmail/backend/internal/api"
	"modern-webmail/backend/internal/api/handler"
	"modern-webmail/backend/internal/config"
	"modern-webmail/backend/internal/imap"
	"modern-webmail/backend/internal/session"
	"modern-webmail/backend/internal/smtp"
	"modern-webmail/backend/internal/storage"
)

var (
	// Version/BuildTime/CommitHash 由 build 時透過 -ldflags "-X main.Version=..." 注入，
	// 預設值用於本地/開發 build。
	Version    = "vdev"
	BuildTime  = "timeless"
	CommitHash = "sha-unknown"
)

func main() {
	port := os.Getenv("PORT")
	if port == "" {
		port = "8080"
	}

	dataDir := os.Getenv("DATA_DIR")
	if dataDir == "" {
		dataDir = "./data"
	}

	sessionTTL := 24 * time.Hour
	var keyBytes []byte
	if secret := os.Getenv("SESSION_SECRET"); secret != "" {
		keyBytes = []byte(secret)
	}

	sessionStore, err := session.NewMemoryStore(sessionTTL, keyBytes)
	if err != nil {
		log.Fatalf("Failed to initialize session store: %v", err)
	}

	serverConfig := config.Load()

	poolManager := imap.NewPoolManager()
	idleManager := imap.NewIdleManager()
	smtpSender := smtp.NewSender()

	store, err := storage.NewSQLiteStore(dataDir)
	if err != nil {
		log.Fatalf("Failed to initialize storage: %v", err)
	}
	defer func() { _ = store.Close() }()

	if migrated, err := store.MigrateLegacyKeyrings(dataDir); err != nil {
		log.Printf("⚠️  Legacy keyring migration error: %v", err)
	} else if migrated > 0 {
		log.Printf("📦 Migrated %d legacy keyring file(s) into SQLite", migrated)
	}

	authHandler := handler.NewAuthHandler(sessionStore, store, poolManager, idleManager)
	mailHandler := handler.NewMailHandler(poolManager, smtpSender)
	eventsHandler := handler.NewEventsHandler(idleManager)
	pgpHandler := handler.NewPGPHandler(store)
	contactsHandler := handler.NewContactsHandler(store)
	configHandler := handler.NewServerConfigHandler(serverConfig)

	router := api.NewRouter(authHandler, mailHandler, eventsHandler, pgpHandler, contactsHandler, configHandler, sessionStore)

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Printf("📦 Modern Webmail Backend %s (commit %s, built %s)", Version, CommitHash, BuildTime)
		log.Printf("🚀 Modern Webmail Backend running on http://localhost:%s", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down Modern Webmail Backend...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server forced shutdown: %v", err)
	}

	poolManager.CloseAll()
	log.Println("Server exited cleanly.")
}

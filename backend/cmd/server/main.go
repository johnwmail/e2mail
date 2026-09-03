package main

import (
	"context"
	"encoding/base64"
	"encoding/hex"
	"errors"
	"log"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/johnwmail/e2mail/backend/internal/api"
	"github.com/johnwmail/e2mail/backend/internal/api/handler"
	"github.com/johnwmail/e2mail/backend/internal/config"
	"github.com/johnwmail/e2mail/backend/internal/imap"
	ldapint "github.com/johnwmail/e2mail/backend/internal/ldap"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/internal/smtp"
	"github.com/johnwmail/e2mail/backend/internal/storage"
)

var (
	// Version/BuildTime/CommitHash 由 build 時透過 -ldflags "-X main.Version=..." 注入，
	// 預設值用於本地/開發 build。
	Version    = "vdev"
	BuildTime  = "timeless"
	CommitHash = "sha-unknown"
)

// sensitiveEnvVars 唔會 print 出嚟嘅敏感/機密環境變數
var sensitiveEnvVars = map[string]bool{
	"SESSION_SECRET":  true,
	"SECRET_KEY":      true,
	"DOCKER_PASSWORD": true,
	"LDAP_ROOT_PW":    true,
}

// printDefinedEnv 啟動時打印所有已定義嘅環境變數（過濾敏感 key）
func printDefinedEnv() {
	log.Println("📋 Defined environment variables:")
	for _, kv := range os.Environ() {
		idx := strings.Index(kv, "=")
		if idx <= 0 {
			continue
		}
		key := kv[:idx]
		if sensitiveEnvVars[strings.ToUpper(key)] {
			continue
		}
		val := kv[idx+1:]
		if val == "" {
			log.Printf("   %s=<empty>", key)
		} else {
			log.Printf("   %s=%q", key, val)
		}
	}
}

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
	if v := strings.TrimSpace(os.Getenv("SESSION_TTL_HOURS")); v != "" {
		if hours, err := strconv.Atoi(v); err == nil && hours > 0 {
			sessionTTL = time.Duration(hours) * time.Hour
		} else {
			log.Printf("⚠️  Invalid SESSION_TTL_HOURS=%q, using default 24h", v)
		}
	}
	// Session 記憶體加密 key：若 SESSION_SECRET 有設則用佢（多實例部署固定 key），
	// 否則永遠隨機生成（每-boot），確保 RAM 內敏感資料唔會被跨 restart 解密。
	var keyBytes []byte
	if v := strings.TrimSpace(os.Getenv("SESSION_SECRET")); v != "" {
		if kb, ok := parseSessionSecret(v); ok {
			keyBytes = kb
			log.Printf("🔑 Using SESSION_SECRET from env (32 bytes)")
		} else {
			log.Printf("⚠️  Invalid SESSION_SECRET (expected 32-byte raw, 44-char base64, or 64-char hex), generating random key")
		}
	}

	printDefinedEnv()
	log.Printf("⏰ Session TTL: %s", sessionTTL)

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

	authHandler := handler.NewAuthHandler(sessionStore, store, poolManager, idleManager, serverConfig, sessionTTL)
	if serverConfig.LDAP.Ready() {
		authHandler.SetPasswordChanger(ldapint.New(*serverConfig.LDAP))
		log.Printf("🔐 LDAP change-password enabled (url: %s)", serverConfig.LDAP.URL)
	} else if serverConfig.LDAP.Enabled {
		log.Printf("⚠️  LDAP_ENABLED=true 但設定不完整（LDAP_URL / LDAP_ROOT_DN / LDAP_ROOT_PW / LDAP_USER_DN_TEMPLATE），change-password 保持停用")
	}
	mailHandler := handler.NewMailHandler(poolManager, smtpSender)
	eventsHandler := handler.NewEventsHandler(idleManager)
	pgpHandler := handler.NewPGPHandler(store)
	contactsHandler := handler.NewContactsHandler(store)
	addressContactsHandler := handler.NewAddressContactsHandler(store, dataDir)
	prefsHandler := handler.NewPrefsHandler(store)
	configHandler := handler.NewServerConfigHandler(serverConfig)
	accountsHandler := handler.NewAccountsHandler(sessionStore, store, poolManager, idleManager, serverConfig)
	sieveHandler := handler.NewSieveHandler(store, serverConfig)

	router := api.NewRouter(authHandler, mailHandler, eventsHandler, pgpHandler, contactsHandler, addressContactsHandler, prefsHandler, configHandler, accountsHandler, sieveHandler, sessionStore)

	server := &http.Server{
		Addr:         ":" + port,
		Handler:      router,
		ReadTimeout:  30 * time.Second,
		WriteTimeout: 60 * time.Second,
		IdleTimeout:  120 * time.Second,
	}

	go func() {
		log.Printf("📦 e2Mail Backend %s (commit %s, built %s)", Version, CommitHash, BuildTime)
		log.Printf("🚀 e2Mail Backend running on http://localhost:%s", port)
		if err := server.ListenAndServe(); err != nil && !errors.Is(err, http.ErrServerClosed) {
			log.Fatalf("HTTP server error: %v", err)
		}
	}()

	quit := make(chan os.Signal, 1)
	signal.Notify(quit, os.Interrupt, syscall.SIGTERM)
	<-quit
	log.Println("Shutting down e2Mail Backend...")

	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()

	if err := server.Shutdown(ctx); err != nil {
		log.Printf("Server forced shutdown: %v", err)
	}

	poolManager.CloseAll()
	log.Println("Server exited cleanly.")
}

// parseSessionSecret 解析 SESSION_SECRET 支援多種格式：
// - 32-byte raw string
// - base64 standard / raw / url (32 bytes after decode)
// - hex 64 chars (32 bytes)
func parseSessionSecret(v string) ([]byte, bool) {
	if len(v) == 32 {
		return []byte(v), true
	}
	if len(v) == 64 {
		if decoded, err := hex.DecodeString(v); err == nil && len(decoded) == 32 {
			return decoded, true
		}
	}
	for _, dec := range []func(string) ([]byte, error){
		base64.StdEncoding.DecodeString,
		base64.RawStdEncoding.DecodeString,
		base64.URLEncoding.DecodeString,
		base64.RawURLEncoding.DecodeString,
	} {
		if decoded, err := dec(v); err == nil && len(decoded) == 32 {
			return decoded, true
		}
	}
	return nil, false
}

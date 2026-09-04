package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"github.com/johnwmail/e2mail/backend/internal/api/handler"
	"github.com/johnwmail/e2mail/backend/internal/api/middleware"
	"github.com/johnwmail/e2mail/backend/internal/session"
	"github.com/johnwmail/e2mail/backend/pkg/response"
)

// NewRouter 建構並配置所有 HTTP 路由與中間件
func NewRouter(
	authH *handler.AuthHandler,
	mailH *handler.MailHandler,
	eventsH *handler.EventsHandler,
	pgpH *handler.PGPHandler,
	contactsH *handler.ContactsHandler,
	addressH *handler.AddressContactsHandler,
	prefsH *handler.PrefsHandler,
	configH *handler.ServerConfigHandler,
	accountsH *handler.AccountsHandler,
	sieveH *handler.SieveHandler,
	store session.Store,
) http.Handler {
	r := chi.NewRouter()

	// 全域中間件
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP) //nolint:staticcheck // RealIP deprecated in chi v5.2.1+, but still needed for X-Forwarded-For behind OpenBSD httpd reverse proxy
	r.Use(chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.CORS())
	r.Use(middleware.SecurityHeaders)

	// 健康檢查端點
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		response.Success(w, map[string]string{"status": "healthy", "service": "e2mail-backend"})
	})

	// /api 路由群組
	r.Route("/api", func(api chi.Router) {
		// 公開認證端點
		api.Post("/auth/login", authH.Login)
		api.Post("/auth/verify-2fa", authH.Verify2FA)

		// 公開伺服器預設值（無需登入，登入頁面預填用）
		api.Get("/server-config", configH.Get)

		// 需驗證會話之受保護端點
		api.Group(func(protected chi.Router) {
			protected.Use(middleware.Auth(store))

			// 會話與使用者狀態
			protected.Post("/auth/logout", authH.Logout)
			protected.Get("/auth/me", authH.Me)
			protected.Post("/auth/change-password", authH.ChangePassword)

			// 兩步驟驗證 (2FA) 管理
			protected.Get("/2fa/status", authH.TwoFAStatus)
			protected.Post("/2fa/setup", authH.TwoFASetup)
			protected.Post("/2fa/enable", authH.TwoFAEnable)
			protected.Post("/2fa/disable", authH.TwoFADisable)
			protected.Post("/2fa/regenerate-backup-codes", authH.TwoFARegenerateBackupCodes)

			// 即時事件推播 (SSE)
			protected.Get("/events", eventsH.SSE)

			// 帳號管理（multi-account）
			protected.Route("/accounts", func(accounts chi.Router) {
				accounts.Get("/", accountsH.ListAccounts)
				accounts.Post("/", accountsH.CreateAccount)
				accounts.Post("/test", accountsH.TestAccount)
				accounts.Post("/{id}/ensure-junk-folder", accountsH.EnsureJunkFolder)
				accounts.Put("/{id}", accountsH.UpdateAccount)
				accounts.Delete("/{id}", accountsH.DeleteAccount)
				accounts.Post("/{id}/default", accountsH.SetDefaultAccount)
				accounts.Get("/{id}/folders", mailH.ListFolders)
				accounts.Get("/{id}/folders/prefs", accountsH.GetFolderPrefs)
				accounts.Put("/{id}/folders/prefs", accountsH.SetFolderPref)
				accounts.Get("/{id}/folders/order", accountsH.GetFolderOrder)
				accounts.Put("/{id}/folders/order", accountsH.SetFolderOrder)
			})

			// Onboarding 完成度（2FA + PGP）
			protected.Get("/onboarding/status", accountsH.OnboardingStatus)

			// 郵件與資料夾管理
			protected.Route("/mail", func(mail chi.Router) {
				mail.Get("/folders", mailH.ListFolders)
				mail.Get("/messages", mailH.ListMessages)
				mail.Get("/unread", mailH.ListUnreadMessages)
				mail.Get("/messages/{uid}", mailH.GetMessageDetail)
				mail.Get("/messages/{uid}/raw", mailH.GetRawMessage)
				mail.Get("/messages/{uid}/attachments/{attId}", mailH.DownloadAttachment)
				mail.Post("/messages/flags", mailH.SetFlags)
				mail.Post("/messages/move", mailH.MoveMessages)
				mail.Post("/messages/delete", mailH.DeleteMessages)
				mail.Post("/messages/empty", mailH.EmptyFolder)
				mail.Post("/send", mailH.SendMessage)
				mail.Post("/drafts", mailH.SaveDraft)
			})

			// PGP 雲端加密金鑰庫同步
			protected.Route("/pgp", func(pgp chi.Router) {
				pgp.Get("/keyring", pgpH.GetKeyring)
				pgp.Post("/keyring", pgpH.SaveKeyring)
				pgp.Delete("/keyring", pgpH.DeleteKeyring)

				// 聯絡人公鑰庫（per-user，伺服器端 SQLite 儲存）
				pgp.Get("/contacts", contactsH.ListContacts)
				pgp.Post("/contacts", contactsH.UpsertContact)
				pgp.Post("/contacts/bulk", contactsH.BulkUpsertContacts)
				pgp.Post("/contacts/import", contactsH.ImportContacts)
				pgp.Delete("/contacts/{email}", contactsH.DeleteContact)
			})

			// 通用通訊錄（地址簿，sqlite contacts 表，支援頭像）
			protected.Route("/contacts", func(ab chi.Router) {
				ab.Get("/", addressH.ListAddressContacts)
				ab.Get("/resolve", addressH.Resolve)
				ab.Get("/export", addressH.Export)
				ab.Post("/import", addressH.Import)
				ab.Post("/", addressH.CreateAddressContact)
				ab.Post("/from-email", addressH.CreateFromEmail)
				ab.Get("/{id}", addressH.GetAddressContact)
				ab.Put("/{id}", addressH.UpdateAddressContact)
				ab.Delete("/{id}", addressH.DeleteAddressContact)
				ab.Get("/{id}/avatar", addressH.GetAvatar)
				ab.Put("/{id}/avatar", addressH.PutAvatar)
				ab.Delete("/{id}/avatar", addressH.DeleteAvatar)
			})

			// per-user 設定（key-value）
			protected.Route("/prefs", func(prefs chi.Router) {
				prefs.Get("/{key}", prefsH.GetPref)
				prefs.Put("/{key}", prefsH.SetPref)
			})

			// ManageSieve 過濾器管理（每帳號獨立，Dovecot Pigeonhole）
			protected.Route("/sieve", func(sieve chi.Router) {
				sieve.Get("/capability", sieveH.Capability)
				sieve.Get("/scripts", sieveH.ListScripts)
				sieve.Get("/scripts/{name}", sieveH.GetScript)
				sieve.Put("/scripts/{name}", sieveH.PutScript)
				sieve.Delete("/scripts/{name}", sieveH.DeleteScript)
				sieve.Post("/scripts/{name}/activate", sieveH.SetActive)
				sieve.Post("/scripts/deactivate", sieveH.Deactivate)
				sieve.Post("/check", sieveH.CheckScript)
			})
		})
	})

	// SPA static（embedded frontend）— 未匹配的請求一律由前端接手
	r.NotFound(staticHandler())

	return r
}

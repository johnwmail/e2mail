package api

import (
	"net/http"

	"github.com/go-chi/chi/v5"
	chimiddleware "github.com/go-chi/chi/v5/middleware"
	"modern-webmail/backend/internal/api/handler"
	"modern-webmail/backend/internal/api/middleware"
	"modern-webmail/backend/internal/session"
	"modern-webmail/backend/pkg/response"
)

// NewRouter 建構並配置所有 HTTP 路由與中間件
func NewRouter(
	authH *handler.AuthHandler,
	mailH *handler.MailHandler,
	eventsH *handler.EventsHandler,
	pgpH *handler.PGPHandler,
	contactsH *handler.ContactsHandler,
	configH *handler.ServerConfigHandler,
	store session.Store,
) http.Handler {
	r := chi.NewRouter()

	// 全域中間件
	r.Use(chimiddleware.RequestID)
	r.Use(chimiddleware.RealIP)
	r.Use(chimiddleware.Logger)
	r.Use(chimiddleware.Recoverer)
	r.Use(middleware.CORS())
	r.Use(middleware.SecurityHeaders)

	// 健康檢查端點
	r.Get("/health", func(w http.ResponseWriter, r *http.Request) {
		response.Success(w, map[string]string{"status": "healthy", "service": "modern-webmail-backend"})
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

			// 兩步驟驗證 (2FA) 管理
			protected.Get("/2fa/status", authH.TwoFAStatus)
			protected.Post("/2fa/setup", authH.TwoFASetup)
			protected.Post("/2fa/enable", authH.TwoFAEnable)
			protected.Post("/2fa/disable", authH.TwoFADisable)
			protected.Post("/2fa/regenerate-backup-codes", authH.TwoFARegenerateBackupCodes)

			// 即時事件推播 (SSE)
			protected.Get("/events", eventsH.SSE)

			// 郵件與資料夾管理
			protected.Route("/mail", func(mail chi.Router) {
				mail.Get("/folders", mailH.ListFolders)
				mail.Get("/messages", mailH.ListMessages)
				mail.Get("/messages/{uid}", mailH.GetMessageDetail)
				mail.Get("/messages/{uid}/attachments/{attId}", mailH.DownloadAttachment)
				mail.Post("/messages/flags", mailH.SetFlags)
				mail.Post("/messages/move", mailH.MoveMessages)
				mail.Post("/messages/delete", mailH.DeleteMessages)
				mail.Post("/send", mailH.SendMessage)
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
		})
	})

	// SPA static（embedded frontend）— 未匹配的請求一律由前端接手
	r.NotFound(staticHandler())

	return r
}

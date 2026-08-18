package response

import (
	"encoding/json"
	"net/http"
)

// StandardResponse 定義通用 API JSON 回應格式
type StandardResponse struct {
	Success bool   `json:"success"`
	Data    any    `json:"data,omitempty"`
	Error   string `json:"error,omitempty"`
}

// JSON 輸出自訂狀態碼與資料結構
func JSON(w http.ResponseWriter, statusCode int, payload any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(statusCode)
	_ = json.NewEncoder(w).Encode(payload)
}

// Success 輸出 200 OK 成功回應
func Success(w http.ResponseWriter, data any) {
	JSON(w, http.StatusOK, StandardResponse{
		Success: true,
		Data:    data,
	})
}

// Created 輸出 201 Created 成功回應
func Created(w http.ResponseWriter, data any) {
	JSON(w, http.StatusCreated, StandardResponse{
		Success: true,
		Data:    data,
	})
}

// Error 輸出錯誤訊息與自訂狀態碼
func Error(w http.ResponseWriter, statusCode int, message string) {
	JSON(w, statusCode, StandardResponse{
		Success: false,
		Error:   message,
	})
}

// BadRequest 輸出 400 Bad Request
func BadRequest(w http.ResponseWriter, message string) {
	Error(w, http.StatusBadRequest, message)
}

// Unauthorized 輸出 401 Unauthorized
func Unauthorized(w http.ResponseWriter, message string) {
	Error(w, http.StatusUnauthorized, message)
}

// Forbidden 輸出 403 Forbidden
func Forbidden(w http.ResponseWriter, message string) {
	Error(w, http.StatusForbidden, message)
}

// NotFound 輸出 404 Not Found
func NotFound(w http.ResponseWriter, message string) {
	Error(w, http.StatusNotFound, message)
}

// InternalServerError 輸出 500 Internal Server Error
func InternalServerError(w http.ResponseWriter, message string) {
	Error(w, http.StatusInternalServerError, message)
}

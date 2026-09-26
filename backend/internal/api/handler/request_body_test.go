package handler

import (
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRespondBodyParseErrorMapsLimitTo413(t *testing.T) {
	rec := httptest.NewRecorder()
	respondBodyParseError(rec, &http.MaxBytesError{Limit: 1024}, "invalid request body")
	if rec.Code != http.StatusRequestEntityTooLarge {
		t.Fatalf("status = %d, want %d", rec.Code, http.StatusRequestEntityTooLarge)
	}
}

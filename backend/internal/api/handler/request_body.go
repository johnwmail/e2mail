package handler

import (
	"errors"
	"net/http"

	"github.com/johnwmail/e2mail/backend/pkg/response"
)

func respondBodyParseError(w http.ResponseWriter, err error, message string) {
	var maxErr *http.MaxBytesError
	if errors.As(err, &maxErr) {
		response.Error(w, http.StatusRequestEntityTooLarge, "request body too large")
		return
	}
	response.BadRequest(w, message)
}

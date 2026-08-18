package response

import (
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func invoke(handler func(w http.ResponseWriter, r *http.Request)) *httptest.ResponseRecorder {
	w := httptest.NewRecorder()
	handler(w, httptest.NewRequest(http.MethodGet, "/", nil))
	return w
}

func decodeBody(t *testing.T, w *httptest.ResponseRecorder) StandardResponse {
	t.Helper()
	var body StandardResponse
	if err := json.Unmarshal(w.Body.Bytes(), &body); err != nil {
		t.Fatalf("invalid JSON body %q: %v", w.Body.String(), err)
	}
	return body
}

func TestSuccess(t *testing.T) {
	w := invoke(func(w http.ResponseWriter, r *http.Request) {
		Success(w, map[string]string{"a": "b"})
	})
	if w.Code != http.StatusOK {
		t.Fatalf("status = %d, want 200", w.Code)
	}
	if ct := w.Header().Get("Content-Type"); ct != "application/json; charset=utf-8" {
		t.Fatalf("Content-Type = %q", ct)
	}
	body := decodeBody(t, w)
	if !body.Success {
		t.Fatal("expected success = true")
	}
	if body.Data == nil {
		t.Fatal("expected data to be present")
	}
}

func TestCreated(t *testing.T) {
	w := invoke(func(w http.ResponseWriter, r *http.Request) {
		Created(w, map[string]string{"id": "1"})
	})
	if w.Code != http.StatusCreated {
		t.Fatalf("status = %d, want 201", w.Code)
	}
	if !decodeBody(t, w).Success {
		t.Fatal("expected success = true")
	}
}

func TestErrorStatusHelpers(t *testing.T) {
	cases := []struct {
		name string
		fn   func(w http.ResponseWriter, msg string)
		want int
	}{
		{"BadRequest", BadRequest, http.StatusBadRequest},
		{"Unauthorized", Unauthorized, http.StatusUnauthorized},
		{"Forbidden", Forbidden, http.StatusForbidden},
		{"NotFound", NotFound, http.StatusNotFound},
		{"InternalServerError", InternalServerError, http.StatusInternalServerError},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			w := invoke(func(w http.ResponseWriter, r *http.Request) {
				c.fn(w, "boom")
			})
			if w.Code != c.want {
				t.Fatalf("status = %d, want %d", w.Code, c.want)
			}
			body := decodeBody(t, w)
			if body.Success {
				t.Fatal("expected success = false")
			}
			if body.Error != "boom" {
				t.Fatalf("error = %q, want boom", body.Error)
			}
			if body.Data != nil {
				t.Fatal("expected no data on error")
			}
		})
	}
}

func TestError(t *testing.T) {
	w := invoke(func(w http.ResponseWriter, r *http.Request) {
		Error(w, http.StatusTeapot, "custom")
	})
	if w.Code != http.StatusTeapot {
		t.Fatalf("status = %d, want 418", w.Code)
	}
	body := decodeBody(t, w)
	if body.Success || body.Error != "custom" {
		t.Fatalf("unexpected body: %+v", body)
	}
}
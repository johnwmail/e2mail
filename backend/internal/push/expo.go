package push

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
)

const expoPushURL = "https://exp.host/--/api/v2/push/send"

// Message 一則推播（Expo Push API / FCM-via-Expo）。
type Message struct {
	To               string            `json:"to"`
	Title            string            `json:"title,omitempty"`
	Body             string            `json:"body,omitempty"`
	Sound            string            `json:"sound,omitempty"`
	Badge            int               `json:"badge,omitempty"`
	ChannelID        string            `json:"channelId,omitempty"`
	ContentAvailable bool              `json:"_contentAvailable,omitempty"`
	Data             map[string]string `json:"data,omitempty"`
}

// Sender 發送推播。
type Sender interface {
	Send(messages []Message) error
}

// ExpoSender 經 Expo Push API 轉發 APNs/FCM（ExponentPushToken[…]）。
type ExpoSender struct {
	AccessToken string
	HTTP        *http.Client
	URL         string
}

func NewExpoSender(accessToken string) *ExpoSender {
	return &ExpoSender{
		AccessToken: accessToken,
		HTTP:        &http.Client{Timeout: 15 * time.Second},
		URL:         expoPushURL,
	}
}

func (s *ExpoSender) Send(messages []Message) error {
	if len(messages) == 0 {
		return nil
	}
	filtered := make([]Message, 0, len(messages))
	for _, m := range messages {
		if strings.HasPrefix(m.To, "ExponentPushToken[") || strings.HasPrefix(m.To, "ExpoPushToken[") {
			filtered = append(filtered, m)
		}
	}
	if len(filtered) == 0 {
		return nil
	}
	body, err := json.Marshal(filtered)
	if err != nil {
		return err
	}
	url := s.URL
	if url == "" {
		url = expoPushURL
	}
	req, err := http.NewRequest(http.MethodPost, url, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("Accept", "application/json")
	if s.AccessToken != "" {
		req.Header.Set("Authorization", "Bearer "+s.AccessToken)
	}
	client := s.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	resp, err := client.Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = resp.Body.Close() }()
	raw, _ := io.ReadAll(io.LimitReader(resp.Body, 1<<20))
	if resp.StatusCode >= 400 {
		return fmt.Errorf("expo push http %d: %s", resp.StatusCode, strings.TrimSpace(string(raw)))
	}
	return nil
}

// NopSender 測試用／未設定憑證時唔出網。
type NopSender struct{}

func (NopSender) Send([]Message) error { return nil }

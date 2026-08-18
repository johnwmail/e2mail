FROM golang:1.25-alpine AS builder

WORKDIR /app

# 複製原始碼與模組定義
COPY . .

# 自動下載依賴並生成完整的 go.sum
RUN go mod tidy

# 編譯靜態二進位執行檔
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w" -o server cmd/server/main.go

FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /root/
COPY --from=builder /app/server .

ENV PORT=8080
EXPOSE 8080

CMD ["./server"]

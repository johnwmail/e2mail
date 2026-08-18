# ============================================================
# Stage 1: 編譯 frontend（Vite build，產出 dist/）
# ============================================================
FROM node:20-alpine AS frontend-builder

ARG VERSION=vdev
ARG BUILD_TIME=timeless
ARG COMMIT_HASH=sha-unknown
ENV VITE_APP_VERSION=$VERSION
ENV VITE_APP_BUILD_TIME=$BUILD_TIME
ENV VITE_APP_COMMIT_HASH=$COMMIT_HASH

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm install

COPY frontend/ .
RUN npm run build

# ============================================================
# Stage 2: 編譯 backend（將 frontend dist embed 入 binary）
# ============================================================
FROM golang:1.25-alpine AS backend-builder

ARG VERSION=vdev
ARG BUILD_TIME=timeless
ARG COMMIT_HASH=sha-unknown

WORKDIR /app
COPY backend/ .
COPY --from=frontend-builder /app/dist ./web/dist
RUN go mod tidy

RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w -X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -X main.CommitHash=${COMMIT_HASH}" -o server cmd/server/main.go

# ============================================================
# Stage 3: 執行環境
# ============================================================
FROM alpine:latest
RUN apk --no-cache add ca-certificates tzdata
WORKDIR /root/
COPY --from=backend-builder /app/server .

ENV PORT=8080
EXPOSE 8080

CMD ["./server"]
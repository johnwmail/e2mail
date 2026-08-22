# ============================================================
# Stage 1: 編譯 frontend（Vite build，產出 dist/）
# ============================================================
FROM node:24-alpine AS frontend-builder

ARG VERSION=vdev
ARG BUILD_TIME=timeless
ARG COMMIT_HASH=sha-unknown
ENV VITE_APP_VERSION=$VERSION
ENV VITE_APP_BUILD_TIME=$BUILD_TIME
ENV VITE_APP_COMMIT_HASH=$COMMIT_HASH

WORKDIR /app
COPY frontend/package.json frontend/package-lock.json* ./
RUN npm ci

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

# Pre-create /data owned by uid/gid 8080 so a fresh named volume inherits
# writable ownership (Docker creates root-owned volumes otherwise).
RUN mkdir -p /data && chown 8080:8080 /data

# ============================================================
# Stage 3: 執行環境（distroless/static，以非 root uid/gid 8080 執行）
# ============================================================
FROM gcr.io/distroless/static:latest

WORKDIR /app
COPY --from=backend-builder --chown=8080:8080 /app/server /app/server
# /data 已預設 uid/gid 8080；fresh named volume 會繼承此權限。
# 注意：已存在的 volume 仍是 root 持有，需一次性 chown。
COPY --from=backend-builder --chown=8080:8080 /data /data

USER 8080:8080
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

CMD ["/app/server"]
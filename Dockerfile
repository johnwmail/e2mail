# ============================================================
# Stage 1: 編譯 frontend（Vite build，產出 dist/）
# ============================================================
# Base images are pinned by digest; Dependabot (docker ecosystem) updates them.
FROM node:24-alpine@sha256:116b800c3754b440ee0aa3ed2f20f5bf3d99a554bfd9adeea09ea8017f6e85f5 AS frontend-builder

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
FROM golang:1.27-alpine@sha256:70bd7ddea8b6cbe5d6943cde279d6b67feb10cc924fb9100d1d8757c1575b280 AS backend-builder

ARG VERSION=vdev
ARG BUILD_TIME=timeless
ARG COMMIT_HASH=sha-unknown

WORKDIR /app
COPY backend/ .
COPY --from=frontend-builder /app/dist ./web/dist

# Build strictly from the committed go.mod/go.sum (no `go mod tidy`). Running
# tidy here could silently change dependency versions away from what was tested.
RUN CGO_ENABLED=0 GOOS=linux go build -ldflags="-s -w -X main.Version=${VERSION} -X main.BuildTime=${BUILD_TIME} -X main.CommitHash=${COMMIT_HASH}" -o server ./cmd/server

# Pre-create /data owned by uid/gid 8080 so a fresh named volume inherits
# writable ownership (Docker creates root-owned volumes otherwise).
RUN mkdir -p /data && chown 8080:8080 /data

# ============================================================
# Stage 3: 執行環境（distroless/static，以非 root uid/gid 8080 執行）
# ============================================================
FROM gcr.io/distroless/static:latest@sha256:4c2cd1dee442c9a99924a378c7c126fac8fef14771579ef567c3f2bdd7a5122a

WORKDIR /app
COPY --from=backend-builder /app/server /app/server
# /data 已預設 uid/gid 8080；fresh named volume 會繼承此權限。
# 注意：已存在的 volume 仍是 root 持有，需一次性 chown。
COPY --from=backend-builder --chown=8080:8080 /data /data

USER 8080:8080
ENV PORT=8080
ENV DATA_DIR=/data
EXPOSE 8080

CMD ["/app/server"]
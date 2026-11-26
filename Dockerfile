# ============================================================
# Stage 1: 編譯 frontend（Vite build，產出 dist/）
# ============================================================
# Base images are pinned by digest; Dependabot (docker ecosystem) updates them.
FROM node:25-alpine@sha256:bdf2cca6fe3dabd014ea60163eca3f0f7015fbd5c7ee1b0e9ccb4ced6eb02ef4 AS frontend-builder

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
# Keep this aligned with the `go` directive in backend/go.mod: the release
# workflow builds binaries with exactly that toolchain (`go-version-file`), so a
# newer image here would ship container binaries built by a different Go.
FROM golang:1.26-alpine@sha256:ecb67f987aa1a57794c91d19ade7ae0209f2f0f5496aaef9e6ae85ddf92d02ab AS backend-builder

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
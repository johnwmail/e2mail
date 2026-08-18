package web

import "embed"

// Files 內嵌 frontend build 產物（dist/）。
// Dockerfile 的 node stage 會將 frontend dist 複製到 web/dist 再編譯；
// 本地開發時 dist 只有 .gitkeep，static handler 會退化成 404。
//
//go:embed all:dist
var Files embed.FS
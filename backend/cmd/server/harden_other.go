//go:build !openbsd

package main

// hardenProcess is a no-op on platforms without unveil(2)/pledge(2).
// OpenBSD support lives in harden_openbsd.go; see docs/OPENBSD.md.
func hardenProcess(string) {}

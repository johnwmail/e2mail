//go:build openbsd

package main

import (
	"log"
	"os"
	"strings"

	"golang.org/x/sys/unix"
)

// defaultPledgePromises is the set the e2Mail server needs after startup:
//
//	stdio   basic I/O + kqueue (Go runtime/netpoller)
//	rpath   read files (SQLite DB, TLS roots)
//	wpath   write files (SQLite DB/WAL, backups)
//	cpath   create/remove files (SQLite journal, backup temp)
//	inet    TCP sockets (HTTP listen, IMAP/SMTP/Sieve/LDAP out)
//	dns     resolver (/etc/resolv.conf, /etc/hosts)
//	flock   SQLite advisory file locking
//	fattr   chmod/chown (data dir + files)
//	tmppath mkstemp-style temp files
const defaultPledgePromises = "stdio rpath wpath cpath inet dns flock fattr tmppath"

// hardenProcess applies OpenBSD unveil(2) + pledge(2). It is **opt-in** via
// OPENBSD_HARDEN so a too-narrow path/promise set cannot kill the daemon on a
// deployment that has not been tuned yet. Overrides:
//
//	OPENBSD_HARDEN=1         enable
//	OPENBSD_PLEDGE="..."     replace the promise set
//	OPENBSD_UNVEIL_EXTRA="p1,p2"  extra paths, unveiled "rwc"
//
// See docs/OPENBSD.md.
func hardenProcess(dataDir string) {
	if !envTruthy("OPENBSD_HARDEN") {
		return
	}

	// unveil(2) needs the path to exist to be resolved reliably.
	if err := os.MkdirAll(dataDir, 0700); err != nil {
		log.Printf("[HARDEN] mkdir %s failed: %v", dataDir, err)
	}

	unveil := func(path, perms string) {
		if err := unix.Unveil(path, perms); err != nil {
			log.Printf("[HARDEN] unveil %q %q: %v", path, perms, err)
		}
	}
	unveil(dataDir, "rwc")
	unveil("/etc/ssl", "r")         // TLS root CA (/etc/ssl/cert.pem)
	unveil("/etc/resolv.conf", "r") // DNS
	unveil("/etc/hosts", "r")       // DNS
	unveil("/etc/localtime", "r")   // log timestamps / time.Local
	unveil("/usr/share/zoneinfo", "r")
	unveil("/tmp", "rwc") // temp files
	unveil("/dev/null", "rw")
	for _, extra := range splitList(os.Getenv("OPENBSD_UNVEIL_EXTRA")) {
		unveil(extra, "rwc")
	}

	if err := unix.UnveilBlock(); err != nil {
		log.Printf("[HARDEN] unveil block failed: %v", err)
		return
	}

	promises := strings.TrimSpace(os.Getenv("OPENBSD_PLEDGE"))
	if promises == "" {
		promises = defaultPledgePromises
	}
	if err := unix.Pledge(promises, ""); err != nil {
		log.Printf("[HARDEN] pledge %q failed: %v", promises, err)
		return
	}
	log.Printf("[HARDEN] openbsd unveil+pledge applied (promises=%q)", promises)
}

func envTruthy(name string) bool {
	switch strings.ToLower(strings.TrimSpace(os.Getenv(name))) {
	case "1", "true", "yes", "on":
		return true
	default:
		return false
	}
}

func splitList(s string) []string {
	var out []string
	for _, p := range strings.Split(s, ",") {
		if p = strings.TrimSpace(p); p != "" {
			out = append(out, p)
		}
	}
	return out
}

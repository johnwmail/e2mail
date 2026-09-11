package push

import (
	"strconv"
	"strings"
	"time"
)

// InQuietHours 判斷 now（已轉去 loc）是否落喺 start–end（HH:MM）。
// 空 start/end 視為無靜音。若 start >= end，當跨日（例如 22:00–07:00）。
func InQuietHours(now time.Time, loc *time.Location, start, end string) bool {
	if loc == nil {
		loc = time.UTC
	}
	startMin, ok1 := parseHHMM(start)
	endMin, ok2 := parseHHMM(end)
	if !ok1 || !ok2 {
		return false
	}
	t := now.In(loc)
	cur := t.Hour()*60 + t.Minute()
	if startMin == endMin {
		return false
	}
	if startMin < endMin {
		return cur >= startMin && cur < endMin
	}
	return cur >= startMin || cur < endMin
}

func parseHHMM(s string) (int, bool) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, false
	}
	parts := strings.Split(s, ":")
	if len(parts) != 2 {
		return 0, false
	}
	h, err1 := strconv.Atoi(parts[0])
	m, err2 := strconv.Atoi(parts[1])
	if err1 != nil || err2 != nil || h < 0 || h > 23 || m < 0 || m > 59 {
		return 0, false
	}
	return h*60 + m, true
}

func loadLocation(name string) *time.Location {
	name = strings.TrimSpace(name)
	if name == "" {
		return time.UTC
	}
	loc, err := time.LoadLocation(name)
	if err != nil {
		return time.UTC
	}
	return loc
}

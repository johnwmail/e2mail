package push

import (
	"testing"
	"time"
)

func TestInQuietHoursOvernight(t *testing.T) {
	loc := time.FixedZone("HKT", 8*3600)
	now := time.Date(2026, 9, 11, 23, 30, 0, 0, loc)
	if !InQuietHours(now, loc, "22:00", "07:00") {
		t.Fatal("23:30 should be quiet")
	}
	morning := time.Date(2026, 9, 11, 8, 0, 0, 0, loc)
	if InQuietHours(morning, loc, "22:00", "07:00") {
		t.Fatal("08:00 should not be quiet")
	}
	dawn := time.Date(2026, 9, 11, 6, 0, 0, 0, loc)
	if !InQuietHours(dawn, loc, "22:00", "07:00") {
		t.Fatal("06:00 should be quiet")
	}
}

func TestInQuietHoursSameDay(t *testing.T) {
	loc := time.UTC
	noon := time.Date(2026, 9, 11, 12, 30, 0, 0, loc)
	if !InQuietHours(noon, loc, "12:00", "13:00") {
		t.Fatal("12:30 should be quiet")
	}
	if InQuietHours(noon, loc, "14:00", "15:00") {
		t.Fatal("12:30 should not be quiet")
	}
}

func TestInQuietHoursEmpty(t *testing.T) {
	if InQuietHours(time.Now(), time.UTC, "", "") {
		t.Fatal("empty window is not quiet")
	}
	if InQuietHours(time.Now(), time.UTC, "25:00", "07:00") {
		t.Fatal("invalid start is not quiet")
	}
}

func TestAccountAllowed(t *testing.T) {
	if !accountAllowed(nil, "a") {
		t.Fatal("empty list allows all")
	}
	if !accountAllowed([]string{"a", "b"}, "b") {
		t.Fatal("matching id")
	}
	if accountAllowed([]string{"a"}, "b") {
		t.Fatal("other account blocked")
	}
}

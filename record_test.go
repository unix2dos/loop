package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strconv"
	"strings"
	"testing"
)

func TestRecordLocationsAndOpenBoundary(t *testing.T) {
	// Offsets must follow structure, not an ID/string search or reformatting.
	raw := []byte("{\n  \"other\": {\"id\":\"e002\"},\n  \"events\": [\n    {\"id\":\"e001\",\"input\":\"中文\\n e002\"},\n    {\"id\":\"e002\",\n     \"input\": {\"a/b~c\": [null,\n       {\"role\":\"tool\"}]}}\n  ]\n}")
	for _, sample := range []struct {
		path   []string
		line   int
		starts string
	}{
		{[]string{"events", "1"}, 5, `{"id":"e002"`},
		{[]string{"events", "1", "input", "a/b~c", "1"}, 7, `{"role":"tool"}`},
		{[]string{"events", "0", "input"}, 4, `"中文\n e002"`},
	} {
		offset, err := jsonOffset(raw, sample.path)
		if err != nil || bytes.Count(raw[:offset], []byte("\n"))+1 != sample.line || !bytes.HasPrefix(raw[offset:], []byte(sample.starts)) {
			t.Fatalf("wrong physical position: %v offset=%d err=%v", sample.path, offset, err)
		}
	}
	if _, err := jsonOffset(raw, []string{"events", "9"}); err == nil {
		t.Fatal("missing field accepted")
	}
	var compact bytes.Buffer
	if err := json.Compact(&compact, raw); err != nil {
		t.Fatal(err)
	}
	offset, err := jsonOffset(compact.Bytes(), []string{"events", "1"})
	if err != nil || bytes.Count(compact.Bytes()[:offset], []byte("\n")) != 0 {
		t.Fatal("minified JSON position", err)
	}

	state := t.TempDir()
	app, err := NewServer(workspace(t), state, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, _ := app.newRun("record location", 1, "scripted")
	run.Status = "completed"
	run.Events = []*Event{
		{ID: "e001", Kind: "input", Title: "task", Status: "succeeded", Input: map[string]any{"id": "e002"}, Output: map[string]any{}, Code: "loop"},
		{ID: "e002", Kind: "model", Title: "model", Status: "succeeded", Input: map[string]any{"a/b~c": []any{nil, "TARGET_FIELD"}}, Output: map[string]any{}, Code: "loop"},
	}
	folder := filepath.Join(state, run.ID)
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "run.json")
	if err := saveRun(path, run); err != nil {
		t.Fatal(err)
	}
	before, _ := os.ReadFile(path)
	location, err := locateRecord(state, run.ID, "e002", "/input/a~1b~0c/1")
	lines := strings.Split(string(before), "\n")
	if err != nil || location.Path != path || !strings.Contains(lines[location.Line-1], `"TARGET_FIELD"`) {
		t.Fatal("field location", location, err)
	}
	eventLocation, err := locateRecord(state, run.ID, "e002", "")
	if err != nil || !strings.Contains(lines[eventLocation.Line], `"id": "e002"`) {
		t.Fatal("event location", eventLocation, err)
	}
	for _, sample := range []struct{ id, event, field string }{
		{"../escape", "e002", ""}, {run.ID, "e999", ""}, {run.ID, "e002", "/input/missing"}, {run.ID, "e002", "/../../file"},
	} {
		if _, err := locateRecord(state, sample.id, sample.event, sample.field); err == nil {
			t.Fatal("invalid location accepted", sample)
		}
	}

	// Invalid HTTP requests never reach an editor; no tests spawn desktop apps.
	for _, sample := range []struct {
		body, token, origin string
		status              int
	}{
		{`{"event_id":"e002"}`, "", "", 403},
		{`{"event_id":"e002"}`, app.token, "http://evil.example", 403},
		{`{"event_id":"e002","path":"/etc/passwd"}`, app.token, "", 400},
		{`{"event_id":"e002"} {}`, app.token, "", 400},
		{`{"event_id":"e999"}`, app.token, "", 404},
	} {
		req := httptest.NewRequest("POST", "http://127.0.0.1:8877/api/runs/"+run.ID+"/open-record", strings.NewReader(sample.body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Lab-Token", sample.token)
		req.Header.Set("Origin", sample.origin)
		result := httptest.NewRecorder()
		app.ServeHTTP(result, req)
		if result.Code != sample.status {
			t.Fatalf("HTTP got %d want %d: %s", result.Code, sample.status, result.Body.String())
		}
	}
	if command, _, err := recordEditorCommand(context.Background(), location); err == nil {
		if !reflect.DeepEqual(command.Args[1:], []string{"--goto", location.Path + ":" + strconv.Itoa(location.Line)}) {
			t.Fatal("unexpected editor arguments", command.Args)
		}
	}
	after, _ := os.ReadFile(path)
	if !bytes.Equal(before, after) {
		t.Fatal("opening location rewrote record")
	}
	if err := os.Rename(path, path+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path+".original", path); err != nil {
		t.Fatal(err)
	}
	if _, err := locateRecord(state, run.ID, "e002", ""); err == nil {
		t.Fatal("symlink accepted")
	}
	if err := os.Remove(path); err != nil {
		t.Fatal(err)
	}
	trace := "{\"phase\":\"start\",\"id\":\"e002\",\"input\":{}}\n{\"phase\":\"finish\",\"id\":\"e002\",\"output\":{\"content\":\"result\"}}\n{\"phase\":\"start\",\"id\":\"e003\",\"input\":{}}\n{\"phase\":\"finish\",\"id\":\"e002\""
	if err := os.WriteFile(filepath.Join(folder, "trace.jsonl"), []byte(trace), 0600); err != nil {
		t.Fatal(err)
	}
	for _, sample := range []struct {
		event, field string
		line         int
	}{{"e002", "", 2}, {"e002", "/input", 1}, {"e002", "/output/content", 2}, {"e003", "", 3}} {
		location, err := locateRecord(state, run.ID, sample.event, sample.field)
		if err != nil || location.Line != sample.line || filepath.Base(location.Path) != "trace.jsonl" {
			t.Fatal("live location", sample, location, err)
		}
	}
}

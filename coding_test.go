package main

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func codingWorkspace(t *testing.T) string {
	t.Helper()
	id, _ := randomID()
	folder, err := prepareExercise(t.TempDir(), id)
	if err != nil {
		t.Fatal(err)
	}
	return folder
}

func TestCodingFileBoundary(t *testing.T) {
	folder := codingWorkspace(t)
	call := func(name string, args map[string]any) map[string]any {
		t.Helper()
		raw, _ := json.Marshal(args)
		var c ToolCall
		c.Function.Name, c.Function.Arguments = name, string(raw)
		result, err := ExecuteCoding(context.Background(), folder, c)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	before := call("read_file", map[string]any{"path": "average.go"})
	old := before["content"].(string)
	fixed := strings.Replace(old, "total := 0", "if len(values) == 0 { return 0 }\n\ttotal := 0", 1)
	target := filepath.Join(folder, "average.go")
	// Simulate an edit after the model has read the file.
	concurrent := old + "\n// changed after read\n"
	if err := os.WriteFile(target, []byte(concurrent), 0644); err != nil {
		t.Fatal(err)
	}
	rejected := call("write_file", map[string]any{"path": "average.go", "content": fixed, "expected_sha256": before["sha256"]})
	actual, _ := os.ReadFile(target)
	if rejected["error"] != "file_changed" || string(actual) != concurrent {
		t.Fatal("stale write replaced newer content", rejected)
	}
	fresh := call("read_file", map[string]any{"path": "average.go"})
	changed := call("write_file", map[string]any{"path": "average.go", "content": fixed, "expected_sha256": fresh["sha256"]})
	actual, _ = os.ReadFile(target)
	if changed["changed"] != true || changed["before"] != concurrent || changed["after"] != fixed || changed["sha256"] != fileHash(actual) || !strings.Contains(changed["diff"].(string), "+\tif len(values) == 0") {
		t.Fatal("write evidence mismatch", changed)
	}
	if err := checkExercise(folder); err != nil {
		t.Fatal("protected fixtures changed", err)
	}
	for _, bad := range []struct {
		name string
		args map[string]any
	}{
		{"read_file", map[string]any{"path": "../average.go"}},
		{"write_file", map[string]any{"path": "average_test.go", "content": fixed, "expected_sha256": fresh["sha256"]}},
		{"run_command", map[string]any{"command": "go test ./...; touch /tmp/escaped"}},
		{"run_command", map[string]any{"command": "go test ./...", "cwd": "/"}},
		{"read_file", map[string]any{"path": "average.go", "offset": 0}},
	} {
		if call(bad.name, bad.args)["error"] != "tool_rejected" {
			t.Fatal("invalid action allowed", bad.name)
		}
	}
	if err := os.Remove(target); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(folder, "average_test.go"), target); err != nil {
		t.Fatal(err)
	}
	if call("read_file", map[string]any{"path": "average.go"})["error"] != "tool_rejected" {
		t.Fatal("symlink allowed")
	}
	var out cappedOutput
	n, err := out.Write(bytes.Repeat([]byte("x"), 70000))
	if n != 70000 || err != nil || !out.truncated || out.Len() != 65536 {
		t.Fatal("output cap")
	}
}

func TestCodingRequiresExplicitLocalApproval(t *testing.T) {
	app, err := NewServer(workspace(t), t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	post := func(body string) int {
		req := httptest.NewRequest("POST", "http://127.0.0.1:8877/api/runs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Lab-Token", app.token)
		result := httptest.NewRecorder()
		app.ServeHTTP(result, req)
		return result.Code
	}
	t.Setenv("LOOP_PUBLIC", "")
	if post(`{"task":"fix","exercise":"go-average"}`) != 403 {
		t.Fatal("missing approval accepted")
	}
	if post(`{"task":"fix","exercise":"go-average","approve_exercise":true,"parent_run_id":"invalid"}`) != 400 {
		t.Fatal("mixed new/continuation accepted")
	}
	t.Setenv("LOOP_PUBLIC", "1")
	if post(`{"task":"fix","exercise":"go-average","approve_exercise":true}`) != 403 {
		t.Fatal("public coding accepted")
	}
}

// Opt in to real Docker checks; this never calls a model or downloads an image.
func TestCodingDocker(t *testing.T) {
	if os.Getenv("LOOP_TEST_DOCKER") != "1" {
		t.Skip("set LOOP_TEST_DOCKER=1 with the pinned image prepared")
	}
	if err := codingReady(); err != nil {
		t.Fatal(err)
	}
	t.Setenv("OPENAI_API_KEY", "LOOP_TEST_SECRET_MUST_NOT_ENTER_CONTAINER")
	t.Setenv("LOOP_PUBLIC", "")
	folder := codingWorkspace(t)
	run := func(ctx context.Context, dir string) map[string]any {
		t.Helper()
		result, err := RunExerciseTests(ctx, dir)
		if err != nil {
			t.Fatal(err, result)
		}
		if result["cleanup_confirmed"] != true {
			t.Fatal("cleanup not confirmed", result)
		}
		if err := dockerCommand(context.Background(), "inspect", result["container_id"].(string)).Run(); err == nil {
			t.Fatal("container remains")
		}
		return result
	}
	failed := run(context.Background(), folder)
	if failed["error"] != "command_failed" || failed["exit_code"] == 0 || !strings.Contains(failed["stdout"].(string), "divide by zero") {
		t.Fatal("baseline did not expose expected bug", failed)
	}
	before, _ := os.ReadFile(filepath.Join(folder, "average.go"))
	fixed := strings.Replace(string(before), "total := 0", "if len(values) == 0 { return 0 }\n\ttotal := 0", 1)
	result, err := WriteExerciseFile(folder, "average.go", fixed, fileHash(before))
	if err != nil || result["changed"] != true {
		t.Fatal(err, result)
	}
	passed := run(context.Background(), folder)
	if passed["exit_code"] != 0 || passed["tested_sha256"] != fileHash([]byte(fixed)) {
		t.Fatal("fixed tests failed", passed)
	}
	t.Log("baseline failed; fingerprint-checked patch passed; both containers removed")
	// An owned probe uses the identical runner to verify its isolation boundaries.
	probe := t.TempDir()
	files := map[string]string{
		"go.mod":     "module loop.exercise/probe\n\ngo 1.24.0\n",
		"average.go": "package probe\n",
		"probe_test.go": `package probe
import ("net";"os";"testing";"time")
func TestIsolation(t *testing.T) {
 if os.Getuid() == 0 { t.Fatal("root") }
 if os.Getenv("OPENAI_API_KEY") != "" { t.Fatal("model credential leaked") }
 if _,err:=os.Stat("/var/run/docker.sock"); err==nil { t.Fatal("Docker socket mounted") }
 for _,path:=range []string{"/loop-escape","/workspace/average.go"} { if err:=os.WriteFile(path,[]byte("escape"),0600); err==nil { t.Fatal("writable",path) } }
 conn,err:=net.DialTimeout("tcp","1.1.1.1:443",time.Second)
 if err==nil { conn.Close(); t.Fatal("network available") }
}
`,
	}
	for name, content := range files {
		if err := os.WriteFile(filepath.Join(probe, name), []byte(content), 0644); err != nil {
			t.Fatal(err)
		}
	}
	isolated := run(context.Background(), probe)
	if isolated["exit_code"] != 0 {
		t.Fatal("isolation probe failed", isolated)
	}
	t.Log("non-root, readonly root/project, no model key/socket, and no outbound network verified")
	ctx, cancel := context.WithTimeout(context.Background(), time.Millisecond)
	defer cancel()
	timed := run(ctx, folder)
	if timed["timed_out"] != true || timed["exit_code"] != nil {
		t.Fatal("timeout invented an exit code", timed)
	}
	t.Log("cancelled attach cleaned up its created container")
}

func TestCodingExerciseHTTP(t *testing.T) {
	if os.Getenv("LOOP_TEST_DOCKER") != "1" {
		t.Skip("requires prepared Docker image")
	}
	t.Setenv("LOOP_PUBLIC", "")
	// Coding schema decoding must never alter normal-mode schemas.
	var requests []ModelRequest
	app, err := NewServer(workspace(t), t.TempDir(), func(string) (ModelCaller, string, error) {
		return func(_ context.Context, input ModelRequest) (ModelResponse, error) {
			requests = append(requests, input)
			return cases(t)[0].Responses[1], nil
		}, "scripted", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	original, _ := json.Marshal(app.tools)
	post := func(body string) *httptest.ResponseRecorder {
		t.Helper()
		req := httptest.NewRequest("POST", "http://127.0.0.1:8877/api/runs", strings.NewReader(body))
		req.Header.Set("Content-Type", "application/json")
		req.Header.Set("X-Lab-Token", app.token)
		response := httptest.NewRecorder()
		app.ServeHTTP(response, req)
		return response
	}
	finish := func(response *httptest.ResponseRecorder) *Run {
		t.Helper()
		if response.Code != 202 {
			t.Fatal(response.Code, response.Body.String())
		}
		for deadline := time.Now().Add(5 * time.Second); ; {
			app.mu.Lock()
			active := app.active
			app.mu.Unlock()
			if !active {
				break
			}
			if time.Now().After(deadline) {
				t.Fatal("scripted run stuck")
			}
			time.Sleep(5 * time.Millisecond)
		}
		var v struct {
			ID string `json:"id"`
		}
		_ = json.Unmarshal(response.Body.Bytes(), &v)
		result, err := readStoredRun(app.state, v.ID)
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	root := finish(post(`{"task":"fix","exercise":"go-average","approve_exercise":true}`))
	after, _ := json.Marshal(app.tools)
	if !bytes.Equal(original, after) || len(requests) != 1 || len(requests[0].Tools) != 4 {
		t.Fatal("coding leaked tools into normal mode")
	}
	want := []string{"read_file", "list_files"}
	var names []string
	for _, tool := range app.tools {
		names = append(names, tool.Function.Name)
	}
	if !reflect.DeepEqual(names, want) {
		t.Fatal(names)
	}
	before, _ := os.ReadFile(filepath.Join(app.state, root.ID, "run.json"))
	body, _ := json.Marshal(map[string]any{"task": "continue", "parent_run_id": root.ID})
	t.Setenv("LOOP_PUBLIC", "1")
	if post(string(body)).Code != 403 {
		t.Fatal("public continuation accepted")
	}
	t.Setenv("LOOP_PUBLIC", "")
	child := finish(post(string(body)))
	if child.Exercise != codingExercise || child.Workspace != root.Workspace || child.ParentRunID != root.ID || len(requests) != 2 || len(requests[1].Tools) != 4 {
		t.Fatal("continuation lost authorized exercise")
	}
	preserved, _ := os.ReadFile(filepath.Join(app.state, root.ID, "run.json"))
	if !bytes.Equal(before, preserved) {
		t.Fatal("continuation changed parent evidence")
	}

}

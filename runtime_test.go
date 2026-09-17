package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync"
	"testing"
	"time"
)

type loopCase struct {
	Name       string          `json:"name"`
	Budget     int             `json:"budget"`
	Responses  []ModelResponse `json:"responses"`
	Status     string          `json:"status"`
	Requests   int             `json:"requests"`
	Tools      int             `json:"tools"`
	ToolErrors int             `json:"tool_errors"`
	Answer     string          `json:"answer"`
}

func cases(t *testing.T) []loopCase {
	t.Helper()
	raw, err := os.ReadFile("testdata/loop-cases.json")
	if err != nil {
		t.Fatal(err)
	}
	var result []loopCase
	if err = json.Unmarshal(raw, &result); err != nil {
		t.Fatal(err)
	}
	return result
}
func workspace(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	if err := os.WriteFile(filepath.Join(directory, "note.md"), []byte("ACTUAL_CONTENT_73"), 0600); err != nil {
		t.Fatal(err)
	}
	return directory
}
func scripted(responses []ModelResponse, requests *[]ModelRequest) ModelCaller {
	return func(ctx context.Context, input ModelRequest) (ModelResponse, error) {
		if err := ctx.Err(); err != nil {
			return ModelResponse{}, err
		}
		raw, _ := json.Marshal(input)
		var saved ModelRequest
		_ = json.Unmarshal(raw, &saved)
		*requests = append(*requests, saved)
		index := len(*requests) - 1
		if index >= len(responses) {
			return ModelResponse{}, errors.New("too many model requests")
		}
		return responses[index], nil
	}
}
func TestBehaviorContracts(t *testing.T) {
	for _, example := range cases(t) {
		t.Run(example.Name, func(t *testing.T) {
			dir := workspace(t)
			state := t.TempDir()
			server, err := NewServer(dir, state, nil)
			if err != nil {
				t.Fatal(err)
			}
			run, err := server.newRun("读取 note.md 并报告原文", example.Budget, "scripted")
			if err != nil {
				t.Fatal(err)
			}
			var requests []ModelRequest
			var mu sync.Mutex
			if err = RunTask(context.Background(), run, scripted(example.Responses, &requests), server.tools, filepath.Join(state, run.ID), &mu); err != nil {
				t.Fatal(err)
			}
			if run.Status != example.Status || run.ModelRequests != example.Requests || run.ToolCalls != example.Tools || run.ToolErrors != example.ToolErrors || run.Answer != example.Answer || run.TaskResult != "not_evaluated" {
				t.Fatalf("contract mismatch: status=%s requests=%d tools=%d errors=%d answer=%q", run.Status, run.ModelRequests, run.ToolCalls, run.ToolErrors, run.Answer)
			}
			raw, err := os.ReadFile(filepath.Join(state, run.ID, "run.json"))
			if err != nil {
				t.Fatal(err)
			}
			restored, err := decodeHistory(raw, run.ID)
			if err != nil {
				t.Fatal(err)
			}
			if restored.Answer != run.Answer || restored.BuildID != run.BuildID {
				t.Fatal("saved snapshot mismatch")
			}
			if !strings.Contains(run.Source["loop"].Code, "func RunLoop") {
				t.Fatal("missing compiled Go source")
			}
			if example.Name == "batch" {
				var ids []string
				var readResult map[string]any
				for _, message := range requests[1].Messages {
					if message.Role == "tool" {
						ids = append(ids, message.ToolCallID)
						if message.ToolCallID == "read-1" {
							_ = json.Unmarshal([]byte(message.Content), &readResult)
						}
					}
				}
				if !reflect.DeepEqual(ids, []string{"list-1", "read-1"}) || readResult["content"] != "ACTUAL_CONTENT_73" {
					t.Fatal("batch receipts not matched")
				}
			}
		})
	}
}
func TestReadonlyBoundary(t *testing.T) {
	dir := workspace(t)
	outside := filepath.Join(t.TempDir(), "outside.md")
	_ = os.WriteFile(outside, []byte("DO_NOT_READ"), 0600)
	if err := os.Symlink(outside, filepath.Join(dir, "escape.md")); err != nil {
		t.Fatal(err)
	}
	_ = os.WriteFile(filepath.Join(dir, "secret.txt"), []byte("DO_NOT_READ"), 0600)
	for _, test := range []struct{ name, args string }{
		{"read_file", `{"path":"../outside.md"}`}, {"read_file", `{"path":"escape.md"}`},
		{"read_file", `{"path":"secret.txt"}`}, {"read_file", `{"path":"note.md","offset":true}`},
		{"read_file", `{"path":"note.md","offset":null}`}, {"read_file", `{"path":"note.md","extra":1}`},
		{"list_files", `{"path":".","limit":true}`}, {"run_bash", `{"path":".","command":"echo wrong"}`},
		{"write_file", `{"path":"note.md","content":"changed"}`},
	} {
		call := ToolCall{ID: "blocked", Type: "function"}
		call.Function.Name, call.Function.Arguments = test.name, test.args
		result, err := ExecuteReadonly(context.Background(), dir, call)
		if err != nil || result["error"] != "tool_rejected" {
			t.Fatalf("expected rejection: %s", test.args)
		}
	}
	raw, _ := os.ReadFile(filepath.Join(dir, "note.md"))
	if string(raw) != "ACTUAL_CONTENT_73" {
		t.Fatal("file modified")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	_, err := RunLoop(ctx, func(context.Context, ModelRequest) (ModelResponse, error) {
		t.Fatal("called after cancellation")
		return ModelResponse{}, nil
	}, nil, "test", nil, nil, "", 1)
	if !errors.Is(err, context.Canceled) {
		t.Fatal("cancellation not propagated")
	}
}
func TestHistoryAndHTTP(t *testing.T) {
	dir, state := workspace(t), t.TempDir()
	example := cases(t)[0]
	server, err := NewServer(dir, state, nil)
	if err != nil {
		t.Fatal(err)
	}
	run, _ := server.newRun("读取 note.md", 4, "scripted")
	var requests []ModelRequest
	if err = RunTask(context.Background(), run, scripted(example.Responses, &requests), server.tools, filepath.Join(state, run.ID), &server.mu); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(state, run.ID, "run.json")
	before, _ := os.ReadFile(path)
	bad := filepath.Join(state, strings.Repeat("a", 32))
	_ = os.MkdirAll(bad, 0700)
	_ = os.WriteFile(filepath.Join(bad, "run.json"), []byte("{"), 0600)
	server, err = NewServer(dir, state, func(string) (ModelCaller, string, error) {
		t.Fatal("history must not call model factory")
		return nil, "", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	httpServer := httptest.NewServer(server)
	defer httpServer.Close()
	get := func(path, host, origin string) (int, []byte) {
		req, _ := http.NewRequest("GET", httpServer.URL+path, nil)
		if host != "" {
			req.Host = host
		}
		if origin != "" {
			req.Header.Set("Origin", origin)
		}
		response, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		raw, _ := io.ReadAll(response.Body)
		return response.StatusCode, raw
	}
	status, raw := get("/api/config", "", "")
	if status != 200 {
		t.Fatal(status)
	}
	var config map[string]any
	_ = json.Unmarshal(raw, &config)
	if config["state_dir"] != server.state {
		t.Fatal("evidence directory mismatch")
	}
	if status, raw := get("/trace-graph.js", "", ""); status != 200 || len(raw) == 0 {
		t.Fatal("trace graph module unavailable")
	}
	history := config["history"].(map[string]any)
	if history["loaded"] != float64(1) || history["skipped"] != float64(1) {
		t.Fatal(history)
	}
	if status, _ := get("/api/config", "attacker.example", ""); status != 403 {
		t.Fatal("host accepted")
	}
	if status, _ := get("/api/config", "", "https://attacker.example"); status != 403 {
		t.Fatal("origin accepted")
	}
	status, raw = get("/api/runs/"+run.ID, "", "")
	if status != 200 {
		t.Fatal(status)
	}
	var restored Run
	if json.Unmarshal(raw, &restored) != nil || restored.Answer != run.Answer {
		t.Fatal("restored run mismatch")
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("history rewritten")
	}
	req, _ := http.NewRequest("POST", httpServer.URL+"/api/runs", strings.NewReader(`{"task":"x"}`))
	req.Header.Set("Content-Type", "application/json")
	response, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 403 {
		t.Fatal("missing token accepted")
	}
	req, _ = http.NewRequest("POST", httpServer.URL+"/api/runs", strings.NewReader(`{"task":"x","max_requests":true}`))
	req.Header.Set("Content-Type", "application/json")
	req.Header.Set("X-Lab-Token", server.token)
	response, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	response.Body.Close()
	if response.StatusCode != 400 {
		t.Fatal("invalid budget accepted")
	}
}
func TestModelTransport(t *testing.T) {
	example := cases(t)[0].Responses[0]
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/v1/chat/completions" || r.Header.Get("Authorization") != "Bearer fake-test-key" || r.Header.Get("User-Agent") != "loop/0.1" {
			t.Error("wire contract mismatch")
		}
		if r.Header.Get("x-opencode-session") != "" {
			t.Error("provider-specific header leaked to another host")
		}
		var input ModelRequest
		if json.NewDecoder(r.Body).Decode(&input) != nil || input.Model != "fake" {
			t.Error("request mismatch")
		}
		_ = json.NewEncoder(w).Encode(example)
	}))
	defer server.Close()
	t.Setenv("OPENAI_API_KEY", "fake-test-key")
	t.Setenv("OPENAI_MODEL", "fake")
	t.Setenv("OPENAI_BASE_URL", server.URL+"/v1")
	call, _, err := HTTPModel("session-1")
	if err != nil {
		t.Fatal(err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Second)
	defer cancel()
	response, err := call(ctx, ModelRequest{Model: "fake", Messages: []Message{{Role: "user", Content: "test"}}})
	if err != nil || len(response.Choices[0].Message.ToolCalls) != 2 {
		t.Fatal("transport failed", err)
	}
}

func TestHTTPRunOutlivesSubmissionAndRejectsConcurrentRun(t *testing.T) {
	entered, release := make(chan struct{}, 1), make(chan struct{})
	defer func() {
		select {
		case <-release:
		default:
			close(release)
		}
	}()
	response := cases(t)[0].Responses[1]
	factory := func(string) (ModelCaller, string, error) {
		return func(ctx context.Context, _ ModelRequest) (ModelResponse, error) {
			entered <- struct{}{}
			select {
			case <-release:
				return response, nil
			case <-ctx.Done():
				return ModelResponse{}, ctx.Err()
			}
		}, "scripted", nil
	}
	app, err := NewServer(workspace(t), t.TempDir(), factory)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	defer server.Close()
	submit := func(ctx context.Context) (int, map[string]any) {
		request, _ := http.NewRequestWithContext(ctx, "POST", server.URL+"/api/runs", strings.NewReader(`{"task":"test","max_requests":1}`))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Lab-Token", app.token)
		result, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer result.Body.Close()
		var body map[string]any
		if err := json.NewDecoder(result.Body).Decode(&body); err != nil {
			t.Fatal(err)
		}
		return result.StatusCode, body
	}
	ctx, cancel := context.WithCancel(context.Background())
	status, body := submit(ctx)
	cancel()
	if status != 202 {
		t.Fatal(status)
	}
	select {
	case <-entered:
	case <-time.After(time.Second):
		t.Fatal("run did not start")
	}
	if status, _ := submit(context.Background()); status != 409 {
		t.Fatal("concurrent run accepted")
	}
	close(release)
	deadline := time.Now().Add(2 * time.Second)
	for time.Now().Before(deadline) {
		result, err := http.Get(server.URL + "/api/runs/" + body["id"].(string))
		if err != nil {
			t.Fatal(err)
		}
		var run Run
		err = json.NewDecoder(result.Body).Decode(&run)
		result.Body.Close()
		if err != nil {
			t.Fatal(err)
		}
		if run.Status != "running" {
			if run.Status != "completed" || run.Answer != "ACTUAL_CONTENT_73" {
				t.Fatal("submission cancellation stopped the run")
			}
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatal("run did not finish")
}

func TestAllHistoryAndLazyDetail(t *testing.T) {
	dir, state := workspace(t), t.TempDir()
	app, err := NewServer(dir, state, nil)
	if err != nil {
		t.Fatal(err)
	}
	example := cases(t)[0]
	run, _ := app.newRun("history example", 4, "scripted")
	var requests []ModelRequest
	if err := RunTask(context.Background(), run, scripted(example.Responses, &requests), app.tools, filepath.Join(state, run.ID), &app.mu); err != nil {
		t.Fatal(err)
	}
	for i := 1; i <= 11; i++ {
		copy := *run
		copy.ID, copy.CreatedAt = fmt.Sprintf("%032x", i), float64(i)
		if err := os.MkdirAll(filepath.Join(state, copy.ID), 0700); err != nil {
			t.Fatal(err)
		}
		if err := saveRun(filepath.Join(state, copy.ID, "run.json"), &copy); err != nil {
			t.Fatal(err)
		}
	}
	app, err = NewServer(dir, state, func(string) (ModelCaller, string, error) {
		t.Fatal("viewing history called model factory")
		return nil, "", nil
	})
	if err != nil {
		t.Fatal(err)
	}
	if len(app.history) != 12 || len(app.runs) != 0 {
		t.Fatal("history should index all summaries without retaining every trace")
	}
	server := httptest.NewServer(app)
	defer server.Close()
	response, err := http.Get(server.URL + "/api/runs")
	if err != nil {
		t.Fatal(err)
	}
	var summaries []RunSummary
	err = json.NewDecoder(response.Body).Decode(&summaries)
	response.Body.Close()
	if err != nil || len(summaries) != 12 {
		t.Fatal("history listing still limited", err, len(summaries))
	}
	oldest := fmt.Sprintf("%032x", 1)
	path := filepath.Join(state, oldest, "run.json")
	before, _ := os.ReadFile(path)
	response, err = http.Get(server.URL + "/api/runs/" + oldest)
	if err != nil {
		t.Fatal(err)
	}
	var detail Run
	err = json.NewDecoder(response.Body).Decode(&detail)
	response.Body.Close()
	if err != nil || response.StatusCode != 200 || detail.ID != oldest || detail.Answer != run.Answer {
		t.Fatal("old detail is not readable", err)
	}
	after, _ := os.ReadFile(path)
	if string(before) != string(after) {
		t.Fatal("viewing history rewrote its record")
	}
	if _, err := readStoredRun(state, "../escape"); err == nil {
		t.Fatal("invalid run ID allowed")
	}
	linked := fmt.Sprintf("%032x", 20)
	if err := os.Symlink(filepath.Join(state, oldest), filepath.Join(state, linked)); err != nil {
		t.Fatal(err)
	}
	if _, err := readStoredRun(state, linked); err == nil {
		t.Fatal("linked run directory allowed")
	}
	if err := os.Rename(path, path+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path+".original", path); err != nil {
		t.Fatal(err)
	}
	if _, err := readStoredRun(state, oldest); err == nil {
		t.Fatal("linked run file allowed")
	}
}

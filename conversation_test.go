package main

import (
	"bytes"
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

func TestConversationContinuationHTTP(t *testing.T) {
	state, work := t.TempDir(), workspace(t)
	app, err := NewServer(work, state, nil)
	if err != nil {
		t.Fatal(err)
	}
	root, _ := app.newRun("读取笔记", 1, "scripted")
	var first []ModelRequest
	if err := RunTask(context.Background(), root, scripted(cases(t)[0].Responses, &first), app.tools, filepath.Join(state, root.ID), &app.mu, nil); err != nil {
		t.Fatal(err)
	}
	if root.Status != "budget_exhausted" {
		t.Fatal(root.Status)
	}
	before, _ := os.ReadFile(filepath.Join(state, root.ID, "run.json"))
	original, err := conversationMessages(state, root)
	if err != nil || len(original) < 4 {
		t.Fatal("complete tool batch cannot continue", err)
	}
	captured := make(chan ModelRequest, 8)
	var calls atomic.Int32
	modelResponse := cases(t)[0].Responses[1]
	factory := func(string) (ModelCaller, string, error) {
		return func(_ context.Context, input ModelRequest) (ModelResponse, error) {
			calls.Add(1)
			captured <- input
			return modelResponse, nil
		}, "scripted", nil
	}
	app, err = NewServer(work, state, factory)
	if err != nil {
		t.Fatal(err)
	}
	server := httptest.NewServer(app)
	defer server.Close()
	post := func(parent, task string) (int, string) {
		raw, _ := json.Marshal(map[string]any{"task": task, "max_requests": 1, "parent_run_id": parent})
		request, _ := http.NewRequest("POST", server.URL+"/api/runs", bytes.NewReader(raw))
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("X-Lab-Token", app.token)
		response, err := http.DefaultClient.Do(request)
		if err != nil {
			t.Fatal(err)
		}
		defer response.Body.Close()
		var value map[string]any
		if err := json.NewDecoder(response.Body).Decode(&value); err != nil {
			t.Fatal(err)
		}
		id, _ := value["id"].(string)
		return response.StatusCode, id
	}
	finish := func(id string) *Run {
		for deadline := time.Now().Add(3 * time.Second); time.Now().Before(deadline); {
			response, err := http.Get(server.URL + "/api/runs/" + id)
			if err != nil {
				t.Fatal(err)
			}
			var run Run
			err = json.NewDecoder(response.Body).Decode(&run)
			response.Body.Close()
			if err != nil {
				t.Fatal(err)
			}
			if run.Status != "running" {
				return &run
			}
			time.Sleep(time.Millisecond * 5)
		}
		t.Fatal("run never finished")
		return nil
	}
	if status, _ := post("../escape", "bad"); status != 400 {
		t.Fatal("invalid parent", status)
	}
	status, id := post(root.ID, "根据刚才的结果继续")
	if status != 202 {
		t.Fatal(status)
	}
	child := finish(id)
	request := <-captured
	expected := append(append([]Message(nil), original[1:]...), Message{Role: "user", Content: "根据刚才的结果继续"})
	if request.Messages[0].Role != "system" || !strings.HasPrefix(request.Messages[0].Content, systemPrompt) || !reflect.DeepEqual(request.Messages[1:], expected) {
		t.Fatal("follow-up lost or changed model/tool history")
	}
	contextEvent := child.Events[1]
	if contextEvent.Input["system"] != request.Messages[0].Content || contextEvent.Input["system_policy"] != "current_per_turn" || contextEvent.Code != "context" {
		t.Fatal("trace does not describe the actual system context")
	}
	if child.ConversationID != root.ID || child.ParentRunID != root.ID || child.ConversationTurn != 2 || child.MaxRequests != 1 || child.ModelRequests != 1 || child.Status != "completed" {
		t.Fatalf("bad continuation: %+v", child)
	}
	if status, _ := post(root.ID, "stale"); status != 409 {
		t.Fatal("stale parent allowed", status)
	}
	after, _ := os.ReadFile(filepath.Join(state, root.ID, "run.json"))
	if !bytes.Equal(before, after) {
		t.Fatal("continuation modified the parent")
	}

	// A new server can continue the saved conversation without in-memory history.
	server.Close()
	app, err = NewServer(work, state, factory)
	if err != nil {
		t.Fatal(err)
	}
	server = httptest.NewServer(app)
	defer server.Close()
	status, id = post(child.ID, "第三轮")
	if status != 202 {
		t.Fatal(status)
	}
	third := finish(id)
	request = <-captured
	if third.ConversationTurn != 3 || third.ConversationID != root.ID || request.Messages[len(request.Messages)-2].Role != "assistant" || request.Messages[len(request.Messages)-1].Content != "第三轮" {
		t.Fatal("restart lost conversation")
	}
	status, id = post("", "另起新任务")
	if status != 202 {
		t.Fatal(status)
	}
	fresh := finish(id)
	request = <-captured
	if fresh.ParentRunID != "" || len(request.Messages) != 2 || request.Messages[1].Content != "另起新任务" {
		t.Fatal("new task leaked previous context")
	}
	if calls.Load() != 3 {
		t.Fatal("rejected request called the model", calls.Load())
	}
	response, err := http.Get(server.URL + "/api/runs")
	if err != nil {
		t.Fatal(err)
	}
	defer response.Body.Close()
	raw, _ := io.ReadAll(response.Body)
	var summaries []RunSummary
	if json.Unmarshal(raw, &summaries) != nil || len(summaries) != 4 {
		t.Fatal("history missing turns")
	}
}

func TestConversationMessageBoundaries(t *testing.T) {
	state := t.TempDir()
	id := strings.Repeat("b", 32)
	folder := filepath.Join(state, id)
	if err := os.Mkdir(folder, 0700); err != nil {
		t.Fatal(err)
	}
	path := filepath.Join(folder, "session.jsonl")
	base := []Message{{Role: "system", Content: "system"}, {Role: "user", Content: "task"}}
	call := ToolCall{ID: "call-1", Type: "function"}
	call.Function.Name = "read_file"
	call.Function.Arguments = "invalid JSON arguments"
	// Invalid tool arguments may have real error receipts; keep that evidence.
	batch := Message{Role: "assistant", ToolCalls: []ToolCall{call}}
	receipt := Message{Role: "tool", ToolCallID: call.ID, Content: `{"error":"tool_rejected"}`}
	for _, sample := range []struct {
		messages []Message
		valid    bool
	}{
		{base, true}, {append(append([]Message{}, base...), batch, receipt), true},
		{append(append([]Message{}, base...), batch), false},
		{append(append([]Message{}, base...), receipt), false},
		{append(append([]Message{}, base...), batch, Message{Role: "user", Content: "skip tool"}), false},
		{append(append([]Message{}, base...), Message{Role: "system", Content: "extra"}), false},
	} {
		if err := os.WriteFile(path, nil, 0600); err != nil {
			t.Fatal(err)
		}
		for _, m := range sample.messages {
			if err := appendJSON(path, map[string]any{"type": "message", "message": m}); err != nil {
				t.Fatal(err)
			}
		}
		_, err := conversationMessages(state, &Run{ID: id})
		if (err == nil) != sample.valid {
			t.Fatal("message protocol validation", sample.valid, err)
		}
	}
	if err := os.Rename(path, path+".original"); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(path+".original", path); err != nil {
		t.Fatal(err)
	}
	if _, err := conversationMessages(state, &Run{ID: id}); err == nil {
		t.Fatal("symlink ledger accepted")
	}
}

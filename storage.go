package main

import (
	"bytes"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"go/ast"
	"go/parser"
	"go/token"
	"io/fs"
	"os"
	"path/filepath"
	"regexp"
	"sort"
)

var runIDPattern = regexp.MustCompile("^[a-f0-9]{32}$")
var eventIDPattern = regexp.MustCompile("^e[0-9]+$")
var providerCodePattern = regexp.MustCompile("^[A-Za-z0-9_]{1,80}$")

type Source struct {
	Path string `json:"path"`
	Line int    `json:"line"`
	Code string `json:"code"`
}
type Event struct {
	ID          string         `json:"id"`
	Kind        string         `json:"kind"`
	Title       string         `json:"title"`
	Turn        int            `json:"turn"`
	T           float64        `json:"t"`
	D           float64        `json:"d"`
	Status      string         `json:"status"`
	Input       map[string]any `json:"input"`
	Output      map[string]any `json:"output"`
	Code        string         `json:"code"`
	Explanation string         `json:"explanation"`
}
type Run struct {
	Exercise         string            `json:"exercise,omitempty"`
	ParentRunID      string            `json:"parent_run_id,omitempty"`
	ConversationID   string            `json:"conversation_id,omitempty"`
	ConversationTurn int               `json:"conversation_turn,omitempty"`
	ID               string            `json:"id"`
	Task             string            `json:"task"`
	Model            string            `json:"model"`
	Workspace        string            `json:"workspace"`
	MaxRequests      int               `json:"max_requests"`
	Status           string            `json:"status"`
	TaskResult       string            `json:"task_result"`
	Answer           string            `json:"answer"`
	Error            map[string]any    `json:"error"`
	Events           []*Event          `json:"events"`
	CreatedAt        float64           `json:"created_at"`
	Duration         float64           `json:"duration"`
	ModelRequests    int               `json:"model_requests"`
	ToolCalls        int               `json:"tool_calls"`
	ToolErrors       int               `json:"tool_errors"`
	Source           map[string]Source `json:"source"`
	Engine           string            `json:"engine,omitempty"`
	BuildID          string            `json:"build_id,omitempty"`
}

type RunSummary struct {
	Exercise         string  `json:"exercise,omitempty"`
	ParentRunID      string  `json:"parent_run_id,omitempty"`
	ConversationID   string  `json:"conversation_id,omitempty"`
	ConversationTurn int     `json:"conversation_turn,omitempty"`
	ID               string  `json:"id"`
	Task             string  `json:"task"`
	Model            string  `json:"model"`
	Status           string  `json:"status"`
	CreatedAt        float64 `json:"created_at"`
}

func summarizeRun(run *Run) RunSummary {
	return RunSummary{Exercise: run.Exercise, ParentRunID: run.ParentRunID, ConversationID: run.ConversationID, ConversationTurn: run.ConversationTurn, ID: run.ID, Task: run.Task, Model: run.Model, Status: run.Status, CreatedAt: run.CreatedAt}
}

func sortedSummaries(history map[string]RunSummary) []RunSummary {
	items := make([]RunSummary, 0, len(history))
	for _, summary := range history {
		items = append(items, summary)
	}
	sort.Slice(items, func(i, j int) bool {
		if items[i].CreatedAt == items[j].CreatedAt {
			return items[i].ID < items[j].ID
		}
		return items[i].CreatedAt > items[j].CreatedAt
	})
	return items
}

func appendJSON(path string, value any) error {
	if err := os.MkdirAll(filepath.Dir(path), 0700); err != nil {
		return err
	}
	file, err := os.OpenFile(path, os.O_CREATE|os.O_APPEND|os.O_WRONLY, 0600)
	if err != nil {
		return err
	}
	defer file.Close()
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	if err = encoder.Encode(value); err != nil {
		return err
	}
	return file.Sync()
}

func saveRun(path string, run *Run) error {
	file, err := os.CreateTemp(filepath.Dir(path), ".run-*.tmp")
	if err != nil {
		return err
	}
	defer os.Remove(file.Name())
	encoder := json.NewEncoder(file)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err = encoder.Encode(run); err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return err
	}
	if closeErr != nil {
		return closeErr
	}
	return os.Rename(file.Name(), path)
}

func sourceRecords() (map[string]Source, string, error) {
	sources := map[string]Source{}
	hash := sha256.New()
	// This identifies the embedded source/asset bundle, not environment secrets or a binary checksum.
	if err := fs.WalkDir(assets, ".", func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.IsDir() {
			return nil
		}
		raw, err := assets.ReadFile(path)
		if err != nil {
			return err
		}
		hash.Write([]byte(path))
		hash.Write([]byte{0})
		hash.Write(raw)
		return nil
	}); err != nil {
		return nil, "", err
	}
	for _, definition := range []struct{ key, file, function string }{
		{"context", "context.go", "BuildTurnMessages"},
		{"coding_dispatch", "coding.go", "ExecuteCoding"}, {"command", "coding.go", "RunExerciseTests"}, {"write", "coding.go", "WriteExerciseFile"},
		{"loop", "agent.go", "RunLoop"}, {"dispatch", "tools.go", "ExecuteReadonly"},
		{"read", "tools.go", "ReadFile"}, {"list", "tools.go", "ListFiles"},
	} {
		raw, err := assets.ReadFile(definition.file)
		if err != nil {
			return nil, "", err
		}
		set := token.NewFileSet()
		tree, err := parser.ParseFile(set, definition.file, raw, 0)
		if err != nil {
			return nil, "", err
		}
		found := false
		for _, declaration := range tree.Decls {
			function, ok := declaration.(*ast.FuncDecl)
			if !ok || function.Name.Name != definition.function {
				continue
			}
			first, last := set.Position(function.Pos()), set.Position(function.End())
			sources[definition.key] = Source{Path: definition.file, Line: first.Line, Code: string(raw[first.Offset:last.Offset])}
			found = true
			break
		}
		if !found {
			return nil, "", errors.New("source function missing")
		}
	}
	return sources, hex.EncodeToString(hash.Sum(nil)), nil
}

func requiredObject(raw []byte, keys ...string) (map[string]json.RawMessage, error) {
	var fields map[string]json.RawMessage
	if json.Unmarshal(raw, &fields) != nil || fields == nil {
		return nil, errors.New("JSON object required")
	}
	for _, key := range keys {
		value, ok := fields[key]
		if !ok || bytes.Equal(bytes.TrimSpace(value), []byte("null")) {
			return nil, errors.New("required field missing")
		}
	}
	return fields, nil
}

func decodeHistory(raw []byte, id string) (*Run, error) {
	fields, err := requiredObject(raw, "id", "task", "model", "workspace", "status", "answer", "task_result",
		"created_at", "duration", "model_requests", "tool_calls", "tool_errors", "events", "source")
	if err != nil {
		return nil, err
	}
	var run Run
	if json.Unmarshal(raw, &run) != nil || run.ID != id || !runIDPattern.MatchString(run.ID) {
		return nil, errors.New("invalid run identity or fields")
	}
	if run.Exercise != "" && run.Exercise != codingExercise {
		return nil, errors.New("invalid exercise")
	}
	if run.Status != "completed" && run.Status != "failed" && run.Status != "budget_exhausted" {
		return nil, errors.New("run not finished")
	}
	if run.ParentRunID != "" && (!runIDPattern.MatchString(run.ParentRunID) || run.ParentRunID == run.ID || !runIDPattern.MatchString(run.ConversationID) || run.ConversationID == run.ID || run.ConversationTurn < 2) {
		return nil, errors.New("invalid conversation link")
	}
	if run.ParentRunID == "" && (run.ConversationID != "" || run.ConversationTurn > 1 || run.ConversationTurn < 0) {
		return nil, errors.New("invalid conversation root")
	}
	if run.CreatedAt < 0 || run.Duration < 0 || run.ModelRequests < 0 || run.ToolCalls < 0 || run.ToolErrors < 0 || len(run.Events) == 0 {
		return nil, errors.New("invalid history counters")
	}
	var eventRecords []json.RawMessage
	if json.Unmarshal(fields["events"], &eventRecords) != nil {
		return nil, errors.New("invalid events")
	}
	ids := map[string]bool{}
	var sourceRecords map[string]json.RawMessage
	if json.Unmarshal(fields["source"], &sourceRecords) != nil {
		return nil, errors.New("invalid sources")
	}
	for i, event := range run.Events {
		if _, err := requiredObject(eventRecords[i], "id", "kind", "title", "turn", "t", "d", "status", "input", "output", "code", "explanation"); err != nil {
			return nil, err
		}
		if event == nil || !eventIDPattern.MatchString(event.ID) || ids[event.ID] || event.T < 0 || event.D < 0 || event.Turn < 0 || event.Input == nil || event.Output == nil {
			return nil, errors.New("invalid event")
		}
		ids[event.ID] = true
		if event.Kind != "input" && event.Kind != "model" && event.Kind != "tool" && event.Kind != "control" {
			return nil, errors.New("invalid kind")
		}
		if event.Status != "succeeded" && event.Status != "failed" {
			return nil, errors.New("unfinished event")
		}
		if source, found := run.Source[event.Code]; !found || source.Line < 1 {
			return nil, errors.New("source missing")
		}
		if _, err := requiredObject(sourceRecords[event.Code], "path", "line", "code"); err != nil {
			return nil, err
		}
	}
	return &run, nil
}

func sortedRunIDs(runs map[string]*Run) []string {
	ids := make([]string, 0, len(runs))
	for id := range runs {
		ids = append(ids, id)
	}
	sort.Slice(ids, func(i, j int) bool {
		if runs[ids[i]].CreatedAt == runs[ids[j]].CreatedAt {
			return ids[i] < ids[j]
		}
		return runs[ids[i]].CreatedAt < runs[ids[j]].CreatedAt
	})
	return ids
}

func readStoredRun(directory, id string) (*Run, error) {
	raw, err := readRunFile(directory, id, "run.json")
	if err != nil {
		return nil, err
	}
	return decodeHistory(raw, id)
}

func readRunFile(directory, id, name string) ([]byte, error) {
	if !runIDPattern.MatchString(id) {
		return nil, errors.New("invalid run id")
	}
	if name != "run.json" && name != "trace.jsonl" && name != "session.jsonl" {
		return nil, errors.New("invalid record file")
	}
	folder := filepath.Join(directory, id)
	info, err := os.Lstat(folder)
	if err != nil {
		return nil, err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("ordinary run directory required")
	}
	path := filepath.Join(folder, name)
	info, err = os.Lstat(path)
	if err != nil {
		return nil, err
	}
	if !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 {
		return nil, errors.New("ordinary run file required")
	}
	if name == "session.jsonl" && info.Size() > 16<<20 {
		return nil, errors.New("对话记录已超过 16 MiB，请开始新任务")
	}
	return os.ReadFile(path)
}

func loadHistory(directory string) (map[string]RunSummary, int, error) {
	history := map[string]RunSummary{}
	skipped := 0
	entries, err := os.ReadDir(directory)
	if os.IsNotExist(err) {
		return history, 0, nil
	}
	if err != nil {
		return nil, 0, err
	}
	// ponytail: validate files once at startup and retain only summaries; add a persistent index if scanning becomes slow.
	for _, entry := range entries {
		run, readErr := readStoredRun(directory, entry.Name())
		if os.IsNotExist(readErr) {
			continue
		}
		if readErr != nil {
			skipped++
			continue
		}
		history[run.ID] = summarizeRun(run)
	}
	return history, skipped, nil
}

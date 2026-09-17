package main

import (
	"context"
	"crypto/rand"
	"crypto/subtle"
	"encoding/hex"
	"encoding/json"
	"errors"
	"io"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"time"
	"unicode/utf8"
)

type CallerFactory func(string) (ModelCaller, string, error)
type Server struct {
	mu                      sync.Mutex
	workspace, state, token string
	runs                    map[string]*Run
	sources                 map[string]Source
	buildID                 string
	tools                   []Tool
	loaded, skipped         int
	active                  bool
	factory                 CallerFactory
}

func randomID() (string, error) {
	var bytes [16]byte
	if _, err := rand.Read(bytes[:]); err != nil {
		return "", err
	}
	bytes[6] = (bytes[6] & 15) | 64
	bytes[8] = (bytes[8] & 63) | 128
	return hex.EncodeToString(bytes[:]), nil
}

func NewServer(workspace, state string, factory CallerFactory) (*Server, error) {
	workspace, err := filepath.Abs(workspace)
	if err != nil {
		return nil, err
	}
	if info, err := os.Stat(workspace); err != nil || !info.IsDir() {
		return nil, errors.New("工作区必须是存在的目录")
	}
	state, err = filepath.Abs(state)
	if err != nil {
		return nil, err
	}
	runs, skipped, err := loadHistory(state)
	if err != nil {
		return nil, err
	}
	sources, buildID, err := sourceRecords()
	if err != nil {
		return nil, err
	}
	raw, err := assets.ReadFile("tools.json")
	if err != nil {
		return nil, err
	}
	var tools []Tool
	if json.Unmarshal(raw, &tools) != nil {
		return nil, errors.New("invalid embedded tool definitions")
	}
	var tokenBytes [32]byte
	if _, err := rand.Read(tokenBytes[:]); err != nil {
		return nil, err
	}
	return &Server{workspace: workspace, state: state, token: hex.EncodeToString(tokenBytes[:]), runs: runs, sources: sources, buildID: buildID,
		tools: tools, loaded: len(runs), skipped: skipped, factory: factory}, nil
}

func (s *Server) newRun(task string, budget int, model string) (*Run, error) {
	task = strings.TrimSpace(task)
	if !utf8.ValidString(task) || utf8.RuneCountInString(task) < 1 || utf8.RuneCountInString(task) > 4000 || budget < 1 || budget > 8 {
		return nil, errors.New("invalid task or request budget")
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	return &Run{ID: id, Task: task, Model: model, Workspace: s.workspace, MaxRequests: budget, Status: "running",
		TaskResult: "not_evaluated", Events: []*Event{}, CreatedAt: float64(time.Now().UnixNano()) / 1e9,
		Source: s.sources, Engine: "go", BuildID: s.buildID}, nil
}

func respond(w http.ResponseWriter, status int, value any) {
	raw, err := json.Marshal(value)
	if err != nil {
		status = http.StatusInternalServerError
		raw = []byte(`{"error":"无法编码响应"}`)
	}
	writeResponse(w, status, raw, "application/json; charset=utf-8")
}
func writeResponse(w http.ResponseWriter, status int, raw []byte, contentType string) {
	w.Header().Set("Content-Type", contentType)
	w.Header().Set("Content-Length", strconv.Itoa(len(raw)))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("X-Content-Type-Options", "nosniff")
	w.Header().Set("X-Frame-Options", "DENY")
	w.WriteHeader(status)
	_, _ = w.Write(raw)
}
func localRequest(r *http.Request) bool {
	host, port, err := net.SplitHostPort(r.Host)
	if err != nil || (host != "127.0.0.1" && host != "localhost") {
		return false
	}
	number, err := strconv.Atoi(port)
	if err != nil || number < 1 || number > 65535 {
		return false
	}
	if addr, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		_, actualPort, err := net.SplitHostPort(addr.String())
		if err != nil || port != actualPort {
			return false
		}
	}
	if origin := r.Header.Get("Origin"); origin != "" && origin != "http://"+r.Host {
		return false
	}
	return r.Header.Get("Sec-Fetch-Site") != "cross-site"
}

func (s *Server) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if !localRequest(r) {
		respond(w, 403, map[string]any{"error": "仅接受同源本机请求"})
		return
	}
	if r.Method == http.MethodGet {
		switch r.URL.Path {
		case "/":
			raw, err := assets.ReadFile("index.html")
			if err != nil {
				respond(w, 500, map[string]any{"error": "界面文件不可用"})
				return
			}
			writeResponse(w, 200, raw, "text/html; charset=utf-8")
		case "/favicon.ico":
			writeResponse(w, 204, nil, "image/x-icon")
		case "/app.js":
			raw, err := assets.ReadFile("web/dist/app.js")
			if err != nil {
				respond(w, 500, map[string]any{"error": "界面脚本不可用"})
				return
			}
			writeResponse(w, 200, raw, "text/javascript; charset=utf-8")
		case "/api/config":
			respond(w, 200, map[string]any{"workspace": s.workspace, "model": os.Getenv("OPENAI_MODEL"),
				"configured": os.Getenv("OPENAI_API_KEY") != "" && os.Getenv("OPENAI_MODEL") != "",
				"token":      s.token, "default_task": defaultTask, "history": map[string]int{"loaded": s.loaded, "skipped": s.skipped}})
		case "/api/runs":
			s.mu.Lock()
			ids := sortedRunIDs(s.runs)
			items := make([]map[string]any, 0, len(ids))
			for i := len(ids) - 1; i >= 0; i-- {
				run := s.runs[ids[i]]
				items = append(items, map[string]any{"id": run.ID, "task": run.Task, "status": run.Status, "created_at": run.CreatedAt, "model": run.Model})
			}
			s.mu.Unlock()
			respond(w, 200, items)
		default:
			id := strings.TrimPrefix(r.URL.Path, "/api/runs/")
			if id == r.URL.Path || !runIDPattern.MatchString(id) {
				respond(w, 404, map[string]any{"error": "not_found"})
				return
			}
			s.mu.Lock()
			run := s.runs[id]
			raw, err := json.Marshal(run)
			s.mu.Unlock()
			if run == nil {
				respond(w, 404, map[string]any{"error": "记录未在最近八次有效运行中；原始文件仍保留在本地"})
				return
			}
			if err != nil {
				respond(w, 500, map[string]any{"error": "无法读取记录"})
				return
			}
			writeResponse(w, 200, raw, "application/json; charset=utf-8")
		}
		return
	}
	if r.Method != http.MethodPost || r.URL.Path != "/api/runs" {
		respond(w, 404, map[string]any{"error": "not_found"})
		return
	}
	if subtle.ConstantTimeCompare([]byte(r.Header.Get("X-Lab-Token")), []byte(s.token)) != 1 {
		respond(w, 403, map[string]any{"error": "请求令牌无效，请刷新页面"})
		return
	}
	if strings.TrimSpace(strings.Split(r.Header.Get("Content-Type"), ";")[0]) != "application/json" {
		respond(w, 415, map[string]any{"error": "需要 JSON 请求"})
		return
	}
	var payload struct {
		Task        string          `json:"task"`
		MaxRequests json.RawMessage `json:"max_requests"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 20000))
	decoder.DisallowUnknownFields()
	err := decoder.Decode(&payload)
	if err == nil {
		var extra any
		if decoder.Decode(&extra) != io.EOF {
			err = errors.New("trailing JSON")
		}
	}
	args := map[string]json.RawMessage{}
	if len(payload.MaxRequests) > 0 {
		args["max_requests"] = payload.MaxRequests
	}
	budget, parseErr := integerArgument(args, "max_requests", 4)
	if err != nil || parseErr != nil {
		respond(w, 400, map[string]any{"error": "任务或请求上限无效"})
		return
	}
	run, err := s.newRun(payload.Task, budget, os.Getenv("OPENAI_MODEL"))
	if err != nil {
		respond(w, 400, map[string]any{"error": "任务或请求上限无效"})
		return
	}
	s.mu.Lock()
	if s.active {
		s.mu.Unlock()
		respond(w, 409, map[string]any{"error": "已有任务运行中，请等它结束"})
		return
	}
	call, model, err := s.factory(run.ID)
	if err != nil {
		s.mu.Unlock()
		respond(w, 503, map[string]any{"error": "模型配置不可用，请设置 OPENAI_API_KEY、OPENAI_MODEL，以及可选 OPENAI_BASE_URL"})
		return
	}
	run.Model = model
	s.active = true
	s.runs[run.ID] = run
	for len(s.runs) > 8 {
		delete(s.runs, sortedRunIDs(s.runs)[0])
	}
	s.mu.Unlock()
	go func() {
		// A Run belongs to the server, not the browser connection that submitted it.
		err := RunTask(context.Background(), run, call, s.tools, filepath.Join(s.state, run.ID), &s.mu)
		s.mu.Lock()
		defer s.mu.Unlock()
		if err != nil {
			run.Status = "failed"
			run.Error = map[string]any{"error_type": "StorageError", "message": "本地记录或执行异常"}
		}
		s.active = false
	}()
	respond(w, 202, map[string]any{"id": run.ID})
}

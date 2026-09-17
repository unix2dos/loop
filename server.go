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
	history                 map[string]RunSummary
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
	history, skipped, err := loadHistory(state)
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
	return &Server{workspace: workspace, state: state, token: hex.EncodeToString(tokenBytes[:]), runs: map[string]*Run{}, history: history, sources: sources, buildID: buildID,
		tools: tools, loaded: len(history), skipped: skipped, factory: factory}, nil
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
	return &Run{ConversationTurn: 1, ID: id, Task: task, Model: model, Workspace: s.workspace, MaxRequests: budget, Status: "running",
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
		case "/app.js", "/trace-graph.js", "/conversation.js":
			raw, err := assets.ReadFile("web/dist/" + strings.TrimPrefix(r.URL.Path, "/"))
			if err != nil {
				respond(w, 500, map[string]any{"error": "界面脚本不可用"})
				return
			}
			writeResponse(w, 200, raw, "text/javascript; charset=utf-8")
		case "/api/config":
			respond(w, 200, map[string]any{"workspace": s.workspace, "state_dir": s.state, "model": os.Getenv("OPENAI_MODEL"),
				"configured": os.Getenv("OPENAI_API_KEY") != "" && os.Getenv("OPENAI_MODEL") != "",
				"token":      s.token, "default_task": defaultTask, "history": map[string]int{"loaded": s.loaded, "skipped": s.skipped}})
		case "/api/runs":
			s.mu.Lock()
			for id, run := range s.runs {
				s.history[id] = summarizeRun(run)
			}
			items := sortedSummaries(s.history)
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
				stored, readErr := readStoredRun(s.state, id)
				if readErr != nil {
					respond(w, 404, map[string]any{"error": "运行记录不存在、尚未保存或格式无效"})
					return
				}
				raw, err = json.Marshal(stored)
			}
			if err != nil {
				respond(w, 500, map[string]any{"error": "无法读取记录"})
				return
			}
			writeResponse(w, 200, raw, "application/json; charset=utf-8")
		}
		return
	}
	recordID := strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, "/api/runs/"), "/open-record")
	openRecord := r.URL.Path == "/api/runs/"+recordID+"/open-record" && runIDPattern.MatchString(recordID)
	if r.Method != http.MethodPost || (r.URL.Path != "/api/runs" && !openRecord) {
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
	if openRecord {
		s.openRecord(w, r, recordID)
		return
	}
	var payload struct {
		ParentRunID string          `json:"parent_run_id"`
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
	var prior []Message
	if payload.ParentRunID != "" {
		// One linear conversation: reject an old head instead of silently forking it.
		for _, item := range s.history {
			if item.ParentRunID == payload.ParentRunID {
				s.mu.Unlock()
				respond(w, 409, map[string]any{"error": "这段对话已有后续消息，请刷新后继续"})
				return
			}
		}
		parent, readErr := readStoredRun(s.state, payload.ParentRunID)
		if readErr != nil {
			s.mu.Unlock()
			respond(w, 400, map[string]any{"error": "上一轮记录尚未保存或不可用，无法继续对话"})
			return
		}
		if parent.Workspace != s.workspace {
			s.mu.Unlock()
			respond(w, 400, map[string]any{"error": "当前工作区与这段历史不同，请切回原工作区或开始新任务"})
			return
		}
		prior, err = conversationMessages(s.state, parent)
		if err != nil {
			s.mu.Unlock()
			respond(w, 400, map[string]any{"error": err.Error()})
			return
		}
		run.ParentRunID, run.ConversationID, run.ConversationTurn = parent.ID, parent.ConversationID, max(1, parent.ConversationTurn)+1
		if run.ConversationID == "" {
			run.ConversationID = parent.ID
		}
	}
	sessionID := run.ConversationID
	if sessionID == "" {
		sessionID = run.ID
	}
	call, model, err := s.factory(sessionID)
	if err != nil {
		s.mu.Unlock()
		respond(w, 503, map[string]any{"error": "模型配置不可用，请设置 OPENAI_API_KEY、OPENAI_MODEL，以及可选 OPENAI_BASE_URL"})
		return
	}
	run.Model = model
	s.active = true
	s.runs[run.ID] = run
	s.history[run.ID] = summarizeRun(run)
	for len(s.runs) > 8 {
		for _, id := range sortedRunIDs(s.runs) {
			if id != run.ID {
				delete(s.runs, id)
				break
			}
		}
	}
	s.mu.Unlock()
	go func() {
		// A Run belongs to the server, not the browser connection that submitted it.
		err := RunTask(context.Background(), run, call, s.tools, filepath.Join(s.state, run.ID), &s.mu, prior)
		s.mu.Lock()
		defer s.mu.Unlock()
		if err != nil {
			run.Status = "failed"
			run.Error = map[string]any{"error_type": "StorageError", "message": "本地记录或执行异常"}
		}
		s.history[run.ID] = summarizeRun(run)
		s.active = false
	}()
	respond(w, 202, map[string]any{"id": run.ID})
}

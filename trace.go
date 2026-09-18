package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"path/filepath"
	"sync"
	"time"
)

type recorder struct {
	run     *Run
	mu      *sync.Mutex
	path    string
	started time.Time
}

func snapshot(value any) (map[string]any, error) {
	raw, err := json.Marshal(value)
	if err != nil {
		return nil, err
	}
	var object map[string]any
	err = json.Unmarshal(raw, &object)
	return object, err
}

func (r *recorder) begin(kind, title string, input any, code, explanation string) (*Event, error) {
	payload, err := snapshot(input)
	if err != nil {
		return nil, err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	event := &Event{ID: fmt.Sprintf("e%03d", len(r.run.Events)+1), Kind: kind, Title: title, Turn: r.run.ModelRequests,
		T: time.Since(r.started).Seconds(), Status: "running", Input: payload, Code: code, Explanation: explanation}
	if err = appendJSON(r.path, struct {
		Phase string `json:"phase"`
		*Event
	}{"start", event}); err != nil {
		return nil, err
	}
	r.run.Events = append(r.run.Events, event)
	return event, nil
}

func (r *recorder) finish(event *Event, output any, status string) error {
	payload, err := snapshot(output)
	if err != nil {
		return err
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	event.Output, event.Status, event.D = payload, status, time.Since(r.started).Seconds()-event.T
	return appendJSON(r.path, struct {
		Phase string `json:"phase"`
		*Event
	}{"finish", event})
}

func (r *recorder) instant(kind, title string, input, output any, code, explanation string) error {
	event, err := r.begin(kind, title, input, code, explanation)
	if err != nil {
		return err
	}
	return r.finish(event, output, "succeeded")
}

func RunTask(ctx context.Context, run *Run, call ModelCaller, tools []Tool, output string, mu *sync.Mutex, prior []Message) error {
	record := recorder{run: run, mu: mu, path: filepath.Join(output, "trace.jsonl"), started: time.Now()}
	session := filepath.Join(output, "session.jsonl")
	access, dispatch, executorName := readonlyAccess, "dispatch", "ExecuteReadonly"
	if run.Exercise == codingExercise {
		access, dispatch, executorName = codingAccess, "coding_dispatch", "ExecuteCoding"
	}
	allowedTools := []string{}
	for _, tool := range tools {
		allowedTools = append(allowedTools, tool.Function.Name)
	}
	model := func(ctx context.Context, input ModelRequest) (ModelResponse, error) {
		mu.Lock()
		run.ModelRequests++
		number := run.ModelRequests
		mu.Unlock()
		event, err := record.begin("model", fmt.Sprintf("第 %d 次模型请求", number), input, "loop",
			"这里记录实际发送的消息和工具定义。模型提出调用请求后，工具才会执行。")
		if err != nil {
			return ModelResponse{}, err
		}
		response, callErr := call(ctx, input)
		if callErr != nil {
			if err = record.finish(event, errorDetails(callErr), "failed"); err != nil {
				return ModelResponse{}, err
			}
			return ModelResponse{}, callErr
		}
		if len(response.Choices) != 1 {
			err = errors.New("invalid model choices")
			if recordErr := record.finish(event, errorDetails(err), "failed"); recordErr != nil {
				return ModelResponse{}, recordErr
			}
			return ModelResponse{}, err
		}
		choice := response.Choices[0]
		choice.Message.Role = "assistant"
		result := map[string]any{"finish_reason": choice.FinishReason, "message": choice.Message}
		if len(response.Usage) > 0 && string(response.Usage) != "null" {
			result["usage"] = response.Usage
		}
		if err = record.finish(event, result, "succeeded"); err != nil {
			return ModelResponse{}, err
		}
		return response, nil
	}
	execute := func(ctx context.Context, tool ToolCall) (string, error) {
		mu.Lock()
		run.ToolCalls++
		count := run.ToolCalls
		mu.Unlock()
		if err := record.instant("control", "选择工具执行器",
			map[string]any{"tool": tool.Function.Name, "arguments": tool.Function.Arguments, "tool_call_id": tool.ID},
			map[string]any{"executor": executorName, "allowed_tools": allowedTools, "exercise": run.Exercise}, dispatch,
			"这里选择受限执行器。参数与路径是否通过，以下一条工具事件的真实结果为准。"); err != nil {
			return "", err
		}
		code := dispatch
		if run.Exercise == codingExercise && tool.Function.Name == "write_file" {
			code = "write"
		}
		if run.Exercise == codingExercise && tool.Function.Name == "run_command" {
			code = "command"
		}
		if tool.Function.Name == "read_file" {
			code = "read"
		}
		if run.Exercise == "" && tool.Function.Name == "list_files" {
			code = "list"
		}
		event, err := record.begin("tool", tool.Function.Name, map[string]any{"arguments": tool.Function.Arguments, "tool_call_id": tool.ID}, code,
			"执行器返回真实结果；错误也会作为工具回执进入下一轮，并保留原调用编号。")
		if err != nil {
			return "", err
		}
		var result map[string]any
		if count > 24 {
			result = map[string]any{"error": "tool_budget_exhausted"}
		} else if run.Exercise == codingExercise {
			result, err = ExecuteCoding(ctx, run.Workspace, tool)
		} else {
			result, err = ExecuteReadonly(ctx, run.Workspace, tool)
		}
		if err != nil {
			if result == nil {
				result = errorDetails(err)
			}
			_ = record.finish(event, result, "failed")
			return "", err
		}
		status := "succeeded"
		if _, failed := result["error"]; failed {
			status = "failed"
			mu.Lock()
			run.ToolErrors++
			mu.Unlock()
		}
		if err = record.finish(event, result, status); err != nil {
			return "", err
		}
		raw, err := json.Marshal(result)
		if err != nil {
			return "", err
		}
		err = record.instant("control", "交回工具回执", map[string]any{"tool_call_id": tool.ID},
			map[string]any{"tool_call_id": tool.ID, "content": string(raw)}, "loop",
			"结果交回工具循环，随后作为 role=tool 消息追加，并与原 tool_call_id 配对。")
		return string(raw), err
	}
	work := func() (string, error) {
		messages, runtime := BuildTurnMessages(prior, run.Task, run.Workspace, access, time.Now())
		if err := record.instant("input", "提交任务", map[string]any{"task": run.Task, "exercise": run.Exercise, "conversation_turn": max(1, run.ConversationTurn), "parent_run_id": run.ParentRunID},
			map[string]any{"workspace": run.Workspace, "access": access, "exercise_authorized": run.Exercise != ""}, "loop",
			"用户消息成为本轮输入；追问会携带已有对话，读取新的文件内容仍须通过工具。"); err != nil {
			return "", err
		}
		if err := record.instant("control", "准备上下文和请求额度",
			map[string]any{"max_requests": run.MaxRequests, "tools": tools, "system": messages[0].Content, "runtime_context": runtime, "system_policy": "current_per_turn", "system_refreshed": len(prior) > 0, "history_messages": len(prior), "parent_run_id": run.ParentRunID}, map[string]any{"status": "ready"}, "context",
			"本轮使用最新系统规则和服务端日期、时区；保留历史用户、模型与工具消息，不改写旧记录。时间是本轮开始时的快照；额度只限制本轮模型请求次数。"); err != nil {
			return "", err
		}
		for _, message := range messages {
			if err := appendJSON(session, map[string]any{"type": "message", "message": message}); err != nil {
				return "", err
			}
		}
		return RunLoop(ctx, model, execute, run.Model, tools, messages, session, run.MaxRequests)
	}
	answer, runErr := work()
	status, title := "completed", "正常结束"
	var detail map[string]any
	if runErr != nil {
		status, title = "failed", "运行失败"
		detail = errorDetails(runErr)
		if errors.Is(runErr, errBudget) {
			status, title = "budget_exhausted", "达到请求上限"
		}
	}
	event, err := record.begin("control", title, map[string]any{"model_requests": run.ModelRequests, "max_requests": run.MaxRequests}, "loop",
		"正常结束只说明循环结束，不证明回答正确或任务验收通过。")
	if err == nil {
		eventStatus := "succeeded"
		if runErr != nil {
			eventStatus = "failed"
		}
		err = record.finish(event, map[string]any{"run_status": status, "task_result": "not_evaluated", "error": detail}, eventStatus)
	}
	mu.Lock()
	defer mu.Unlock()
	run.Status, run.Answer, run.Error, run.Duration = status, answer, detail, time.Since(record.started).Seconds()
	if err != nil {
		run.Status = "failed"
		run.Error = map[string]any{"error_type": "StorageError", "message": "本地运行记录写入失败"}
		return err
	}
	if err = saveRun(filepath.Join(output, "run.json"), run); err != nil {
		run.Status = "failed"
		run.Error = map[string]any{"error_type": "StorageError", "message": "本地运行记录保存失败"}
		return err
	}
	return nil
}

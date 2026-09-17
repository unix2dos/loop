package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
)

const maxReadBytes = 50 * 1024

var errBudget = errors.New("model request budget exhausted")

type ToolCall struct {
	ID       string `json:"id"`
	Type     string `json:"type"`
	Function struct {
		Name      string `json:"name"`
		Arguments string `json:"arguments"`
	} `json:"function"`
}

type Message struct {
	Role       string     `json:"role"`
	Content    string     `json:"content"`
	ToolCalls  []ToolCall `json:"tool_calls,omitempty"`
	ToolCallID string     `json:"tool_call_id,omitempty"`
}

type Tool struct {
	Type     string `json:"type"`
	Function struct {
		Name        string          `json:"name"`
		Description string          `json:"description"`
		Parameters  json.RawMessage `json:"parameters"`
	} `json:"function"`
}

type ModelRequest struct {
	Model    string    `json:"model"`
	Messages []Message `json:"messages"`
	Tools    []Tool    `json:"tools"`
}

type ModelResponse struct {
	Choices []struct {
		FinishReason string  `json:"finish_reason"`
		Message      Message `json:"message"`
	} `json:"choices"`
	Usage json.RawMessage `json:"usage,omitempty"`
}

type ModelCaller func(context.Context, ModelRequest) (ModelResponse, error)
type ToolExecutor func(context.Context, ToolCall) (string, error)

// RunLoop owns ordering and stopping; the caller supplies model and tool execution.
func RunLoop(ctx context.Context, call ModelCaller, execute ToolExecutor, model string, tools []Tool, messages []Message, session string, maxRequests int) (string, error) {
	if maxRequests < 1 || maxRequests > 8 {
		return "", errors.New("invalid request budget")
	}
	add := func(message Message) error {
		messages = append(messages, message)
		if session != "" {
			return appendJSON(session, map[string]any{"type": "message", "message": message})
		}
		return nil
	}
	for request := 0; request < maxRequests; request++ {
		if err := ctx.Err(); err != nil {
			return "", err
		}
		response, err := call(ctx, ModelRequest{Model: model, Messages: messages, Tools: tools})
		if err != nil {
			return "", err
		}
		if len(response.Choices) != 1 {
			return "", errors.New("expected one model choice")
		}
		choice := response.Choices[0]
		message := choice.Message
		message.Role, message.ToolCallID = "assistant", ""
		if err := add(message); err != nil {
			return "", err
		}
		if len(message.ToolCalls) > 0 {
			if choice.FinishReason != "tool_calls" {
				return "", errors.New("tool calls with inconsistent finish reason")
			}
			// Validate the whole batch before executing any requested action.
			ids := map[string]bool{}
			for _, tool := range message.ToolCalls {
				if tool.ID == "" || ids[tool.ID] || tool.Function.Name == "" || tool.Type != "function" {
					return "", errors.New("invalid tool call identity")
				}
				ids[tool.ID] = true
			}
			for _, tool := range message.ToolCalls {
				if err := ctx.Err(); err != nil {
					return "", err
				}
				result, err := execute(ctx, tool)
				if err != nil {
					return "", err
				}
				if err := add(Message{Role: "tool", Content: result, ToolCallID: tool.ID}); err != nil {
					return "", err
				}
			}
			continue
		}
		if choice.FinishReason == "stop" {
			return message.Content, nil
		}
		return "", fmt.Errorf("model did not stop normally: %s", choice.FinishReason)
	}
	return "", errBudget
}

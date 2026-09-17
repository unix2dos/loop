package main

import (
	"bytes"
	"encoding/json"
	"errors"
)

// Read the actual message ledger, including tool receipts. Never manufacture
// missing results or silently omit an unfinished tool batch from the context.
func conversationMessages(state string, parent *Run) ([]Message, error) {
	raw, err := readRunFile(state, parent.ID, "session.jsonl")
	if err != nil {
		return nil, errors.New("上一轮完整消息记录不可用，无法继续；请开始新任务")
	}
	messages := []Message{}
	pending := map[string]bool{}
	users := 0
	invalid := errors.New("上一轮消息记录不完整或工具回执未配对，无法继续；请开始新任务")
	for _, line := range bytes.Split(bytes.TrimSpace(raw), []byte("\n")) {
		var record struct {
			Type    string  `json:"type"`
			Message Message `json:"message"`
		}
		if json.Unmarshal(line, &record) != nil || record.Type != "message" {
			return nil, invalid
		}
		m := record.Message
		if len(messages) == 0 && m.Role != "system" {
			return nil, invalid
		}
		if len(pending) > 0 && m.Role != "tool" {
			return nil, invalid
		}
		if m.Role != "assistant" && len(m.ToolCalls) > 0 || m.Role != "tool" && m.ToolCallID != "" {
			return nil, invalid
		}
		switch m.Role {
		case "system":
			if len(messages) != 0 {
				return nil, invalid
			}
		case "user":
			users++
		case "assistant":
			for _, call := range m.ToolCalls {
				if call.ID == "" || pending[call.ID] || call.Type != "function" || call.Function.Name == "" {
					return nil, invalid
				}
				pending[call.ID] = true
			}
		case "tool":
			if !pending[m.ToolCallID] {
				return nil, invalid
			}
			delete(pending, m.ToolCallID)
		default:
			return nil, invalid
		}
		messages = append(messages, m)
	}
	if len(pending) > 0 || users != max(1, parent.ConversationTurn) {
		return nil, invalid
	}
	return messages, nil
}

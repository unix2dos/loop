package main

import (
	"encoding/json"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestTurnContextRefreshesWithoutRewritingHistory(t *testing.T) {
	call := ToolCall{ID: "read-1", Type: "function"}
	call.Function.Name, call.Function.Arguments = "read_file", `{"path":"note.md"}`
	prior := []Message{
		{Role: "system", Content: "旧策略：只准回答资料问题；日期为 2020-01-01"},
		{Role: "user", Content: "读取 note.md"},
		{Role: "assistant", ToolCalls: []ToolCall{call}},
		{Role: "tool", ToolCallID: call.ID, Content: `{"content":"原始工具结果"}`},
	}
	before, _ := json.Marshal(prior)
	instant := time.Date(2026, 9, 17, 16, 1, 0, 0, time.UTC)
	for _, sample := range []struct {
		name, date, zone, observed string
		now                        time.Time
	}{
		{"UTC", "2026-09-17", "UTC (UTC+00:00)", "2026-09-17T16:01:00Z", instant},
		{"local next day", "2026-09-18", "CST (UTC+08:00)", "2026-09-18T00:01:00+08:00", instant.In(time.FixedZone("CST", 8*3600))},
	} {
		t.Run(sample.name, func(t *testing.T) {
			messages, runtime := BuildTurnMessages(prior, "今天多少号", "/workspace", readonlyAccess, sample.now)
			if runtime.Date != sample.date || runtime.TimeZone != sample.zone || runtime.ObservedAt != sample.observed || runtime.Source != "server_clock" {
				t.Fatalf("wrong clock snapshot: %+v", runtime)
			}
			if !strings.HasPrefix(messages[0].Content, systemPrompt) || strings.Contains(messages[0].Content, "2020-01-01") || strings.Contains(messages[0].Content, "只准回答资料问题") {
				t.Fatal("stale system policy retained")
			}
			if !reflect.DeepEqual(messages[1:len(messages)-1], prior[1:]) || messages[len(messages)-1].Content != "今天多少号" {
				t.Fatal("user/assistant/tool history changed")
			}
			var embedded TurnContext
			if json.Unmarshal([]byte(strings.SplitN(messages[0].Content, "本轮运行时上下文：\n", 2)[1]), &embedded) != nil || embedded != runtime {
				t.Fatal("recorded context differs from model input")
			}
			next, tomorrow := BuildTurnMessages(messages, "现在呢", "/workspace", readonlyAccess, sample.now.Add(24*time.Hour))
			count := 0
			for _, message := range next {
				if message.Role == "system" {
					count++
				}
			}
			if count != 1 || tomorrow.Date == runtime.Date || len(next) != len(messages)+1 {
				t.Fatal("next turn accumulated system messages or reused yesterday")
			}
		})
	}
	after, _ := json.Marshal(prior)
	if string(before) != string(after) {
		t.Fatal("parent messages were modified")
	}
	fresh, _ := BuildTurnMessages(nil, "你好", "/workspace", readonlyAccess, instant)
	if len(fresh) != 2 || fresh[0].Role != "system" || fresh[1].Role != "user" {
		t.Fatal("new conversation contains unexpected history")
	}
}

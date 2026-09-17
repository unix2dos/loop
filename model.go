package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

type modelError struct {
	Type   string
	Status int
	Code   string
}

func (e *modelError) Error() string { return e.Type }

// HTTPModel preserves the reference's OpenAI-compatible format and no-retry policy.
func HTTPModel(runID string) (ModelCaller, string, error) {
	key, model := os.Getenv("OPENAI_API_KEY"), os.Getenv("OPENAI_MODEL")
	if key == "" || model == "" {
		return nil, "", errors.New("missing model configuration")
	}
	base := os.Getenv("OPENAI_BASE_URL")
	if base == "" {
		base = "https://api.openai.com/v1"
	}
	endpoint, err := url.Parse(base)
	if err != nil || (endpoint.Scheme != "https" && endpoint.Scheme != "http") || endpoint.Hostname() == "" {
		return nil, "", errors.New("invalid model endpoint")
	}
	endpoint.Path = strings.TrimRight(endpoint.Path, "/") + "/chat/completions"
	client := &http.Client{Timeout: 60 * time.Second}
	call := func(ctx context.Context, input ModelRequest) (ModelResponse, error) {
		raw, err := json.Marshal(input)
		if err != nil {
			return ModelResponse{}, err
		}
		request, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint.String(), bytes.NewReader(raw))
		if err != nil {
			return ModelResponse{}, &modelError{Type: "RequestError"}
		}
		request.Header.Set("Authorization", "Bearer "+key)
		request.Header.Set("Content-Type", "application/json")
		request.Header.Set("User-Agent", "levon/0.1")
		if endpoint.Hostname() == "opencode.ai" {
			request.Header.Set("x-opencode-session", runID)
		}
		response, err := client.Do(request)
		if err != nil {
			if ctx.Err() != nil {
				return ModelResponse{}, ctx.Err()
			}
			return ModelResponse{}, &modelError{Type: "ConnectionOrTimeoutError"}
		}
		defer response.Body.Close()
		raw, err = io.ReadAll(io.LimitReader(response.Body, (8<<20)+1))
		if err != nil || len(raw) > 8<<20 {
			return ModelResponse{}, &modelError{Type: "InvalidResponse"}
		}
		if response.StatusCode < 200 || response.StatusCode >= 300 {
			var body map[string]any
			_ = json.Unmarshal(raw, &body)
			code, _ := body["type"].(string)
			if code == "" {
				code, _ = body["code"].(string)
			}
			if !providerCodePattern.MatchString(code) {
				code = ""
			}
			return ModelResponse{}, &modelError{Type: "ProviderError", Status: response.StatusCode, Code: code}
		}
		var result ModelResponse
		if json.Unmarshal(raw, &result) != nil || len(result.Choices) != 1 {
			return ModelResponse{}, &modelError{Type: "InvalidResponse"}
		}
		return result, nil
	}
	return call, model, nil
}

func errorDetails(err error) map[string]any {
	result := map[string]any{"error_type": "RuntimeError", "message": "运行失败，请查看失败事件"}
	if errors.Is(err, errBudget) {
		result["message"] = "模型请求额度耗尽"
	}
	var provider *modelError
	if errors.As(err, &provider) {
		result["error_type"] = provider.Type
		if provider.Status != 0 {
			result["http_status"] = provider.Status
		}
		if provider.Code != "" {
			result["provider_error"] = provider.Code
		}
	}
	if errors.Is(err, context.Canceled) {
		result["error_type"] = "Canceled"
	}
	if errors.Is(err, context.DeadlineExceeded) {
		result["error_type"] = "DeadlineExceeded"
	}
	return result
}

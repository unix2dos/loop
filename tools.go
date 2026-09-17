package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"unicode/utf8"
)

func resolveWorkspace(workspace, name string) (string, error) {
	if name == "" || filepath.IsAbs(name) {
		return "", errors.New("relative path required")
	}
	root, err := filepath.EvalSymlinks(workspace)
	if err != nil {
		return "", err
	}
	root, err = filepath.Abs(root)
	if err != nil {
		return "", err
	}
	target, err := filepath.EvalSymlinks(filepath.Join(root, name))
	if err != nil {
		return "", err
	}
	relative, err := filepath.Rel(root, target)
	if err != nil || relative == ".." || strings.HasPrefix(relative, ".."+string(filepath.Separator)) {
		return "", errors.New("path escapes workspace")
	}
	return target, nil
}

func ReadFile(workspace, name string, offset int) (map[string]any, error) {
	if offset < 0 {
		return nil, errors.New("negative offset")
	}
	target, err := resolveWorkspace(workspace, name)
	if err != nil {
		return nil, err
	}
	file, err := os.Open(target)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	info, err := file.Stat()
	if err != nil || !info.Mode().IsRegular() {
		return nil, errors.New("ordinary file required")
	}
	if _, err = file.Seek(int64(offset), io.SeekStart); err != nil {
		return nil, err
	}
	raw, err := io.ReadAll(io.LimitReader(file, maxReadBytes+1))
	if err != nil {
		return nil, err
	}
	truncated := len(raw) > maxReadBytes
	var next any
	if truncated {
		raw = raw[:maxReadBytes]
		next = offset + len(raw)
	}
	if !utf8.Valid(raw) {
		return nil, errors.New("invalid UTF-8 range")
	}
	return map[string]any{"path": name, "content": string(raw), "truncated": truncated, "next_offset": next}, nil
}

func ListFiles(workspace, name string, offset, limit int) (map[string]any, error) {
	if offset < 0 || limit < 1 || limit > 100 {
		return nil, errors.New("invalid pagination")
	}
	target, err := resolveWorkspace(workspace, name)
	if err != nil {
		return nil, err
	}
	entries, err := os.ReadDir(target)
	if err != nil {
		return nil, err
	}
	files := []string{}
	for _, entry := range entries {
		if entry.Type()&os.ModeSymlink != 0 {
			continue
		}
		info, err := entry.Info()
		if err != nil {
			return nil, err
		}
		if info.Mode().IsRegular() {
			files = append(files, entry.Name())
		}
	}
	sort.Strings(files)
	start := min(offset, len(files))
	end := min(start+limit, len(files))
	var next any
	if end < len(files) {
		next = end
	}
	return map[string]any{"path": name, "files": files[start:end], "next_offset": next}, nil
}

func integerArgument(args map[string]json.RawMessage, key string, fallback int) (int, error) {
	raw, found := args[key]
	if !found {
		return fallback, nil
	}
	var value int
	if bytes.Equal(bytes.TrimSpace(raw), []byte("null")) || json.Unmarshal(raw, &value) != nil {
		return 0, errors.New("integer required")
	}
	return value, nil
}

func ExecuteReadonly(ctx context.Context, workspace string, call ToolCall) (map[string]any, error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	reject := func() (map[string]any, error) {
		return map[string]any{"error": "tool_rejected", "message": "请求不符合只读规则，或文件不可读取；检查工具名、相对路径和参数类型。"}, nil
	}
	args := map[string]json.RawMessage{}
	if json.Unmarshal([]byte(call.Function.Arguments), &args) != nil || args == nil {
		return reject()
	}
	var name string
	if json.Unmarshal(args["path"], &name) != nil || name == "" {
		return reject()
	}
	for _, part := range strings.Split(filepath.ToSlash(name), "/") {
		if strings.HasPrefix(part, ".") && part != "." {
			return reject()
		}
	}
	for key := range args {
		if key != "path" && key != "offset" && !(call.Function.Name == "list_files" && key == "limit") {
			return reject()
		}
	}
	offset, err := integerArgument(args, "offset", 0)
	if err != nil || offset < 0 {
		return reject()
	}
	var result map[string]any
	switch call.Function.Name {
	case "list_files":
		limit, parseErr := integerArgument(args, "limit", 20)
		if parseErr != nil {
			return reject()
		}
		result, err = ListFiles(workspace, name, offset, limit)
		if err == nil {
			markdown := []string{}
			for _, file := range result["files"].([]string) {
				if strings.HasSuffix(file, ".md") && !strings.HasPrefix(file, ".") {
					markdown = append(markdown, file)
				}
			}
			result["files"] = markdown
		}
	case "read_file":
		target, resolveErr := resolveWorkspace(workspace, name)
		info, statErr := os.Lstat(filepath.Join(workspace, name))
		if resolveErr != nil || statErr != nil || filepath.Ext(target) != ".md" || info.Mode()&os.ModeSymlink != 0 {
			return reject()
		}
		result, err = ReadFile(workspace, name, offset)
	default:
		return reject()
	}
	if err != nil {
		return reject()
	}
	return result, nil
}

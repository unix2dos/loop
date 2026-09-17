package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
)

// Walk only the requested JSON path. Decoder offsets refer to the original bytes,
// so indentation, escaped strings and identical values elsewhere cannot shift it.
func jsonOffset(raw []byte, path []string) (int, error) {
	if len(path) == 0 {
		return len(raw) - len(bytes.TrimLeft(raw, " \t\r\n")), nil
	}
	decoder := json.NewDecoder(bytes.NewReader(raw))
	token, err := decoder.Token()
	if err != nil || (token != json.Delim('{') && token != json.Delim('[')) {
		return 0, errors.New("JSON path not found")
	}
	for index := 0; decoder.More(); index++ {
		key := strconv.Itoa(index)
		if token == json.Delim('{') {
			name, err := decoder.Token()
			if err != nil {
				return 0, err
			}
			key = name.(string)
		}
		var value json.RawMessage
		if err := decoder.Decode(&value); err != nil {
			return 0, err
		}
		if key == path[0] {
			offset, err := jsonOffset(value, path[1:])
			return int(decoder.InputOffset()) - len(value) + offset, err
		}
	}
	return 0, errors.New("JSON path not found")
}

type recordLocation struct {
	Path string `json:"path"`
	Line int    `json:"line"`
}

func locateRecord(directory, id, eventID, field string) (recordLocation, error) {
	var location recordLocation
	if !eventIDPattern.MatchString(eventID) || (field != "" && !strings.HasPrefix(field, "/input") && !strings.HasPrefix(field, "/output")) {
		return location, errors.New("invalid event or field")
	}
	var segments []string
	if field != "" {
		for _, segment := range strings.Split(field[1:], "/") {
			segments = append(segments, strings.ReplaceAll(strings.ReplaceAll(segment, "~1", "/"), "~0", "~"))
		}
		if segments[0] != "input" && segments[0] != "output" {
			return location, errors.New("invalid field")
		}
	}
	raw, err := readRunFile(directory, id, "run.json")
	if err == nil {
		run, err := decodeHistory(raw, id)
		if err != nil {
			return location, err
		}
		for index, event := range run.Events {
			if event.ID != eventID {
				continue
			}
			offset, err := jsonOffset(raw, append([]string{"events", strconv.Itoa(index)}, segments...))
			if err != nil {
				return location, err
			}
			return recordLocation{filepath.Join(directory, id, "run.json"), bytes.Count(raw[:offset], []byte("\n")) + 1}, nil
		}
		return location, errors.New("event not found")
	}
	if !os.IsNotExist(err) {
		return location, err
	}
	raw, err = readRunFile(directory, id, "trace.jsonl")
	if err != nil {
		return location, err
	}
	// During a run, prefer the latest complete start/finish record for this event.
	// An unfinished last line is ignored while the recorder appends to the file.
	for index, line := range bytes.Split(raw, []byte("\n")) {
		var record struct {
			ID    string `json:"id"`
			Phase string `json:"phase"`
		}
		if json.Unmarshal(line, &record) != nil || record.ID != eventID || (record.Phase != "start" && record.Phase != "finish") {
			continue
		}
		if _, err := jsonOffset(line, segments); err == nil {
			location = recordLocation{filepath.Join(directory, id, "trace.jsonl"), index + 1}
		}
	}
	if location.Line == 0 {
		return location, errors.New("event not yet saved")
	}
	return location, nil
}

func recordEditorCommand(ctx context.Context, location recordLocation) (*exec.Cmd, string, error) {
	// Prefer the installed app CLI: a same-named terminal agent may shadow it in PATH.
	for _, candidate := range []struct{ path, name string }{
		{"/Applications/Cursor.app/Contents/Resources/app/bin/cursor", "Cursor"},
		{"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code", "VS Code"},
		{"cursor", "Cursor"}, {"code", "VS Code"},
	} {
		if executable, err := exec.LookPath(candidate.path); err == nil {
			return exec.CommandContext(ctx, executable, "--goto", location.Path+":"+strconv.Itoa(location.Line)), candidate.name, nil
		}
	}
	return nil, "", errors.New("未找到 Cursor 或 VS Code；请安装编辑器及其 cursor / code 命令")
}

func (s *Server) openRecord(w http.ResponseWriter, r *http.Request, id string) {
	var payload struct {
		EventID string `json:"event_id"`
		Field   string `json:"field"`
	}
	decoder := json.NewDecoder(http.MaxBytesReader(w, r.Body, 4096))
	decoder.DisallowUnknownFields()
	var extra any
	if decoder.Decode(&payload) != nil || decoder.Decode(&extra) != io.EOF {
		respond(w, 400, map[string]any{"error": "记录定位参数无效"})
		return
	}
	location, err := locateRecord(s.state, id, payload.EventID, payload.Field)
	if err != nil {
		respond(w, 404, map[string]any{"error": "未找到对应的本地记录或字段；请稍后重试"})
		return
	}
	ctx, cancel := context.WithTimeout(r.Context(), 10*time.Second)
	defer cancel()
	command, editor, err := recordEditorCommand(ctx, location)
	if err == nil {
		err = command.Run()
		if err != nil {
			err = errors.New("编辑器未能打开记录；请检查本机 cursor / code 命令")
		}
	}
	if err != nil {
		respond(w, 500, map[string]any{"error": err.Error()})
		return
	}
	respond(w, 200, struct {
		recordLocation
		Editor string `json:"editor"`
	}{location, editor})
}

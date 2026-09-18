package main

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

const codingExercise = "go-average"
const codingImage = "golang:1.24-bookworm@sha256:1a6d4452c65dea36aac2e2d606b01b4a029ec90cc1ae53890540ce6173ea77ac"
const codingTask = "修复 Average 在空切片或 nil 输入时发生的错误，保留非空输入的整数平均行为。先运行 go test ./... 确认问题，再读取代码并修改 average.go，最后重新运行测试，依据真实输出报告结果。不要修改测试或 go.mod。"
const codingAccess = "本次已授权独立 Go 练习：可以读取项目文件，仅可通过 write_file 修改 average.go。只允许运行 go test ./...，测试在断网、非 root、项目只读挂载的容器中执行。测试与 go.mod 受保护。测试失败应根据回执修正代码后再验证；不能声称未执行的测试已经通过。"

var exerciseFiles = []string{"README.md", "average.go", "average_test.go", "go.mod"}

func fileHash(raw []byte) string { sum := sha256.Sum256(raw); return hex.EncodeToString(sum[:]) }

func dockerCommand(ctx context.Context, args ...string) *exec.Cmd {
	cmd := exec.CommandContext(ctx, "docker", args...)
	// Docker CLI needs its own connection settings, never model-service credentials.
	for _, key := range []string{"PATH", "HOME", "DOCKER_HOST", "DOCKER_CONTEXT", "DOCKER_CONFIG", "DOCKER_TLS_VERIFY", "DOCKER_CERT_PATH", "XDG_RUNTIME_DIR", "TMPDIR"} {
		if value, ok := os.LookupEnv(key); ok {
			cmd.Env = append(cmd.Env, key+"="+value)
		}
	}
	cmd.WaitDelay = 2 * time.Second
	return cmd
}

func codingReady() error {
	ctx, cancel := context.WithTimeout(context.Background(), 4*time.Second)
	defer cancel()
	if err := dockerCommand(ctx, "image", "inspect", codingImage).Run(); err != nil {
		return errors.New("请先启动 Docker，并按 Coding 练习文档准备 Go 镜像")
	}
	return nil
}

func exerciseTemplate(name string) ([]byte, error) {
	if name == "go.mod" {
		name = "go.mod.txt"
	}
	return assets.ReadFile("testdata/go-average/" + name)
}

func prepareExercise(state, id string) (string, error) {
	if !runIDPattern.MatchString(id) {
		return "", errors.New("invalid exercise ID")
	}
	folder := filepath.Join(state, id, "workspace")
	if err := os.MkdirAll(filepath.Dir(folder), 0700); err != nil {
		return "", err
	}
	if err := os.Mkdir(folder, 0755); err != nil {
		return "", err
	}
	for _, name := range exerciseFiles {
		raw, err := exerciseTemplate(name)
		if err != nil {
			return "", err
		}
		if err := os.WriteFile(filepath.Join(folder, name), raw, 0644); err != nil {
			return "", err
		}
	}
	return folder, nil
}

func checkExercise(workspace string) error {
	info, err := os.Lstat(workspace)
	if err != nil || !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return errors.New("练习目录不可用")
	}
	entries, err := os.ReadDir(workspace)
	if err != nil {
		return err
	}
	if len(entries) != len(exerciseFiles) {
		return errors.New("练习项目出现了未授权的文件，请检查项目")
	}
	for _, name := range exerciseFiles {
		info, err := os.Lstat(filepath.Join(workspace, name))
		if err != nil || !info.Mode().IsRegular() || info.Mode()&os.ModeSymlink != 0 || info.Size() > maxReadBytes {
			return errors.New("练习文件类型或大小无效")
		}
		raw, err := os.ReadFile(filepath.Join(workspace, name))
		if err != nil {
			return err
		}
		if !utf8.Valid(raw) {
			return errors.New("练习文件不是 UTF-8 文本")
		}
		if name != "average.go" {
			expected, err := exerciseTemplate(name)
			if err != nil || !bytes.Equal(raw, expected) {
				return errors.New("受保护的练习材料已变化，请开始新的练习")
			}
		}
	}
	return nil
}

func ExecuteCoding(ctx context.Context, workspace string, call ToolCall) (map[string]any, error) {
	reject := func(message string) (map[string]any, error) {
		return map[string]any{"error": "tool_rejected", "message": message}, nil
	}
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	if err := checkExercise(workspace); err != nil {
		return reject(err.Error())
	}
	var args struct {
		Path     string `json:"path"`
		Content  string `json:"content"`
		Expected string `json:"expected_sha256"`
		Command  string `json:"command"`
	}
	fields, err := requiredObject([]byte(call.Function.Arguments))
	if err != nil || json.Unmarshal([]byte(call.Function.Arguments), &args) != nil {
		return reject("工具参数必须是正确的 JSON 对象")
	}
	allowed := map[string]bool{"path": true}
	if call.Function.Name == "write_file" {
		allowed["content"], allowed["expected_sha256"] = true, true
	}
	if call.Function.Name == "run_command" {
		allowed = map[string]bool{"command": true}
	}
	for field := range fields {
		if !allowed[field] {
			return reject("包含未允许的参数")
		}
	}
	switch call.Function.Name {
	case "list_files":
		if args.Path != "." {
			return reject("本练习只允许列出根目录 .")
		}
		return map[string]any{"path": ".", "files": exerciseFiles, "next_offset": nil}, nil
	case "read_file":
		found := false
		for _, name := range exerciseFiles {
			if args.Path == name {
				found = true
			}
		}
		if !found {
			return reject("只能读取本练习列出的四份文件")
		}
		result, err := ReadFile(workspace, args.Path, 0)
		if err != nil {
			return reject("文件不可读取")
		}
		result["sha256"] = fileHash([]byte(result["content"].(string)))
		return result, nil
	case "write_file":
		return WriteExerciseFile(workspace, args.Path, args.Content, args.Expected)
	case "run_command":
		if args.Command != "go test ./..." {
			return reject("本练习仅允许命令 go test ./...")
		}
		return RunExerciseTests(ctx, workspace)
	default:
		return reject("未提供这个工具")
	}
}

// ponytail: the isolated exercise has one active writer. This catches stale
// reads; shared workspaces need coordinated writes beyond a check/rename pair.
func WriteExerciseFile(workspace, path, content, expected string) (map[string]any, error) {
	reject := func(code, message string) (map[string]any, error) {
		return map[string]any{"error": code, "message": message}, nil
	}
	if path != "average.go" || len(content) == 0 || len(content) > maxReadBytes || !utf8.ValidString(content) {
		return reject("tool_rejected", "只允许修改 average.go，内容须为不超过 50 KiB 的 UTF-8 文本")
	}
	if err := checkExercise(workspace); err != nil {
		return reject("tool_rejected", err.Error())
	}
	target := filepath.Join(workspace, path)
	before, err := os.ReadFile(target)
	if err != nil {
		return nil, err
	}
	if expected != fileHash(before) {
		return reject("file_changed", "文件版本与读取时不同，本次没有写入；请重新读取后再修改")
	}
	if string(before) == content {
		return map[string]any{"path": path, "changed": false, "sha256": expected}, nil
	}
	file, err := os.CreateTemp(workspace, ".average-*")
	if err != nil {
		return nil, err
	}
	defer os.Remove(file.Name())
	if err = file.Chmod(0644); err == nil {
		_, err = file.WriteString(content)
	}
	if err == nil {
		err = file.Sync()
	}
	closeErr := file.Close()
	if err != nil {
		return nil, err
	}
	if closeErr != nil {
		return nil, closeErr
	}
	if err = os.Rename(file.Name(), target); err != nil {
		return nil, err
	}
	return map[string]any{"path": path, "changed": true, "before_sha256": expected, "sha256": fileHash([]byte(content)), "before": string(before), "after": content, "diff": exerciseDiff(string(before), content)}, nil
}

func exerciseDiff(before, after string) string {
	lines := func(s string) []string {
		if s == "" {
			return nil
		}
		return strings.Split(strings.TrimSuffix(s, "\n"), "\n")
	}
	old, next := lines(before), lines(after)
	var diff strings.Builder
	fmt.Fprintf(&diff, "--- a/average.go\n+++ b/average.go\n@@ -1,%d +1,%d @@\n", len(old), len(next))
	for _, side := range []struct {
		prefix, text string
		lines        []string
	}{{"-", before, old}, {"+", after, next}} {
		for _, line := range side.lines {
			diff.WriteString(side.prefix + line + "\n")
		}
		if len(side.lines) > 0 && !strings.HasSuffix(side.text, "\n") {
			diff.WriteString("\\ No newline at end of file\n")
		}
	}
	return diff.String()
}

type cappedOutput struct {
	bytes.Buffer
	truncated bool
}

func (b *cappedOutput) Write(p []byte) (int, error) {
	n := len(p)
	left := 64*1024 - b.Len()
	if len(p) > left {
		p = p[:left]
		b.truncated = true
	}
	_, _ = b.Buffer.Write(p)
	return n, nil
}

// Test code is arbitrary code. Only the exercise is mounted, and it is read-only:
// modifications must go through the bounded file tool, not through a test process.
func exerciseContainerArgs(workspace, name string) []string {
	return []string{"create", "--name", name, "--pull", "never", "--network", "none", "--read-only", "--cap-drop", "ALL", "--security-opt", "no-new-privileges", "--pids-limit", "128", "--memory", "768m", "--cpus", "2", "--user", "65532:65532", "--tmpfs", "/tmp:rw,exec,nosuid,size=256m", "--mount", "type=bind,src=" + workspace + ",dst=/workspace,readonly", "--workdir", "/workspace", "--env", "HOME=/tmp", "--env", "GOCACHE=/tmp/go-cache", "--env", "GOPATH=/tmp/go-path", "--env", "GOTOOLCHAIN=local", "--env", "GOPROXY=off", "--env", "GOSUMDB=off", "--env", "CGO_ENABLED=0", "--env", "GOMAXPROCS=2", codingImage, "go", "test", "-count=1", "./..."}
}

func RunExerciseTests(ctx context.Context, workspace string) (result map[string]any, returnErr error) {
	if err := ctx.Err(); err != nil {
		return nil, err
	}
	id, err := randomID()
	if err != nil {
		return nil, err
	}
	name := "loop-exercise-" + id
	result = map[string]any{"command": "go test -count=1 ./...", "image": codingImage, "network": "none", "workspace_mount": "read-only", "exit_code": nil, "timed_out": false}
	raw, err := os.ReadFile(filepath.Join(workspace, "average.go"))
	if err != nil {
		return nil, err
	}
	result["tested_sha256"] = fileHash(raw)
	// Finish this short control-plane operation even if the caller cancels so a
	// known container can be removed; code does not run until the attach step.
	createCtx, cancelCreate := context.WithTimeout(context.Background(), 10*time.Second)
	created, err := dockerCommand(createCtx, exerciseContainerArgs(workspace, name)...).Output()
	cancelCreate()
	if err != nil {
		return map[string]any{"error": "container_create_failed", "container_name": name, "message": "无法确认容器创建结果；代码尚未启动，请检查 Docker 与该容器名称"}, errors.New("exercise container unavailable")
	}
	container := strings.TrimSpace(string(created))
	decoded, decodeErr := hex.DecodeString(container)
	if decodeErr != nil || len(decoded) != 32 {
		return nil, errors.New("invalid container identity")
	}
	result["container_id"] = container
	defer func() {
		cleanupCtx, cancel := context.WithTimeout(context.Background(), 10*time.Second)
		defer cancel()
		output, err := dockerCommand(cleanupCtx, "rm", "--force", container).CombinedOutput()
		if err != nil && !strings.Contains(string(output), "No such container") {
			result["cleanup_confirmed"] = false
			returnErr = errors.New("练习容器清理未确认，请停止并检查 Docker")
			return
		}
		result["cleanup_confirmed"] = true
	}()
	runCtx, cancelRun := context.WithTimeout(ctx, 90*time.Second)
	defer cancelRun()
	cmd := dockerCommand(runCtx, "start", "--attach", container)
	var stdout, stderr cappedOutput
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr
	startErr := cmd.Run()
	result["stdout"], result["stderr"], result["output_truncated"] = stdout.String(), stderr.String(), stdout.truncated || stderr.truncated
	if runCtx.Err() != nil {
		result["error"], result["timed_out"] = "command_timeout", true
		return result, nil
	}
	inspectCtx, cancelInspect := context.WithTimeout(context.Background(), 5*time.Second)
	state, err := dockerCommand(inspectCtx, "inspect", "--format", "{{.State.Running}} {{.State.ExitCode}}", container).Output()
	cancelInspect()
	parts := strings.Fields(string(state))
	if err != nil || len(parts) != 2 || parts[0] != "false" {
		return result, errors.New("无法确认测试进程退出状态")
	}
	code, err := strconv.Atoi(parts[1])
	if err != nil {
		return result, errors.New("invalid test exit code")
	}
	result["exit_code"] = code
	if code != 0 {
		result["error"] = "command_failed"
	} else if startErr != nil {
		return result, fmt.Errorf("测试连接异常：%w", startErr)
	}
	return result, nil
}

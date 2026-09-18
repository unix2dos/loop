package main

import (
	"embed"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"path/filepath"
	"strconv"
	"time"
)

//go:embed index.html tools.json coding-tools.json *.go web/dist/*.js assets/branding/loop-icon-v1.png testdata/go-average/*
var assets embed.FS

const defaultTask = "先列出工作区文件，再读取与工具调用最相关的一份笔记。根据原文说明：模型提出工具调用之后，程序还要做什么？请注明文件名和原文依据，只读，不修改文件。"

func main() {
	workspace := flag.String("workspace", "workspace", "只读 Markdown 工作区")
	state := flag.String("state-dir", defaultStateDir(), "运行记录目录")
	port := flag.Int("port", 8877, "本机 HTTP 端口")
	flag.Parse()
	if err := migrateLegacyState(*state); err != nil {
		log.Fatal(err)
	}
	addr, err := listenAddr(*port)
	if err != nil {
		log.Fatal(err)
	}
	app, err := NewServer(*workspace, *state, HTTPModel)
	if err != nil {
		log.Fatal(err)
	}
	listener, err := net.Listen("tcp", addr)
	if err != nil {
		log.Fatal(err)
	}
	fmt.Printf("Loop：http://%s\n只读 Markdown 工作区：%s\n", listener.Addr(), app.workspace)
	server := &http.Server{Handler: app, ReadHeaderTimeout: 5 * time.Second, ReadTimeout: 10 * time.Second, WriteTimeout: 30 * time.Second, IdleTimeout: 60 * time.Second}
	log.Fatal(server.Serve(listener))
}

func defaultStateDir() string {
	home, err := os.UserHomeDir()
	if err != nil || home == "" {
		return filepath.Join(".agent_state", "runs")
	}
	return filepath.Join(home, ".loop", "runs")
}

func migrateLegacyState(dst string) error {
	if dst != defaultStateDir() {
		return nil
	}
	legacy := ".agent_state"
	info, err := os.Lstat(legacy)
	if err != nil {
		if os.IsNotExist(err) {
			return nil
		}
		return err
	}
	if !info.IsDir() || info.Mode()&os.ModeSymlink != 0 {
		return nil
	}
	parent := filepath.Dir(dst)
	if _, err := os.Lstat(parent); err == nil {
		legacyRuns := filepath.Join(legacy, "runs")
		if _, err := os.Stat(dst); err == nil {
			return nil
		}
		if _, err := os.Stat(legacyRuns); err != nil {
			return nil
		}
		if err := os.MkdirAll(parent, 0700); err != nil {
			return err
		}
		return os.Rename(legacyRuns, dst)
	}
	if err := os.MkdirAll(filepath.Dir(parent), 0700); err != nil {
		return err
	}
	return os.Rename(legacy, parent)
}

func listenAddr(flagPort int) (string, error) {
	port := flagPort
	if value := os.Getenv("PORT"); value != "" {
		number, err := strconv.Atoi(value)
		if err != nil || number < 1 || number > 65535 {
			return "", fmt.Errorf("invalid PORT")
		}
		port = number
	}
	host := "127.0.0.1"
	if os.Getenv("LOOP_PUBLIC") == "1" {
		host = "0.0.0.0"
	}
	return fmt.Sprintf("%s:%d", host, port), nil
}

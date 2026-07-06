package main

import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"mime"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/gorilla/websocket"
)

const maxResponseBytes = 10 * 1024 * 1024
const defaultServerURL = "wss://share.xxyy.eu.org/tunnel"
const defaultPublicBaseURL = "https://share.xxyy.eu.org"
const defaultShareToken = "69a00c76d73257a4369f868d71ffdccaeb6391fcb6cc074b"

type config struct {
	serverURL     string
	publicBaseURL string
	token         string
	filePath      string
	dirPath       string
	entry         string
	slug          string
	cacheTTL      int
}

type registerMessage struct {
	Type      string       `json:"type"`
	SessionID string       `json:"sessionId"`
	Token     string       `json:"token"`
	Cache     cacheRequest `json:"cache"`
}

type incomingMessage struct {
	Type    string       `json:"type"`
	ID      string       `json:"id"`
	Method  string       `json:"method"`
	Path    string       `json:"path"`
	Visitor *visitorInfo `json:"visitor"`
	Cache   *cachePolicy `json:"cache"`
}

type cacheRequest struct {
	Enabled    bool `json:"enabled"`
	TTLSeconds int  `json:"ttlSeconds"`
}

type cachePolicy struct {
	Enabled    bool `json:"enabled"`
	TTLSeconds int  `json:"ttlSeconds"`
	MaxEntries int  `json:"maxEntries"`
	MaxBytes   int  `json:"maxBytes"`
}

type visitorInfo struct {
	IP        string `json:"ip"`
	UserAgent string `json:"userAgent"`
	Referer   string `json:"referer"`
	At        string `json:"at"`
}

type responseMessage struct {
	Type        string `json:"type"`
	ID          string `json:"id"`
	Status      int    `json:"status"`
	ContentType string `json:"contentType,omitempty"`
	Size        int    `json:"size,omitempty"`
	Body        string `json:"body,omitempty"`
	Error       string `json:"error,omitempty"`
}

type publishRequest struct {
	Slug  string        `json:"slug"`
	Entry string        `json:"entry"`
	Files []publishFile `json:"files"`
}

type publishFile struct {
	Path        string `json:"path"`
	ContentType string `json:"contentType"`
	SHA256      string `json:"sha256"`
	Size        int    `json:"size"`
	Body        string `json:"body"`
}

type publishResponse struct {
	OK    bool   `json:"ok"`
	Slug  string `json:"slug"`
	Entry string `json:"entry"`
	Files int    `json:"files"`
	Bytes int    `json:"bytes"`
	URL   string `json:"url"`
	Error string `json:"error"`
}

type userAgentInfo struct {
	Browser string
	OS      string
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()

	if len(os.Args) > 1 && os.Args[1] == "publish" {
		cfg, err := loadPublishConfig(os.Args[2:])
		if err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(64)
		}
		if err := runPublish(ctx, cfg); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		return
	}

	cfg, err := loadConfig(os.Args[1:])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(64)
	}

	if err := run(ctx, cfg); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}

func loadConfig(args []string) (config, error) {
	env := readClientEnv()

	defaultServer := firstNonEmpty(os.Getenv("HTMLSHARE_SERVER"), env["HTMLSHARE_SERVER"], defaultServerURL)
	defaultPublicBase := firstNonEmpty(os.Getenv("PUBLIC_BASE_URL"), env["PUBLIC_BASE_URL"], publicBaseFromServer(defaultServer), defaultPublicBaseURL)
	defaultToken := firstNonEmpty(os.Getenv("SHARE_TOKEN"), env["SHARE_TOKEN"], defaultShareToken)

	cfg := config{}
	cacheTTL := ""
	flags := flag.NewFlagSet("htmlshare-go", flag.ContinueOnError)
	flags.StringVar(&cfg.serverURL, "server", defaultServer, "WebSocket relay URL, e.g. wss://share.example.com/tunnel")
	flags.StringVar(&cfg.publicBaseURL, "public-base-url", defaultPublicBase, "Public HTTP base URL, e.g. https://share.example.com")
	flags.StringVar(&cfg.token, "token", defaultToken, "Share token")
	flags.StringVar(&cfg.filePath, "file", "", "HTML file to share")
	flags.StringVar(&cacheTTL, "cache-ttl", "0", "Request server cache TTL for this share, e.g. 10m, 1d, 1w; 0 disables cache")
	if err := flags.Parse(args); err != nil {
		return cfg, err
	}

	if cfg.filePath == "" && flags.NArg() > 0 {
		cfg.filePath = flags.Arg(0)
	}
	if cfg.serverURL == "" {
		return cfg, errors.New("missing server URL: set HTMLSHARE_SERVER or pass --server")
	}
	if cfg.publicBaseURL == "" {
		return cfg, errors.New("missing public base URL: set PUBLIC_BASE_URL or pass --public-base-url")
	}
	if cfg.filePath == "" {
		return cfg, errors.New("missing file: pass --file /path/to/file.html")
	}
	ttlSeconds, err := parseDurationSeconds(cacheTTL)
	if err != nil {
		return cfg, err
	}
	cfg.cacheTTL = ttlSeconds
	return cfg, nil
}

func loadPublishConfig(args []string) (config, error) {
	env := readClientEnv()

	defaultServer := firstNonEmpty(os.Getenv("HTMLSHARE_SERVER"), env["HTMLSHARE_SERVER"], defaultServerURL)
	defaultPublicBase := firstNonEmpty(os.Getenv("PUBLIC_BASE_URL"), env["PUBLIC_BASE_URL"], publicBaseFromServer(defaultServer), defaultPublicBaseURL)
	defaultToken := firstNonEmpty(os.Getenv("SHARE_TOKEN"), env["SHARE_TOKEN"], defaultShareToken)

	cfg := config{
		serverURL:     defaultServer,
		publicBaseURL: defaultPublicBase,
		token:         defaultToken,
		entry:         "index.html",
	}
	flags := flag.NewFlagSet("htmlshare-go publish", flag.ContinueOnError)
	flags.StringVar(&cfg.serverURL, "server", cfg.serverURL, "WebSocket relay URL used to infer public base URL")
	flags.StringVar(&cfg.publicBaseURL, "public-base-url", cfg.publicBaseURL, "Public HTTP base URL, e.g. https://share.example.com")
	flags.StringVar(&cfg.token, "token", cfg.token, "Share token")
	flags.StringVar(&cfg.filePath, "file", "", "Entry HTML file to publish")
	flags.StringVar(&cfg.dirPath, "dir", "", "Directory to publish")
	flags.StringVar(&cfg.entry, "entry", cfg.entry, "Entry file inside --dir")
	flags.StringVar(&cfg.slug, "slug", "", "Permanent publish slug")
	if err := flags.Parse(args); err != nil {
		return cfg, err
	}

	if cfg.slug == "" {
		return cfg, errors.New("missing slug: pass --slug demo")
	}
	if cfg.filePath == "" && cfg.dirPath == "" {
		return cfg, errors.New("missing publish source: pass --file /path/to/index.html or --dir /path/to/site")
	}
	if cfg.filePath != "" && cfg.dirPath != "" {
		return cfg, errors.New("pass only one of --file or --dir")
	}
	if cfg.publicBaseURL == "" {
		return cfg, errors.New("missing public base URL: set PUBLIC_BASE_URL or pass --public-base-url")
	}
	if cfg.token == "" {
		return cfg, errors.New("missing share token: set SHARE_TOKEN or pass --token")
	}
	return cfg, nil
}

func run(ctx context.Context, cfg config) error {
	filePath, err := filepath.EvalSymlinks(cfg.filePath)
	if err != nil {
		return err
	}
	info, err := os.Stat(filePath)
	if err != nil {
		return err
	}
	if !info.Mode().IsRegular() {
		return fmt.Errorf("not a file: %s", filePath)
	}

	rootDir, err := filepath.EvalSymlinks(filepath.Dir(filePath))
	if err != nil {
		return err
	}
	entryName := filepath.Base(filePath)
	sessionID, err := randomID(8)
	if err != nil {
		return err
	}
	shareURL := strings.TrimRight(cfg.publicBaseURL, "/") + "/s/" + sessionID + "/" + url.PathEscape(entryName)

	conn, _, err := websocket.DefaultDialer.DialContext(ctx, cfg.serverURL, nil)
	if err != nil {
		return err
	}
	defer conn.Close()

	if err := conn.WriteJSON(registerMessage{
		Type:      "register",
		SessionID: sessionID,
		Token:     cfg.token,
		Cache: cacheRequest{
			Enabled:    cfg.cacheTTL > 0,
			TTLSeconds: cfg.cacheTTL,
		},
	}); err != nil {
		return err
	}

	go func() {
		<-ctx.Done()
		_ = conn.WriteMessage(websocket.CloseMessage, websocket.FormatCloseMessage(websocket.CloseNormalClosure, ""))
		_ = conn.Close()
	}()

	for {
		var message incomingMessage
		if err := conn.ReadJSON(&message); err != nil {
			if ctx.Err() != nil {
				return nil
			}
			return err
		}

		switch message.Type {
		case "registered":
			fmt.Println("Share URL:")
			fmt.Println(shareURL)
			if message.Cache != nil && message.Cache.Enabled {
				fmt.Printf("Cache: %s\n", formatCacheDuration(message.Cache.TTLSeconds))
			} else {
				fmt.Println("Cache: off")
			}
			fmt.Println("Keep this process running while sharing. Press Ctrl+C to stop.")
			fmt.Println()
			fmt.Printf("%-8s %-15s %-16s %-18s %-6s %-8s %s\n", "TIME", "IP", "BROWSER", "OS", "STATUS", "BYTES", "PATH")
		case "request":
			response := handleFileRequest(rootDir, message.ID, message.Path)
			if err := conn.WriteJSON(response); err != nil {
				return err
			}
			printVisit(message, response)
		}
	}
}

func runPublish(ctx context.Context, cfg config) error {
	rootDir, entry, err := publishRootAndEntry(cfg)
	if err != nil {
		return err
	}

	files, err := collectPublishFiles(rootDir)
	if err != nil {
		return err
	}
	if len(files) == 0 {
		return errors.New("publish directory has no files")
	}
	if !hasPublishEntry(files, entry) {
		return fmt.Errorf("entry file is missing from publish directory: %s", entry)
	}

	requestPayload := publishRequest{
		Slug:  cfg.slug,
		Entry: entry,
		Files: files,
	}
	body, err := json.Marshal(requestPayload)
	if err != nil {
		return err
	}

	endpoint := strings.TrimRight(cfg.publicBaseURL, "/") + "/api/publish"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, bytes.NewReader(body))
	if err != nil {
		return err
	}
	req.Header.Set("Authorization", "Bearer "+cfg.token)
	req.Header.Set("Content-Type", "application/json")

	resp, err := http.DefaultClient.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	var publishResp publishResponse
	if err := json.NewDecoder(resp.Body).Decode(&publishResp); err != nil {
		return err
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 || !publishResp.OK {
		if publishResp.Error != "" {
			return errors.New(publishResp.Error)
		}
		return fmt.Errorf("publish failed with HTTP %d", resp.StatusCode)
	}

	publishedURL := strings.TrimRight(cfg.publicBaseURL, "/") + firstNonEmpty(publishResp.URL, "/p/"+cfg.slug+"/")
	fmt.Println("Published URL:")
	fmt.Println(publishedURL)
	fmt.Printf("Files: %d\n", publishResp.Files)
	fmt.Printf("Bytes: %d\n", publishResp.Bytes)
	return nil
}

func publishRootAndEntry(cfg config) (string, string, error) {
	if cfg.filePath != "" {
		filePath, err := filepath.EvalSymlinks(cfg.filePath)
		if err != nil {
			return "", "", err
		}
		info, err := os.Stat(filePath)
		if err != nil {
			return "", "", err
		}
		if !info.Mode().IsRegular() {
			return "", "", fmt.Errorf("not a file: %s", filePath)
		}
		rootDir, err := filepath.EvalSymlinks(filepath.Dir(filePath))
		if err != nil {
			return "", "", err
		}
		return rootDir, filepath.Base(filePath), nil
	}

	rootDir, err := filepath.EvalSymlinks(cfg.dirPath)
	if err != nil {
		return "", "", err
	}
	info, err := os.Stat(rootDir)
	if err != nil {
		return "", "", err
	}
	if !info.IsDir() {
		return "", "", fmt.Errorf("not a directory: %s", rootDir)
	}
	entry := filepath.ToSlash(filepath.Clean(cfg.entry))
	if entry == "." || strings.HasPrefix(entry, "../") || strings.HasPrefix(entry, "/") {
		return "", "", fmt.Errorf("invalid entry path: %s", cfg.entry)
	}
	return rootDir, entry, nil
}

func collectPublishFiles(rootDir string) ([]publishFile, error) {
	resolvedRoot, err := filepath.EvalSymlinks(rootDir)
	if err != nil {
		return nil, err
	}
	files := []publishFile{}
	err = filepath.WalkDir(resolvedRoot, func(pathValue string, entry os.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Name() == ".DS_Store" {
			return nil
		}
		if entry.IsDir() {
			return nil
		}
		if entry.Type()&os.ModeSymlink != 0 {
			resolvedPath, err := filepath.EvalSymlinks(pathValue)
			if err != nil {
				return err
			}
			if !isInsideRoot(resolvedRoot, resolvedPath) {
				return fmt.Errorf("refusing to publish file outside directory: %s", pathValue)
			}
			return nil
		}
		info, err := entry.Info()
		if err != nil {
			return err
		}
		if !info.Mode().IsRegular() {
			return nil
		}
		resolvedPath, err := filepath.EvalSymlinks(pathValue)
		if err != nil {
			return err
		}
		if !isInsideRoot(resolvedRoot, resolvedPath) {
			return fmt.Errorf("refusing to publish file outside directory: %s", pathValue)
		}
		data, err := os.ReadFile(resolvedPath)
		if err != nil {
			return err
		}
		relative, err := filepath.Rel(resolvedRoot, resolvedPath)
		if err != nil {
			return err
		}
		relative = filepath.ToSlash(relative)
		sum := sha256.Sum256(data)
		files = append(files, publishFile{
			Path:        relative,
			ContentType: contentType(resolvedPath),
			SHA256:      hex.EncodeToString(sum[:]),
			Size:        len(data),
			Body:        base64.StdEncoding.EncodeToString(data),
		})
		return nil
	})
	return files, err
}

func isInsideRoot(rootDir, candidate string) bool {
	rootWithSep := rootDir
	if !strings.HasSuffix(rootWithSep, string(filepath.Separator)) {
		rootWithSep += string(filepath.Separator)
	}
	return candidate == rootDir || strings.HasPrefix(candidate, rootWithSep)
}

func hasPublishEntry(files []publishFile, entry string) bool {
	for _, file := range files {
		if file.Path == entry {
			return true
		}
	}
	return false
}

func handleFileRequest(rootDir, requestID, requestPath string) responseMessage {
	if requestPath == "" {
		requestPath = "/"
	}
	candidate, err := safeResolve(rootDir, requestPath)
	if err != nil {
		return errorResponse(requestID, 404, "Not found\n")
	}

	info, err := os.Stat(candidate)
	if err != nil || !info.Mode().IsRegular() {
		return errorResponse(requestID, 404, "Not found\n")
	}
	if info.Size() > maxResponseBytes {
		return errorResponse(requestID, 413, "File is too large for this share.\n")
	}

	body, err := os.ReadFile(candidate)
	if err != nil {
		return errorResponse(requestID, 404, "Not found\n")
	}

	return responseMessage{
		Type:        "response",
		ID:          requestID,
		Status:      200,
		ContentType: contentType(candidate),
		Size:        len(body),
		Body:        base64.StdEncoding.EncodeToString(body),
	}
}

func safeResolve(rootDir, requestPath string) (string, error) {
	resolvedRoot, err := filepath.EvalSymlinks(rootDir)
	if err != nil {
		return "", err
	}
	parsed, err := url.Parse(requestPath)
	if err != nil {
		return "", err
	}
	pathOnly, err := url.PathUnescape(parsed.Path)
	if err != nil {
		return "", err
	}
	relative := strings.TrimLeft(filepath.Clean(filepath.FromSlash(pathOnly)), string(filepath.Separator))
	if relative == "." {
		relative = ""
	}
	candidate, err := filepath.EvalSymlinks(filepath.Join(resolvedRoot, relative))
	if err != nil {
		return "", err
	}
	rootWithSep := resolvedRoot
	if !strings.HasSuffix(rootWithSep, string(filepath.Separator)) {
		rootWithSep += string(filepath.Separator)
	}
	if candidate != resolvedRoot && !strings.HasPrefix(candidate, rootWithSep) {
		return "", errors.New("path escapes shared directory")
	}
	return candidate, nil
}

func errorResponse(requestID string, status int, message string) responseMessage {
	return responseMessage{
		Type:   "response",
		ID:     requestID,
		Status: status,
		Error:  message,
	}
}

func printVisit(message incomingMessage, response responseMessage) {
	visitor := visitorInfo{}
	if message.Visitor != nil {
		visitor = *message.Visitor
	}
	at := formatVisitTime(visitor.At)
	ip := dash(visitor.IP)
	ua := parseUserAgent(visitor.UserAgent)
	bytes := "-"
	if response.Size > 0 {
		bytes = fmt.Sprintf("%d", response.Size)
	}
	fmt.Printf("%-8s %-15s %-16s %-18s %-6d %-8s %s\n",
		at,
		truncate(ip, 15),
		truncate(ua.Browser, 16),
		truncate(ua.OS, 18),
		response.Status,
		bytes,
		firstNonEmpty(message.Path, "/"),
	)
}

func formatVisitTime(value string) string {
	if value == "" {
		return time.Now().Format("15:04:05")
	}
	if parsed, err := time.Parse(time.RFC3339Nano, value); err == nil {
		return parsed.Local().Format("15:04:05")
	}
	return time.Now().Format("15:04:05")
}

func formatCacheDuration(seconds int) string {
	if seconds <= 0 {
		return "off"
	}
	if seconds%(7*24*3600) == 0 {
		return fmt.Sprintf("%dw", seconds/(7*24*3600))
	}
	if seconds%(24*3600) == 0 {
		return fmt.Sprintf("%dd", seconds/(24*3600))
	}
	if seconds%3600 == 0 {
		return fmt.Sprintf("%dh", seconds/3600)
	}
	if seconds%60 == 0 {
		return fmt.Sprintf("%dm", seconds/60)
	}
	return fmt.Sprintf("%ds", seconds)
}

func parseDurationSeconds(value string) (int, error) {
	raw := strings.ToLower(strings.TrimSpace(value))
	if raw == "" || raw == "0" || raw == "off" || raw == "false" {
		return 0, nil
	}

	index := 0
	for index < len(raw) && raw[index] >= '0' && raw[index] <= '9' {
		index++
	}
	if index == 0 {
		return 0, fmt.Errorf("invalid cache ttl %q", value)
	}
	amount, err := strconv.Atoi(raw[:index])
	if err != nil || amount < 0 {
		return 0, fmt.Errorf("invalid cache ttl %q", value)
	}
	unit := strings.TrimSpace(raw[index:])
	switch unit {
	case "", "s", "sec", "secs", "second", "seconds":
		return amount, nil
	case "m", "min", "mins", "minute", "minutes":
		return amount * 60, nil
	case "h", "hr", "hrs", "hour", "hours":
		return amount * 3600, nil
	case "d", "day", "days":
		return amount * 24 * 3600, nil
	case "w", "week", "weeks":
		return amount * 7 * 24 * 3600, nil
	default:
		return 0, fmt.Errorf("invalid cache ttl unit %q in %q", unit, value)
	}
}

func parseUserAgent(userAgent string) userAgentInfo {
	return userAgentInfo{
		Browser: parseBrowser(userAgent),
		OS:      parseOS(userAgent),
	}
}

func parseBrowser(userAgent string) string {
	switch {
	case hasValueAfter(userAgent, "Edg/"):
		return "Edge " + browserVersion(valueAfter(userAgent, "Edg/"))
	case hasValueAfter(userAgent, "OPR/"):
		return "Opera " + browserVersion(valueAfter(userAgent, "OPR/"))
	case hasValueAfter(userAgent, "CriOS/"):
		return "Chrome iOS " + browserVersion(valueAfter(userAgent, "CriOS/"))
	case hasValueAfter(userAgent, "Chrome/") && !strings.Contains(userAgent, "Chromium/"):
		return "Chrome " + browserVersion(valueAfter(userAgent, "Chrome/"))
	case hasValueAfter(userAgent, "Firefox/"):
		return "Firefox " + browserVersion(valueAfter(userAgent, "Firefox/"))
	case hasValueAfter(userAgent, "Version/") && strings.Contains(userAgent, "Safari/") && !strings.Contains(userAgent, "Chrome/"):
		return "Safari " + browserVersion(valueAfter(userAgent, "Version/"))
	case hasValueAfter(userAgent, "Safari/"):
		return "Safari " + browserVersion(valueAfter(userAgent, "Safari/"))
	case userAgent == "":
		return "-"
	default:
		return "Unknown"
	}
}

func parseOS(userAgent string) string {
	switch {
	case strings.Contains(userAgent, "Windows NT 10.0"):
		return "Windows 10/11"
	case strings.Contains(userAgent, "Windows NT 6.3"):
		return "Windows 8.1"
	case strings.Contains(userAgent, "Windows NT 6.2"):
		return "Windows 8"
	case strings.Contains(userAgent, "Windows NT 6.1"):
		return "Windows 7"
	case strings.Contains(userAgent, "Mac OS X"):
		if value := valueAfter(userAgent, "Mac OS X "); value != "" {
			return "macOS " + strings.ReplaceAll(value, "_", ".")
		}
		return "macOS"
	case strings.Contains(userAgent, "iPhone OS"):
		if value := valueAfter(userAgent, "iPhone OS "); value != "" {
			return "iOS " + strings.ReplaceAll(value, "_", ".")
		}
		return "iOS"
	case strings.Contains(userAgent, "CPU OS"):
		if value := valueAfter(userAgent, "CPU OS "); value != "" {
			return "iPadOS " + strings.ReplaceAll(value, "_", ".")
		}
		return "iPadOS"
	case strings.Contains(userAgent, "Android"):
		if value := valueAfter(userAgent, "Android "); value != "" {
			return "Android " + value
		}
		return "Android"
	case strings.Contains(userAgent, "Linux"):
		return "Linux"
	case userAgent == "":
		return "-"
	default:
		return "Unknown"
	}
}

func hasValueAfter(text, marker string) bool {
	return valueAfter(text, marker) != ""
}

func valueAfter(text, marker string) string {
	index := strings.Index(text, marker)
	if index < 0 {
		return ""
	}
	rest := text[index+len(marker):]
	end := strings.IndexFunc(rest, func(r rune) bool {
		return r == ' ' || r == ';' || r == ')'
	})
	if end >= 0 {
		rest = rest[:end]
	}
	return rest
}

func browserVersion(value string) string {
	parts := strings.Split(value, ".")
	if len(parts) >= 2 {
		return parts[0] + "." + parts[1]
	}
	return value
}

func contentType(path string) string {
	switch strings.ToLower(filepath.Ext(path)) {
	case ".html", ".htm":
		return "text/html; charset=utf-8"
	case ".css":
		return "text/css; charset=utf-8"
	case ".js", ".mjs":
		return "text/javascript; charset=utf-8"
	case ".json":
		return "application/json; charset=utf-8"
	case ".png":
		return "image/png"
	case ".jpg", ".jpeg":
		return "image/jpeg"
	case ".gif":
		return "image/gif"
	case ".svg":
		return "image/svg+xml"
	case ".webp":
		return "image/webp"
	case ".ico":
		return "image/x-icon"
	case ".txt":
		return "text/plain; charset=utf-8"
	case ".pdf":
		return "application/pdf"
	}
	if value := mime.TypeByExtension(filepath.Ext(path)); value != "" {
		return value
	}
	return "application/octet-stream"
}

func readClientEnv() map[string]string {
	values := map[string]string{}
	home, err := os.UserHomeDir()
	if err != nil {
		return values
	}
	data, err := os.ReadFile(filepath.Join(home, ".htmlshare", "client.env"))
	if err != nil {
		return values
	}
	for _, rawLine := range strings.Split(string(data), "\n") {
		line := strings.TrimSpace(rawLine)
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		key, value, ok := strings.Cut(line, "=")
		if ok {
			values[strings.TrimSpace(key)] = strings.TrimSpace(value)
		}
	}
	return values
}

func publicBaseFromServer(serverURL string) string {
	value := strings.TrimSuffix(serverURL, "/tunnel")
	value = strings.TrimPrefix(value, "wss://")
	value = strings.TrimPrefix(value, "ws://")
	if strings.HasPrefix(serverURL, "wss://") {
		return "https://" + value
	}
	if strings.HasPrefix(serverURL, "ws://") {
		return "http://" + value
	}
	return ""
}

func randomID(byteCount int) (string, error) {
	bytes := make([]byte, byteCount)
	if _, err := rand.Read(bytes); err != nil {
		return "", err
	}
	if runtime.GOOS == "windows" {
		return hex.EncodeToString(bytes), nil
	}
	return base64.RawURLEncoding.EncodeToString(bytes), nil
}

func firstNonEmpty(values ...string) string {
	for _, value := range values {
		if value != "" {
			return value
		}
	}
	return ""
}

func dash(value string) string {
	if value == "" {
		return "-"
	}
	return value
}

func truncate(value string, max int) string {
	if len(value) <= max {
		return value
	}
	if max <= 1 {
		return value[:max]
	}
	if max <= 3 {
		return value[:max]
	}
	return value[:max-3] + "..."
}

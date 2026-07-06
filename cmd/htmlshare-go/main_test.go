package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestParseUserAgent(t *testing.T) {
	tests := []struct {
		name      string
		userAgent string
		browser   string
		os        string
	}{
		{
			name:      "safari macos",
			userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.5 Safari/605.1.15",
			browser:   "Safari 17.5",
			os:        "macOS 10.15.7",
		},
		{
			name:      "chrome windows",
			userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36",
			browser:   "Chrome 126.0",
			os:        "Windows 10/11",
		},
		{
			name:      "firefox linux",
			userAgent: "Mozilla/5.0 (X11; Linux x86_64; rv:127.0) Gecko/20100101 Firefox/127.0",
			browser:   "Firefox 127.0",
			os:        "Linux",
		},
	}

	for _, test := range tests {
		t.Run(test.name, func(t *testing.T) {
			got := parseUserAgent(test.userAgent)
			if got.Browser != test.browser || got.OS != test.os {
				t.Fatalf("parseUserAgent() = %#v, want browser=%q os=%q", got, test.browser, test.os)
			}
		})
	}
}

func TestSafeResolveRejectsEscapingSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.html"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.html"), filepath.Join(root, "link.html")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	if _, err := safeResolve(root, "/link.html"); err == nil {
		t.Fatal("safeResolve accepted symlink escaping shared directory")
	}
}

func TestSafeResolveAllowsSharedFile(t *testing.T) {
	root := t.TempDir()
	expected := filepath.Join(root, "index.html")
	if err := os.WriteFile(expected, []byte("ok"), 0600); err != nil {
		t.Fatal(err)
	}

	got, err := safeResolve(root, "/index.html")
	if err != nil {
		t.Fatal(err)
	}
	expected, err = filepath.EvalSymlinks(expected)
	if err != nil {
		t.Fatal(err)
	}
	if got != expected {
		t.Fatalf("safeResolve() = %q, want %q", got, expected)
	}
}

func TestPublishRootAndEntryFromFile(t *testing.T) {
	root := t.TempDir()
	filePath := filepath.Join(root, "demo.html")
	if err := os.WriteFile(filePath, []byte("<h1>ok</h1>"), 0600); err != nil {
		t.Fatal(err)
	}

	gotRoot, gotEntry, err := publishRootAndEntry(config{filePath: filePath})
	if err != nil {
		t.Fatal(err)
	}
	expectedRoot, err := filepath.EvalSymlinks(root)
	if err != nil {
		t.Fatal(err)
	}
	if gotRoot != expectedRoot || gotEntry != "demo.html" {
		t.Fatalf("publishRootAndEntry() = (%q, %q), want (%q, %q)", gotRoot, gotEntry, expectedRoot, "demo.html")
	}
}

func TestCollectPublishFilesRejectsEscapingSymlink(t *testing.T) {
	root := t.TempDir()
	outside := t.TempDir()
	if err := os.WriteFile(filepath.Join(outside, "secret.html"), []byte("secret"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.Symlink(filepath.Join(outside, "secret.html"), filepath.Join(root, "link.html")); err != nil {
		t.Skipf("symlink unavailable: %v", err)
	}

	if _, err := collectPublishFiles(root); err == nil {
		t.Fatal("collectPublishFiles accepted symlink escaping publish directory")
	}
}

func TestCollectPublishFilesIncludesContentMetadata(t *testing.T) {
	root := t.TempDir()
	if err := os.Mkdir(filepath.Join(root, "assets"), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "index.html"), []byte("<h1>ok</h1>"), 0600); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(root, "assets", "app.css"), []byte("h1{}"), 0600); err != nil {
		t.Fatal(err)
	}

	files, err := collectPublishFiles(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(files) != 2 {
		t.Fatalf("collectPublishFiles() returned %d files, want 2", len(files))
	}
	if !hasPublishEntry(files, "index.html") || !hasPublishEntry(files, "assets/app.css") {
		t.Fatalf("collectPublishFiles() missing expected paths: %#v", files)
	}
	for _, file := range files {
		if file.Size == 0 || file.SHA256 == "" || file.Body == "" || file.ContentType == "" {
			t.Fatalf("file has incomplete metadata: %#v", file)
		}
	}
}

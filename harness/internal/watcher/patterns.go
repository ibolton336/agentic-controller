package watcher

import (
	"os"
	"path/filepath"
	"strings"
)

var sourceExts map[string]bool

func init() { InitSourceExts(os.Getenv("HARNESS_SOURCE_EXTS")) }

// InitSourceExts configures which file extensions the watcher considers
// source files. langExts is a comma-separated list of extensions
// (e.g. ".go,.mod,.sum") merged with the base set. If empty, only
// the base set applies. Called by init() with HARNESS_SOURCE_EXTS;
// main.go may call it again after loading config.
func InitSourceExts(langExts string) {
	sourceExts = map[string]bool{
		".md": true, ".json": true, ".yaml": true, ".yml": true,
		".xml": true, ".properties": true, ".txt": true,
	}
	if langExts != "" {
		for _, ext := range strings.Split(langExts, ",") {
			ext = strings.TrimSpace(ext)
			if ext != "" {
				if ext[0] != '.' {
					ext = "." + ext
				}
				sourceExts[ext] = true
			}
		}
	}
}

var excludeDirs = map[string]bool{
	".goose": true, "__pycache__": true, ".git": true,
	"node_modules": true, "target": true, "graphify-out": true,
}

var excludeExts = map[string]bool{
	".tmp": true, ".swp": true, ".bak": true,
}

func ShouldStageNewFile(path string) bool {
	base := filepath.Base(path)

	if base == "pom.xml" {
		return true
	}

	for _, part := range strings.Split(filepath.Dir(path), string(filepath.Separator)) {
		if excludeDirs[part] {
			return false
		}
	}

	ext := filepath.Ext(base)
	if excludeExts[ext] {
		return false
	}

	return sourceExts[ext]
}

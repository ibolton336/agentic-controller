package watcher

import "testing"

func TestInitSourceExtsFromEnv(t *testing.T) {
	InitSourceExts(".go, .mod, .sum")

	if !sourceExts[".go"] {
		t.Error(".go should be in sourceExts")
	}
	if !sourceExts[".mod"] {
		t.Error(".mod should be in sourceExts")
	}
	if !sourceExts[".md"] {
		t.Error(".md (base) should be in sourceExts")
	}
	if sourceExts[".java"] {
		t.Error(".java should NOT be in sourceExts when HARNESS_SOURCE_EXTS is set")
	}
}

func TestInitSourceExtsWithoutDot(t *testing.T) {
	InitSourceExts("cs,csproj")

	if !sourceExts[".cs"] {
		t.Error(".cs should be in sourceExts (dot auto-added)")
	}
	if !sourceExts[".csproj"] {
		t.Error(".csproj should be in sourceExts (dot auto-added)")
	}
}

func TestInitSourceExtsEmpty(t *testing.T) {
	InitSourceExts("")

	if !sourceExts[".md"] {
		t.Error(".md (base) should be in sourceExts")
	}
	if sourceExts[".java"] {
		t.Error(".java should NOT be in sourceExts when env is empty")
	}
}

func TestShouldStageNewFile(t *testing.T) {
	InitSourceExts(".java,.gradle,.kts,.kt,.groovy")

	tests := []struct {
		path string
		want bool
	}{
		{"src/main/java/com/example/App.java", true},
		{"pom.xml", true},
		{"src/main/resources/application.properties", true},
		{".konveyor/results.json", true},
		{".konveyor/analysis.json", true},
		{"PLAN.md", true},
		{"graph.json", true},
		{".goose/cache/foo.txt", false},
		{"__pycache__/mod.pyc", false},
		{"target/classes/App.class", false},
		{"scratch.tmp", false},
		{"file.swp", false},
		{"random.txt", true},
		{"src/main/java/.goose/internal.java", false},
		{"graphify-out/model/graph.json", false},
	}
	for _, tt := range tests {
		t.Run(tt.path, func(t *testing.T) {
			if got := ShouldStageNewFile(tt.path); got != tt.want {
				t.Errorf("ShouldStageNewFile(%q) = %v, want %v", tt.path, got, tt.want)
			}
		})
	}
}

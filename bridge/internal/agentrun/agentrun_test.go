package agentrun

import (
	"strings"
	"testing"
)

func TestBuildPrompt_emptyContext(t *testing.T) {
	t.Helper()
	p := BuildPrompt("", "Q?")
	if !strings.Contains(p, "(none)") {
		t.Fatalf("expected placeholder for empty context: %q", p)
	}
	if !strings.Contains(p, "Q?") {
		t.Fatal("missing question")
	}
}

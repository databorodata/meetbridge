// Package agentrun invokes the Cursor CLI binary "agent" in non-interactive Ask mode
// (analysis without applying edits). See plan_meet.md §3.2 and cli_cursor.md.
package agentrun

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"time"
)

const (
	EnvAgentBinary = "MEET_BRIDGE_AGENT" // optional: absolute path to `agent`
)

// Options configure a single agent invocation.
type Options struct {
	Repo           string        // absolute path to git workspace root
	MeetingContext string        // transcript window (may be empty)
	Question       string        // user question (required)
	OutputFormat   string        // "text" | "json" (passed to --output-format)
	Model          string        // if set, passed to --model (e.g. "auto")
	Timeout        time.Duration // overall limit for the child process
	AgentPath      string        // if empty, resolved via lookPathAgent()
	ExtraAgentArgs []string      // optional extra args after built-in flags (advanced)
}

// Result is the raw outcome of running agent.
type Result struct {
	Stdout   string
	Stderr   string
	ExitCode int
}

// BuildPrompt matches the future HTTP contract (meeting_context + question_prompt).
func BuildPrompt(meetingContext, question string) string {
	var b strings.Builder
	b.WriteString("You are assisting during a live meeting. Use the repository as technical context.\n")
	b.WriteString("IMPORTANT RESTRICTIONS:\n")
	b.WriteString("- Do NOT modify files in the workspace (read-only).\n")
	b.WriteString("- GitHub / remote: READ-ONLY. Do NOT change anything on GitHub: no comments on issues or PRs, no new issues/PRs, no merges, no edits to repo settings, no git push or force operations.\n")
	b.WriteString("- `gh` usage is limited to read-only queries: e.g. `gh issue list`, `gh pr list`, `gh issue view`, `gh pr view`, `gh api` for GETs. Do NOT run `gh pr comment`, `gh issue comment`, `gh pr merge`, `gh issue create`, `gh release create`, or any `gh` subcommand that creates or mutates remote state.\n")
	b.WriteString("- Shell: only `gh` is permitted by policy; do not rely on other shell tools.\n\n")
	b.WriteString("## Meeting context (recent transcript, may be empty)\n\n")
	if strings.TrimSpace(meetingContext) == "" {
		b.WriteString("(none)\n\n")
	} else {
		b.WriteString(meetingContext)
		b.WriteString("\n\n")
	}
	b.WriteString("## Question\n\n")
	b.WriteString(strings.TrimSpace(question))
	b.WriteString("\n")
	return b.String()
}

func lookPathAgent(explicit string) (string, error) {
	if explicit != "" {
		return explicit, nil
	}
	if p := os.Getenv(EnvAgentBinary); p != "" {
		return p, nil
	}
	return exec.LookPath("agent")
}

// Run executes `agent` with -p (print), --mode ask, --workspace <repo>, --trust, and --output-format.
// --trust is required in headless mode so the agent does not block on the workspace trust prompt
// (see cursor.com/docs/cli/reference/parameters). We do not pass --force / --yolo.
func Run(ctx context.Context, opt Options) (Result, error) {
	if opt.Timeout > 0 {
		var cancel context.CancelFunc
		ctx, cancel = context.WithTimeout(ctx, opt.Timeout)
		defer cancel()
	}

	repo, err := filepath.Abs(opt.Repo)
	if err != nil {
		return Result{}, fmt.Errorf("repo path: %w", err)
	}
	if st, err := os.Stat(repo); err != nil || !st.IsDir() {
		if err != nil {
			return Result{}, fmt.Errorf("repo: %w", err)
		}
		return Result{}, fmt.Errorf("repo is not a directory: %s", repo)
	}

	q := strings.TrimSpace(opt.Question)
	if q == "" {
		return Result{}, errors.New("question is empty")
	}

	outFmt := strings.TrimSpace(opt.OutputFormat)
	if outFmt == "" {
		outFmt = "text"
	}
	switch outFmt {
	case "text", "json":
	default:
		return Result{}, fmt.Errorf("unsupported output format: %q (use text or json)", outFmt)
	}

	agentBin, err := lookPathAgent(opt.AgentPath)
	if err != nil {
		return Result{}, fmt.Errorf("agent binary: %w (install Cursor CLI or set %s)", err, EnvAgentBinary)
	}

	prompt := BuildPrompt(opt.MeetingContext, q)

	args := []string{
		"-p", prompt,
		"--mode", "ask",
		"--workspace", repo,
		"--trust",
	}
	if m := strings.TrimSpace(opt.Model); m != "" {
		args = append(args, "--model", m)
	}
	args = append(args, "--output-format", outFmt)
	args = append(args, opt.ExtraAgentArgs...)

	cmd := exec.CommandContext(ctx, agentBin, args...)
	cmd.Dir = repo
	cmd.Env = os.Environ()

	var stdout, stderr bytes.Buffer
	cmd.Stdout = &stdout
	cmd.Stderr = &stderr

	runErr := cmd.Run()
	res := Result{
		Stdout: stdout.String(),
		Stderr: stderr.String(),
	}
	if runErr == nil {
		res.ExitCode = 0
		return res, nil
	}

	var ee *exec.ExitError
	if errors.As(runErr, &ee) {
		res.ExitCode = ee.ExitCode()
		return res, fmt.Errorf("agent: %w", runErr)
	}
	return res, runErr
}

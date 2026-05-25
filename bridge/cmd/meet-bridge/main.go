// Command meet-bridge is the local bridge CLI (stage A: no HTTP, no browser).
// Usage: meet-bridge agent -repo <dir> -question "..." [-meeting-context "..." ]
package main

import (
	"context"
	"encoding/json"
	"flag"
	"fmt"
	"log"
	"net"
	"net/http"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"sync"
	"time"

	"meet_assist/bridge/internal/agentrun"
	"meet_assist/bridge/internal/whispersetup"
)

// bridgeVersion is returned by GET /health (MVP).
const bridgeVersion = "0.1.0"

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	switch os.Args[1] {
	case "agent":
		os.Exit(runAgent(os.Args[2:]))
	case "serve":
		os.Exit(runServe(os.Args[2:]))
	case "setup-whisper":
		os.Exit(runSetupWhisper(os.Args[2:]))
	case "help", "-h", "--help":
		usage()
		os.Exit(0)
	default:
		fmt.Fprintf(os.Stderr, "unknown command: %q\n\n", os.Args[1])
		usage()
		os.Exit(2)
	}
}

func usage() {
	fmt.Fprintf(os.Stderr, `meet-bridge — local bridge for Cursor agent

Usage:
  meet-bridge agent -repo <path> -question <text> [options]
  meet-bridge serve [options]
  meet-bridge setup-whisper [options]

agent required:
  -repo              absolute or relative path to the git repository root
  -question          question for the agent (analysis / ask mode)

agent optional:
  -meeting-context   recent meeting transcript (default empty)
  -output-format     text | json (default text)
  -model             agent model (default auto)
  -timeout           max runtime, e.g. 10m, 600s (default 15m)

serve optional:
  -listen               listen address (default 127.0.0.1:7337)
  -repo                 default repo path (if request omits it)
  -model                default agent model (default auto)
  -timeout              default timeout for agent calls (default 15m)
  -whisper-check-addr   host:port for GET /health WhisperLive TCP check (default 127.0.0.1:9090)
  -whisper-root         path to whisper-server dir (default: ../whisper-server next to this binary)
  -skip-whisper-setup   do not create venv / pip install (also env MEET_BRIDGE_SKIP_WHISPER_SETUP=1)
  -token                if set, require header X-Bridge-Token: <token>

setup-whisper:
  Creates whisper-server/.venv and pip-installs requirements.txt (same as first serve).

Environment:
  CURSOR_API_KEY     API key for non-interactive agent (required for automation)
  MEET_BRIDGE_TOKEN  same as -token if -token is empty (optional)
  %s  if set, full path to the agent binary (otherwise PATH)

`, agentrun.EnvAgentBinary)
}

func runAgent(args []string) int {
	fs := flag.NewFlagSet("agent", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	repo := fs.String("repo", "", "path to repository root")
	question := fs.String("question", "", "user question")
	meeting := fs.String("meeting-context", "", "recent transcript window")
	outFmt := fs.String("output-format", "text", "agent output: text or json")
	model := fs.String("model", "auto", "agent model (default: auto)")
	timeout := fs.Duration("timeout", 15*time.Minute, "max time for agent process")

	if err := fs.Parse(args); err != nil {
		return 2
	}
	if *repo == "" || *question == "" {
		fmt.Fprintln(os.Stderr, "error: -repo and -question are required")
		fs.Usage()
		return 2
	}

	ctx := context.Background()
	start := time.Now()
	res, err := agentrun.Run(ctx, agentrun.Options{
		Repo:           *repo,
		MeetingContext: *meeting,
		Question:       *question,
		OutputFormat:     *outFmt,
		Model:           *model,
		Timeout:          *timeout,
	})

	if res.Stderr != "" {
		fmt.Fprintln(os.Stderr, res.Stderr)
	}
	if res.Stdout != "" {
		fmt.Print(res.Stdout)
	}

	if err != nil {
		fmt.Fprintf(os.Stderr, "\nmeet-bridge: agent failed after %s (exit %d): %v\n",
			time.Since(start).Round(time.Millisecond), res.ExitCode, err)
		return 1
	}
	fmt.Fprintf(os.Stderr, "\nmeet-bridge: ok in %s (exit %d)\n",
		time.Since(start).Round(time.Millisecond), res.ExitCode)
	return 0
}

type errBody struct {
	Code    string `json:"code"`
	Message string `json:"message"`
	Details string `json:"details,omitempty"`
}

type session struct {
	RepoPath       string
	Branch         string
	Model          string
	Timeout        time.Duration
	WhisperModel   string // e.g. small — used when extension connects to WhisperLive (stored for UI/contract)
	WhisperWSURL   string // ws://127.0.0.1:9090 — extension connects here; bridge may start server later
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// withCORS allows browser/extension fetch to localhost (preflight OPTIONS).
func withCORS(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.Header().Set("Access-Control-Allow-Origin", "*")
		w.Header().Set("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
		w.Header().Set("Access-Control-Allow-Headers", "Content-Type, X-Bridge-Token")
		if r.Method == http.MethodOptions {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

func runSetupWhisper(args []string) int {
	fs := flag.NewFlagSet("setup-whisper", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)
	whisperRootFlag := fs.String("whisper-root", "", "path to whisper-server (default: ../whisper-server relative to meet-bridge binary)")
	if err := fs.Parse(args); err != nil {
		return 2
	}
	root, err := whispersetup.ResolveRoot(*whisperRootFlag)
	if err != nil {
		log.Printf("ERROR: %v", err)
		return 1
	}
	if err := whispersetup.Ensure(root, log.Printf); err != nil {
		log.Printf("ERROR: %v", err)
		return 1
	}
	return 0
}

func runServe(args []string) int {
	fs := flag.NewFlagSet("serve", flag.ContinueOnError)
	fs.SetOutput(os.Stderr)

	listen := fs.String("listen", "127.0.0.1:7337", "listen address (host:port)")
	defaultRepo := fs.String("repo", "", "default repo path for requests")
	defaultModel := fs.String("model", "auto", "default agent model")
	defaultTimeout := fs.Duration("timeout", 15*time.Minute, "default timeout for agent calls")
	whisperCheckAddr := fs.String("whisper-check-addr", "127.0.0.1:9090", "host:port for TCP reachability in GET /health (WhisperLive)")
	whisperRootFlag := fs.String("whisper-root", "", "path to whisper-server (default: ../whisper-server relative to meet-bridge binary)")
	skipWhisperSetup := fs.Bool("skip-whisper-setup", false, "skip automatic whisper-server venv setup")
	token := fs.String("token", "", "require X-Bridge-Token header (optional)")

	if err := fs.Parse(args); err != nil {
		return 2
	}

	bridgeToken := strings.TrimSpace(*token)
	if bridgeToken == "" {
		bridgeToken = strings.TrimSpace(os.Getenv("MEET_BRIDGE_TOKEN"))
	}

	if os.Getenv("CURSOR_API_KEY") == "" {
		log.Printf("WARNING: CURSOR_API_KEY is not set — /agent/ask will fail. Set it in .env or export before starting.")
	}

	if os.Getenv("GITHUB_TOKEN") == "" && os.Getenv("GH_TOKEN") == "" {
		log.Printf("INFO: GITHUB_TOKEN not set — agent won't be able to query GitHub issues/PR via 'gh'. " +
			"To enable: create a fine-grained PAT (Contents/Issues/Pull requests: Read-only) and set GITHUB_TOKEN in .env.")
	} else {
		log.Printf("INFO: GITHUB_TOKEN is set. Make sure it is a fine-grained PAT with READ-ONLY permissions " +
			"(Contents/Issues/Pull requests: Read). A write token allows the agent to mutate GitHub. See README §Security.")
	}

	if !*skipWhisperSetup && strings.TrimSpace(os.Getenv("MEET_BRIDGE_SKIP_WHISPER_SETUP")) != "1" {
		wr, err := whispersetup.ResolveRoot(*whisperRootFlag)
		if err != nil {
			log.Printf("ERROR: whisper-server path: %v", err)
			return 1
		}
		if err := whispersetup.Ensure(wr, log.Printf); err != nil {
			log.Printf("ERROR: подготовка whisper-server: %v", err)
			log.Printf("Установите Python 3.10+ в PATH или запустите с -skip-whisper-setup (или MEET_BRIDGE_SKIP_WHISPER_SETUP=1).")
			return 1
		}
	}

	var (
		sessionsMu sync.RWMutex
		sessions   = map[string]session{}
	)

	mux := http.NewServeMux()

	mux.HandleFunc("/health", func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			writeJSON(w, http.StatusMethodNotAllowed, map[string]any{
				"ok": false,
				"error": errBody{Code: "METHOD_NOT_ALLOWED", Message: "use GET"},
			})
			return
		}
		reachable := false
		if conn, err := net.DialTimeout("tcp", *whisperCheckAddr, 400*time.Millisecond); err == nil {
			_ = conn.Close()
			reachable = true
		}
		writeJSON(w, http.StatusOK, map[string]any{
			"ok":      true,
			"version": bridgeVersion,
			"auth": map[string]any{
				"token_required": bridgeToken != "",
			},
			"whisper_live": map[string]any{
				"reachable": reachable,
				"url":       "ws://" + *whisperCheckAddr,
				"check_tcp": *whisperCheckAddr,
			},
		})
	})

	type startReq struct {
		RepoPath string `json:"repo_path"`
		Branch   string `json:"branch,omitempty"`
		Options  struct {
			Model          *string `json:"model"`
			TimeoutSeconds *int    `json:"timeout_seconds"`
			WhisperModel   *string `json:"whisper_model,omitempty"`
			WhisperWSURL   *string `json:"whisper_ws_url,omitempty"`
		} `json:"options"`
	}
	type startResp struct {
		Ok       bool     `json:"ok"`
		SessionID string  `json:"session_id,omitempty"`
		Git      any      `json:"git,omitempty"`
		Options  any      `json:"options,omitempty"`
		Error    *errBody `json:"error,omitempty"`
	}

	// POST /session/start
	// Validates repo path, runs git fetch --all --prune (non-blocking on failure),
	// and records the session in memory.
	mux.HandleFunc("/session/start", func(w http.ResponseWriter, r *http.Request) {
		if bridgeToken != "" && r.Header.Get("X-Bridge-Token") != bridgeToken {
			writeJSON(w, http.StatusUnauthorized, startResp{
				Ok:    false,
				Error: &errBody{Code: "UNAUTHORIZED", Message: "missing or invalid X-Bridge-Token"},
			})
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, startResp{
				Ok:    false,
				Error: &errBody{Code: "METHOD_NOT_ALLOWED", Message: "use POST"},
			})
			return
		}
		var req startReq
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, startResp{
				Ok:    false,
				Error: &errBody{Code: "BAD_JSON", Message: "invalid JSON body", Details: err.Error()},
			})
			return
		}
		repo := strings.TrimSpace(req.RepoPath)
		if repo == "" {
			writeJSON(w, http.StatusBadRequest, startResp{
				Ok:    false,
				Error: &errBody{Code: "REPO_REQUIRED", Message: "repo_path is required"},
			})
			return
		}
		abs, err := filepath.Abs(repo)
		if err != nil {
			writeJSON(w, http.StatusBadRequest, startResp{
				Ok:    false,
				Error: &errBody{Code: "REPO_INVALID", Message: "invalid repo_path", Details: err.Error()},
			})
			return
		}
		if st, err := os.Stat(abs); err != nil || !st.IsDir() {
			d := ""
			if err != nil {
				d = err.Error()
			}
			writeJSON(w, http.StatusBadRequest, startResp{
				Ok:    false,
				Error: &errBody{Code: "REPO_NOT_FOUND", Message: "repo_path is not a directory", Details: d},
			})
			return
		}
		// Light read-only check that it's a git repo: `git rev-parse --is-inside-work-tree`.
		cmd := exec.Command("git", "rev-parse", "--is-inside-work-tree")
		cmd.Dir = abs
		out, err := cmd.CombinedOutput()
		if err != nil || strings.TrimSpace(string(out)) != "true" {
			details := strings.TrimSpace(string(out))
			if err != nil && details == "" {
				details = err.Error()
			}
			writeJSON(w, http.StatusBadRequest, startResp{
				Ok:    false,
				Error: &errBody{Code: "NOT_A_GIT_REPO", Message: "repo_path is not a git work tree", Details: details},
			})
			return
		}
		// git fetch --all --prune (60s timeout, non-blocking: session created even on failure).
		fetchOk := false
		fetchDetails := ""
		{
			fetchCtx, fetchCancel := context.WithTimeout(r.Context(), 60*time.Second)
			defer fetchCancel()
			fetchCmd := exec.CommandContext(fetchCtx, "git", "fetch", "--all", "--prune")
			fetchCmd.Dir = abs
			out, ferr := fetchCmd.CombinedOutput()
			if ferr != nil {
				fetchDetails = strings.TrimSpace(string(out))
				if fetchDetails == "" {
					fetchDetails = ferr.Error()
				}
				log.Printf("git fetch failed in %s: %v", abs, ferr)
			} else {
				fetchOk = true
			}
		}

		// HEAD after fetch.
		headCmd := exec.Command("git", "rev-parse", "HEAD")
		headCmd.Dir = abs
		headOut, headErr := headCmd.CombinedOutput()
		head := strings.TrimSpace(string(headOut))
		if headErr != nil {
			head = ""
		}

		// Current branch name.
		branchCmd := exec.Command("git", "rev-parse", "--abbrev-ref", "HEAD")
		branchCmd.Dir = abs
		branchOut, _ := branchCmd.CombinedOutput()
		currentBranch := strings.TrimSpace(string(branchOut))

		// session_id: time-based unique enough for MVP; can be replaced with UUID later.
		model := strings.TrimSpace(*defaultModel)
		if req.Options.Model != nil {
			model = strings.TrimSpace(*req.Options.Model)
		}
		if model == "" {
			model = "auto"
		}
		timeout := *defaultTimeout
		if req.Options.TimeoutSeconds != nil && *req.Options.TimeoutSeconds > 0 {
			timeout = time.Duration(*req.Options.TimeoutSeconds) * time.Second
		}

		whisperModel := "small"
		if req.Options.WhisperModel != nil && strings.TrimSpace(*req.Options.WhisperModel) != "" {
			whisperModel = strings.TrimSpace(*req.Options.WhisperModel)
		}
		whisperWS := "ws://127.0.0.1:9090"
		if req.Options.WhisperWSURL != nil && strings.TrimSpace(*req.Options.WhisperWSURL) != "" {
			whisperWS = strings.TrimSpace(*req.Options.WhisperWSURL)
		}

		sessionID := time.Now().UTC().Format("20060102T150405.000000000Z07:00")
		sessionsMu.Lock()
		sessions[sessionID] = session{
			RepoPath:     abs,
			Branch:       strings.TrimSpace(req.Branch),
			Model:        model,
			Timeout:      timeout,
			WhisperModel: whisperModel,
			WhisperWSURL: whisperWS,
		}
		sessionsMu.Unlock()

		writeJSON(w, http.StatusOK, startResp{
			Ok:        true,
			SessionID: sessionID,
			Git: map[string]any{
				"fetch_ok":       fetchOk,
				"fetch_details":  fetchDetails,
				"head":           head,
				"branch":         currentBranch,
			},
			Options: map[string]any{
				"model":           model,
				"timeout_seconds": int(timeout.Seconds()),
				"whisper_model":   whisperModel,
				"whisper_ws_url":  whisperWS,
			},
		})
	})

	type askReq struct {
		SessionID      string `json:"session_id,omitempty"`
		RepoPath       string `json:"repo_path,omitempty"`
		MeetingContext string `json:"meeting_context"`
		QuestionPrompt string `json:"question_prompt"`
		Options        struct {
			Model          *string `json:"model"`
			TimeoutSeconds *int    `json:"timeout_seconds"`
		} `json:"options"`
	}
	type askResp struct {
		Ok    bool    `json:"ok"`
		Agent any     `json:"agent,omitempty"`
		Meta  any     `json:"meta,omitempty"`
		Error *errBody `json:"error,omitempty"`
	}

	mux.HandleFunc("/agent/ask", func(w http.ResponseWriter, r *http.Request) {
		if bridgeToken != "" && r.Header.Get("X-Bridge-Token") != bridgeToken {
			writeJSON(w, http.StatusUnauthorized, askResp{
				Ok:    false,
				Error: &errBody{Code: "UNAUTHORIZED", Message: "missing or invalid X-Bridge-Token"},
			})
			return
		}
		if r.Method != http.MethodPost {
			writeJSON(w, http.StatusMethodNotAllowed, askResp{
				Ok:    false,
				Error: &errBody{Code: "METHOD_NOT_ALLOWED", Message: "use POST"},
			})
			return
		}
		var req askReq
		dec := json.NewDecoder(r.Body)
		dec.DisallowUnknownFields()
		if err := dec.Decode(&req); err != nil {
			writeJSON(w, http.StatusBadRequest, askResp{
				Ok:    false,
				Error: &errBody{Code: "BAD_JSON", Message: "invalid JSON body", Details: err.Error()},
			})
			return
		}

		repo := strings.TrimSpace(req.RepoPath)
		var sess session
		var haveSess bool
		if strings.TrimSpace(req.SessionID) != "" {
			sessionsMu.RLock()
			s, ok := sessions[strings.TrimSpace(req.SessionID)]
			sessionsMu.RUnlock()
			if !ok {
				writeJSON(w, http.StatusBadRequest, askResp{
					Ok:    false,
					Error: &errBody{Code: "SESSION_NOT_FOUND", Message: "unknown session_id"},
				})
				return
			}
			sess = s
			haveSess = true
			if repo == "" {
				repo = s.RepoPath
			}
		}
		if repo == "" {
			repo = strings.TrimSpace(*defaultRepo)
		}
		if repo == "" {
			writeJSON(w, http.StatusBadRequest, askResp{
				Ok:    false,
				Error: &errBody{Code: "REPO_REQUIRED", Message: "repo_path is required (or set -repo on serve)"},
			})
			return
		}

		model := strings.TrimSpace(*defaultModel)
		if haveSess && strings.TrimSpace(sess.Model) != "" {
			model = strings.TrimSpace(sess.Model)
		}
		if req.Options.Model != nil {
			model = strings.TrimSpace(*req.Options.Model)
		}
		if model == "" {
			model = "auto"
		}
		timeout := *defaultTimeout
		if haveSess && sess.Timeout > 0 {
			timeout = sess.Timeout
		}
		if req.Options.TimeoutSeconds != nil && *req.Options.TimeoutSeconds > 0 {
			timeout = time.Duration(*req.Options.TimeoutSeconds) * time.Second
		}

		start := time.Now()
		res, err := agentrun.Run(r.Context(), agentrun.Options{
			Repo:           repo,
			MeetingContext: req.MeetingContext,
			Question:       req.QuestionPrompt,
			OutputFormat:   "text",
			Model:          model,
			Timeout:        timeout,
		})
		dur := time.Since(start)

		agentObj := map[string]any{
			"exit_code": res.ExitCode,
			"stdout":    res.Stdout,
			"stderr":    res.Stderr,
		}

		if err != nil || res.ExitCode != 0 {
			writeJSON(w, http.StatusOK, askResp{
				Ok: false,
				Error: &errBody{
					Code:    "AGENT_FAILED",
					Message: "agent exited non-zero",
					Details: errString(err),
				},
				Agent: agentObj,
				Meta:  map[string]any{"duration_ms": dur.Milliseconds(), "model": model},
			})
			return
		}

		writeJSON(w, http.StatusOK, askResp{
			Ok:    true,
			Agent: agentObj,
			Meta:  map[string]any{"duration_ms": dur.Milliseconds(), "model": model},
		})
	})

	server := &http.Server{
		Addr:              *listen,
		Handler:           withCORS(mux),
		ReadHeaderTimeout: 5 * time.Second,
	}

	ln, err := net.Listen("tcp", server.Addr)
	if err != nil {
		fmt.Fprintf(os.Stderr, "listen failed: %v\n", err)
		return 1
	}
	log.Printf("meet-bridge listening on http://%s", server.Addr)
	if err := server.Serve(ln); err != nil && err != http.ErrServerClosed {
		fmt.Fprintf(os.Stderr, "server error: %v\n", err)
		return 1
	}
	return 0
}

func errString(err error) string {
	if err == nil {
		return ""
	}
	return err.Error()
}

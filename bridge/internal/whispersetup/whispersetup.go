// Package whispersetup creates whisper-server/.venv and installs pip dependencies (first run).
package whispersetup

import (
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"runtime"
	"strconv"
	"strings"
)

// ResolveRoot returns absolute path to whisper-server directory.
// Order: explicit flag, MEET_WHISPER_ROOT env, ../whisper-server next to binary, then ./whisper-server from cwd.
func ResolveRoot(explicit string) (string, error) {
	s := strings.TrimSpace(explicit)
	if s != "" {
		return filepath.Abs(s)
	}
	if env := strings.TrimSpace(os.Getenv("MEET_WHISPER_ROOT")); env != "" {
		return filepath.Abs(env)
	}
	exe, err := os.Executable()
	if err != nil {
		return "", err
	}
	exeDir := filepath.Dir(exe)
	candidates := []string{
		filepath.Join(exeDir, "..", "whisper-server"),
		filepath.Join(exeDir, "whisper-server"),
	}
	cwd, _ := os.Getwd()
	if cwd != "" {
		candidates = append(candidates,
			filepath.Join(cwd, "whisper-server"),
			filepath.Join(cwd, "..", "whisper-server"),
		)
	}
	for _, c := range candidates {
		abs, err := filepath.Abs(c)
		if err != nil {
			continue
		}
		if st, err := os.Stat(filepath.Join(abs, "requirements.txt")); err == nil && !st.IsDir() {
			return abs, nil
		}
	}
	// default: next to binary (even if missing — Ensure will error clearly)
	root := filepath.Join(exeDir, "..", "whisper-server")
	return filepath.Abs(root)
}

func venvPython(whisperRoot string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(whisperRoot, ".venv", "Scripts", "python.exe")
	}
	p3 := filepath.Join(whisperRoot, ".venv", "bin", "python3")
	if st, err := os.Stat(p3); err == nil && !st.IsDir() {
		return p3
	}
	return filepath.Join(whisperRoot, ".venv", "bin", "python")
}

func venvPip(whisperRoot string) string {
	if runtime.GOOS == "windows" {
		return filepath.Join(whisperRoot, ".venv", "Scripts", "pip.exe")
	}
	return filepath.Join(whisperRoot, ".venv", "bin", "pip")
}

var pyVersionRe = regexp.MustCompile(`Python (\d+)\.(\d+)`)

func pythonMinorOK(py string) bool {
	out, err := exec.Command(py, "--version").CombinedOutput()
	if err != nil {
		return false
	}
	m := pyVersionRe.FindStringSubmatch(string(out))
	if len(m) < 3 {
		return false
	}
	major, err1 := strconv.Atoi(m[1])
	minor, err2 := strconv.Atoi(m[2])
	if err1 != nil || err2 != nil {
		return false
	}
	return major == 3 && minor >= 10
}

// FindSystemPython returns a Python 3.10+ interpreter from PATH.
func FindSystemPython() (string, error) {
	try := []string{"python3.12", "python3.11", "python3.10", "python3"}
	for _, name := range try {
		path, err := exec.LookPath(name)
		if err != nil {
			continue
		}
		if pythonMinorOK(path) {
			return path, nil
		}
	}
	return "", fmt.Errorf("Python 3.10+ required in PATH (e.g. brew install python@3.11)")
}

func runImportCheck(py string) error {
	cmd := exec.Command(py, "-c", "import whisper_live")
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("%w: %s", err, strings.TrimSpace(string(out)))
	}
	return nil
}

// Ensure creates .venv under whisperRoot if needed and pip-installs requirements.txt.
// logf is called with status lines (e.g. log.Printf).
func Ensure(whisperRoot string, logf func(string, ...any)) error {
	req := filepath.Join(whisperRoot, "requirements.txt")
	if st, err := os.Stat(req); err != nil || st.IsDir() {
		return fmt.Errorf("missing %s — expected whisper-server directory in repository", req)
	}

	vp := venvPython(whisperRoot)
	if _, err := os.Stat(vp); err == nil {
		if err := runImportCheck(vp); err == nil {
			logf("meet-bridge: WhisperLive venv already ready: %s", vp)
			return nil
		}
		logf("meet-bridge: venv exists but whisper_live import failed — reinstalling: %v", err)
	}

	py, err := FindSystemPython()
	if err != nil {
		return err
	}
	logf("meet-bridge: creating venv in %s (interpreter: %s)", whisperRoot, py)

	cmd := exec.Command(py, "-m", "venv", ".venv")
	cmd.Dir = whisperRoot
	out, err := cmd.CombinedOutput()
	if err != nil {
		return fmt.Errorf("python -m venv: %w\n%s", err, strings.TrimSpace(string(out)))
	}

	pip := venvPip(whisperRoot)
	steps := [][]string{
		{pip, "install", "--upgrade", "pip"},
		{pip, "install", "-r", "requirements.txt"},
	}
	for _, args := range steps {
		c := exec.Command(args[0], args[1:]...)
		c.Dir = whisperRoot
		c.Stdout = os.Stdout
		c.Stderr = os.Stderr
		if err := c.Run(); err != nil {
			return fmt.Errorf("%v: %w", args, err)
		}
	}

	vp = venvPython(whisperRoot)
	if err := runImportCheck(vp); err != nil {
		return fmt.Errorf("whisper_live import check: %w", err)
	}
	logf("meet-bridge: WhisperLive dependencies installed (%s)", vp)
	return nil
}

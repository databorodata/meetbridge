# MeetBridge

Bridge between your online meeting and Cursor AI: real-time transcript + ask the agent about your local repository.

**What it does:** Captures audio from your Chrome meeting tab, transcribes it locally with Whisper, and lets you ask Cursor's AI agent questions about your code with full meeting context.

---

## How it works

1. **Chrome extension** captures tab audio via `chrome.tabCapture`
2. **WhisperLive** (local Python server) transcribes audio in real-time
3. **Bridge** (Go server) manages sessions and spawns Cursor CLI agents
4. **Cursor agent** receives transcript + your question, answers using your local repository

```
┌─────────────┐      audio       ┌──────────────┐
│   Chrome    │─────────────────▶│ WhisperLive  │
│  Extension  │                   │  (port 9090) │
└──────┬──────┘                   └───────┬──────┘
       │                                  │
       │ session/ask                      │ transcript
       │                                  │
       ▼                                  ▼
┌─────────────────────────────────────────────────┐
│           meet-bridge (port 7337)               │
│  ┌──────────────────────────────────────────┐   │
│  │  Cursor CLI agent (--repo /path/to/repo) │   │
│  └──────────────────────────────────────────┘   │
└─────────────────────────────────────────────────┘
```

---

## Requirements

**Required:**
- **Chrome or Chromium-based browser** (Edge, Brave, Opera) — Firefox is not supported
- **Cursor CLI** with API key ([get it here](https://cursor.com/dashboard/integrations))
- **Go 1.22+** ([download](https://go.dev/dl/))
- **Python 3.10+** (recommend 3.11 via Homebrew: `brew install python@3.11`)

**Optional:**
- **GitHub CLI** (`gh`) for reading issues/PRs — requires fine-grained PAT with read-only permissions

**Why Chrome only?**  
Uses `chrome.tabCapture` API and offscreen documents, which are Chrome-specific.

---

## Installation

### 1. Clone the repository

```bash
git clone https://github.com/databorodata/meetbridge.git
cd meetbridge
```

### 2. Configure environment

```bash
cp .env.example .env
```

Edit `.env`:

```bash
# Required: Cursor API key (https://cursor.com/dashboard/integrations)
CURSOR_API_KEY=your_key_here

# Optional: GitHub fine-grained PAT (read-only)
GITHUB_TOKEN=your_token_here
```

**Creating a GitHub fine-grained PAT:**
1. Go to [github.com/settings/tokens?type=beta](https://github.com/settings/tokens?type=beta)
2. Click **Generate new token**
3. Set **Repository permissions**:
   - Contents: **Read-only**
   - Issues: **Read-only**
   - Pull requests: **Read-only**
   - Everything else: **No access**
4. Copy the token to `.env`

⚠️ **Security:** With a read-only token, the agent cannot push code or comment on PRs. Write operations will fail with HTTP 403.

### 3. Copy Cursor CLI permissions file

After cloning, you already have `cli-config.json` in the project folder (same level as this README).

Copy it to your home directory:

```bash
cp cli-config.json ~/.cursor/cli-config.json
```

| Question | Answer |
|----------|--------|
| Where is the file? | In the repo root: `cli-config.json` |
| What does it do? | Tells Cursor CLI what the agent may do (read-only workspace + `gh`) |
| Is this my API key? | **No.** The API key is only in `.env` (`CURSOR_API_KEY`, step 2) |
| What if I skip this? | `./start.sh` warns; the agent may ask for permissions or refuse some actions |

### 4. Start the servers

```bash
./start.sh
```

**First run:** Installs WhisperLive dependencies (~3-5 GB) and downloads the Whisper model (~466 MB for `small`). This takes **5-10 minutes**.

**Subsequent runs:** ~5 seconds startup.

You'll see:

```
════════════════════════════════════════════════════════════
  MeetBridge is running
  Bridge:      http://127.0.0.1:7337
  WhisperLive: ws://127.0.0.1:9090

  Open Chrome → meeting tab → MeetBridge extension
  → set repository path in Settings → start listening

  Stop: Ctrl+C
════════════════════════════════════════════════════════════
```

### 5. Load the Chrome extension

1. Open Chrome and go to `chrome://extensions`
2. Enable **Developer mode** (top-right toggle)
3. Click **Load unpacked**
4. Select the `meet-extension/` folder from this repository
5. Pin the extension to your toolbar

---

## Usage

1. **Join a meeting** in Chrome (Google Meet, Zoom web, etc.)
2. **Open the extension** popup
3. Go to **Settings** → enter absolute path to your local repository  
   Example: `/Users/yourname/projects/myapp`
4. Click **Listen to meeting** — transcript appears in real-time
5. Click **Ask the agent** → dictate or type your question
6. Click **Send to agent** → Cursor agent answers based on meeting context + your code

**Meeting context window:** By default, uses the last 180 seconds of transcript. Adjust in Settings.

---

## Whisper model comparison

The bridge uses faster-whisper on CPU. Choose a model in the extension Settings:

| Model     | Params | Disk size | RAM (CPU) | Speed | Accuracy (WER) | Best for                      |
|-----------|--------|-----------|-----------|-------|----------------|-------------------------------|
| tiny      | 39M    | ~75 MB    | ~273 MB   | 10x   | ~12%           | Testing, edge devices         |
| base      | 74M    | ~142 MB   | ~388 MB   | 7x    | ~10%           | Low-resource machines         |
| **small** | 244M   | ~466 MB   | ~852 MB   | 4x    | ~7%            | **Recommended for CPU** ⭐    |
| medium    | 769M   | ~1.5 GB   | ~2.1 GB   | 2x    | ~5%            | Better accuracy, needs RAM    |
| large-v3  | 1550M  | ~2.9 GB   | ~3.9 GB   | 1x    | ~3.5%          | GPU only, best accuracy       |

**Default:** `small` (good balance of speed and accuracy for CPU)

On first model load, faster-whisper downloads it to `~/.cache/huggingface/`.

---

## Security

**What stays local:**
- ✅ Meeting audio and transcripts (never leave your machine)
- ✅ Your repository code (accessed only by local Cursor CLI)
- ✅ Whisper model runs locally (no cloud API)

**What's sent to Cursor Cloud:**
- Meeting transcript (via Cursor agent prompt)
- Your question text
- Agent reads your repository to generate answers

**Secrets:**
- `CURSOR_API_KEY`: Stored in `.env` (gitignored)
- `GITHUB_TOKEN`: Read-only PAT, stored in `.env` (gitignored)
- Never commit `.env` to version control

**GitHub PAT permissions:**
- **Read-only** is enforced. The agent can view issues/PRs but cannot:
  - Push code
  - Create/edit issues or PRs
  - Modify repository settings

---

## Known limitations

1. **Chrome/Chromium only** — Firefox does not support `chrome.tabCapture`
2. **CPU Whisper latency** — Real-time transcription on CPU has ~2-5 second delay. GPU is faster but requires CUDA setup.
3. **No streaming** — Transcripts arrive in chunks (every few seconds), not word-by-word
4. **Model list may be outdated** — Whisper models evolve; check [Hugging Face](https://huggingface.co/Systran) for the latest

---

## Troubleshooting

**"agent not found in PATH"**  
Install Cursor CLI:
```bash
curl https://cursor.com/install -fsSL | bash
# Add to ~/.zshrc:
export PATH="$HOME/.local/bin:$PATH"
```

**"bridge unavailable" in extension**  
Check `./start.sh` logs. Common causes:
- Bridge didn't finish starting (wait for "ready" message)
- CURSOR_API_KEY not set in `.env`
- Port 7337 or 9090 already in use

**Python version too old**  
```bash
brew install python@3.11
# Restart terminal, then ./start.sh
```

**WhisperLive import errors**  
Delete `.venv` and reinstall:
```bash
rm -rf whisper-server/.venv
./start.sh
```

---

## Contributing

Pull requests welcome! Please:
- Keep the code style consistent
- Test on a clean macOS environment before submitting
- Update README if you change installation steps

---

## License

MIT License - see [LICENSE](LICENSE) file.

---

## Acknowledgments

- [WhisperLive](https://github.com/collabora/WhisperLive) — Real-time speech recognition
- [faster-whisper](https://github.com/SYSTRAN/faster-whisper) — Efficient Whisper implementation
- [Cursor](https://cursor.com) — AI-first code editor

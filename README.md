# OpenPluseXYZ

A terminal-based AI coding agent. Point it at a project, ask a question, or tell it to make a change — it reads, searches, edits, and runs commands on your behalf.

Built with TypeScript, no runtime dependencies.

## Features

- **Agent loop** — the model reasons, calls tools, and reacts to results until the task is done.
- **Multi-provider** — OpenRouter, Google Gemini, and local Ollama behind one interface, with streaming responses.
- **Tools** — read/write/edit files, list and search the codebase, run shell commands, and read-only git operations.
- **Workspace confinement** — every file-system tool resolves paths against the working directory; absolute paths, `../` traversal, and symbolic links that escape the workspace are rejected, so the agent cannot read or write outside the project.
- **Persistent conversation** — the REPL keeps the agent's message history across turns (in memory), bounds it (`maxHistoryMessages` / `maxHistoryChars`) both before each request and after each completed turn, and exposes `/history` and `/clear`.
- **Security** — per-action permission policy (`allow` / `deny` / `ask`) and a blocklist for dangerous shell commands.
- **Project awareness** — scans the workspace (name, languages, manifests, docs, top-level structure) and feeds a compact summary into the system prompt, respecting configured ignore directories.
- **Simple TUI** — a REPL with slash commands and lightweight markdown rendering.

## Install & run

```bash
npm install
npm run dev          # run from TypeScript source
npm run build        # compile to dist/
npm start            # run the compiled build
```

Set a provider API key in `.env` (copy the template first):

```bash
# OpenRouter
OPENROUTER_API_KEY=sk-or-...

# Gemini
GEMINI_API_KEY=AIza...

# Optional OpenPluseXYZ settings
OPENPLUSEXYZ_PROVIDER=ollama
OPENPLUSEXYZ_MODEL=qwen2.5-coder:7b

# Ollama (local)
docker run -d -p 11434:11434 ollama/ollama
ollama pull qwen2.5-coder
```

The branded settings are `OPENPLUSEXYZ_PROVIDER`, `OPENPLUSEXYZ_MODEL`, `OPENPLUSEXYZ_TEMPERATURE`, and `OPENPLUSEXYZ_MAX_TOKENS`. The old `OPENPLUSE_*` names remain supported as deprecated aliases; when both are set, `OPENPLUSEXYZ_*` takes precedence. Provider secrets remain `OPENROUTER_API_KEY` and `GEMINI_API_KEY`.

## Usage

```bash
openplusexyz <prompt...>             run a single task
openplusexyz                          start an interactive REPL
openplusexyz --cwd <dir>              work in a different directory
openplusexyz --provider <name>        override provider (openrouter, gemini, ollama)
openplusexyz --model <model>          override the model
```

```
OpenPluseXYZ ❯ how is authentication handled in @server/api.ts
OpenPluseXYZ ❯ add a /health route and register it in the router
OpenPluseXYZ ❯ /help
```

Flags may be given in any order, each consumes exactly one following value, and prompt words may follow flags (`openplusexyz --model flash "describe src/"`). A missing flag value or an unknown `--option` is a clear error rather than being silently folded into the prompt.

Slash commands inside the REPL:

| Command | Description |
| --- | --- |
| `/help` | Show available commands |
| `/model <model>` | Switch the current model (recreates the session) |
| `/provider <name>` | Switch provider (openrouter, gemini, ollama; recreates the session) |
| `/history` | Print the current conversation |
| `/clear` | Clear the conversation history |
| `/exit`, `/quit` | Leave the REPL |

`/provider` and `/model` actually rebuild the provider/session for that switch. History is preserved only if the switch succeeds; an unknown provider keeps the current session and prints an error.

`/history` prints the conversation and appends two possible notices: `-- (older history was trimmed to fit limits)` when some turns were dropped after the last run, and `-- (the newest turn exceeds the configured history limit)` when the most recent turn is already larger than `maxHistoryChars`.

### Permission policy

The `config/security` block maps read/write/execute actions to one of:

- `allow` — always permitted
- `deny` — always rejected
- `ask` — confirm interactively before running

Shell commands additionally pass through a blocklist (`rm -rf /`, `curl | sh`, forced git pushes, etc.).

### Shell commands are not a sandbox

Approved `run_command` invocations execute with your OS user's permissions and can touch anything that user can (network, other directories, system settings). They are *guarded* by permission prompts and the blocklist, but they are **not sandboxed**. Never let the agent run a command you would not run yourself, and keep a reviewable baseline (see below).

`run_command` reports exactly how a command ended: `[exit <code>]` for a normal exit, `[terminated by signal <signal>]` when the OS killed it, and `[timed out after <n>ms]` when it hit the timeout (values are clamped to a safe range). Timeouts are enforced for real: on POSIX the command runs in its own process group that is killed as a group, and on Windows the whole process tree is torn down with `taskkill /T /F` (awaited). A command is only reported as timed out once it has actually stopped, so a timeout can never look like an ordinary run.

## Before you start: use git

Initialize a Git repository (or point OpenPluseXYZ at an existing one) before letting the agent make changes. Git lets you review every change the agent makes, revert anything unexpected, and compare the working tree against a known baseline. The bundled `git_status` / `git_diff` / `git_log` tools assume a repo already exists.

## Workspace confinement

File-system tools (`read_file`, `write_file`, `edit_file`, `list_files`, `glob`, `grep`) only accept paths that resolve inside the selected working directory. Absolute paths and traversal such as `../` are rejected with `Path is outside the working directory.`, and file writes cannot create folders or files outside the workspace. Symbolic links pointing outside the workspace are **not followed**: reads/edits/listings through such links are rejected, recursive scans skip them, and writes through a symlinked directory are blocked.

`grep` searches are guarded against runaway regular expressions: unreasonably long patterns are refused, nested-quantifier constructions like `(a+)+` and repeated `.*` are rejected as too complex, and files larger than 5 MB are skipped (the response notes how many). It keeps normal regex search, case-insensitive matching, and the optional glob filter intact.

## Project awareness

On startup OpenPluseXYZ scans the working directory in a single pass and includes a compact summary in the system prompt: project name, detected languages, package manifests and config files, relevant docs (`README*`, `AGENTS.md`, `LICENSE*`, …), the top-level structure, a file count, and a bounded excerpt of `AGENTS.md`. Symbolic links are skipped during the scan. The summary is limited by `config/contextLines`, the excerpt by the scan's excerpt budget, and both respect the `config/ignore` directory list.

`AGENTS.md` is labeled in the context as repository-provided instructions. Treat it like any other untrusted file in an unfamiliar repository: it is context for the model and must never override the system safety rules, the configured permission policy, or your explicit request. When you clone an untrusted repo, review its `AGENTS.md` (and the rest of the diff) before letting the agent act.

## Conversation history

In interactive mode each turn is appended to the conversation in memory, and the same system prompt is kept at the start. The history is bounded by `maxHistoryMessages` and `maxHistoryChars` (configurable in `config/default.json`): limits are enforced before each request and again after each completed turn (older completed turns can push the history over the budget during a turn). The oldest complete turns are trimmed first, and a turn is never split apart from an assistant's tool call and its tool results. When older history was dropped, `/history` notes that it was trimmed; `/history` also notes when the newest turn alone already exceeds `maxHistoryChars` (that turn is kept, since dropping your current turn would be unhelpful). Single-command mode (`openplusexyz "do a task"`) always runs as a fresh one-turn session. Use `/history` to review the conversation and `/clear` to reset it without dropping the system prompt. History is not persisted to disk.

## Project layout

```
src/
  index.ts            entrypoint + REPL wiring
  repl.ts             REPL controller (slash commands, history, session switching), testable
  session.ts          Session abstraction (provider + tools + system prompt, rebuildable on switch)
  agent/              agent orchestration, agent loop, conversation context, system prompt
  models/             provider interface + openrouter / gemini / ollama implementations
  tools/              tool registry + file, search, shell, git tools (workspace-confined)
  security/           permission policy + shell command filter
  project/            workspace scanner + context builder
  config/             config loading + defaults
config/default.json   user-editable defaults
tests/                unit tests (vitest)
```

## Tests

```bash
npm test
```

Tests include the full path/symlink confinement suite and real shell-execution coverage. Symlink tests are gated: on Windows they run only when Developer Mode or elevated privileges are available, and otherwise are reported as skipped (the skip reason is printed and the count appears in the vitest summary). The external-signal test (classifying `run_command` output as `signal` versus `timeout`) likewise runs only on POSIX, where signals are observable; on Windows it is skipped with a printed reason. To exercise these everywhere, run the suite on Linux/macOS or enable Windows Developer Mode.

## License

MIT

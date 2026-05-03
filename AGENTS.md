# agent-ws

You are working on agent-ws, a standalone WebSocket bridge for CLI AI agents (Claude Code, Codex).

## Project Overview

agent-ws is a TypeScript Node.js process that bridges any WebSocket client with CLI AI agents. It is a **dumb pipe** — no prompt engineering, no credential handling, just transport. Any client can connect: browser frontends, backend services, scripts, other CLI tools.

**Key principle: Local-first.** All AI processing happens on the user's machine using their existing CLI agent authentication.

## Tech Stack

- Node.js 20+ (TypeScript, ESM)
- ws (WebSocket server)
- commander (CLI argument parsing)
- pino (structured logging)
- esbuild (bundling)
- vitest (testing)

## How It Works

```
┌───────────────┐     WebSocket      ┌─────────────┐      stdio       ┌─────────────┐
│  Your App     │ <=================> │  agent-ws   │ <===============> │ Claude Code │
│  (any client) │   localhost:9999   │  (Node.js)  │      stdio       │  / Codex    │
└───────────────┘                    └─────────────┘                   └─────────────┘
```

1. User runs `agent-ws` on their machine
2. Agent starts WebSocket server on localhost:9999
3. Each connection gets its own CLI process
4. Client sends prompt → agent spawns the appropriate CLI agent
5. Response streams back in real-time

## Commands

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript → dist/
npm test             # Run vitest tests
npm run typecheck    # TypeScript check
npm start            # Run from dist/
npm run dev          # Run with --watch
```

## CLI Options

```
-p, --port <port>            WebSocket port (default: 9999)
-H, --host <host>            Hostname (default: localhost)
-c, --claude-path <path>     Path to Claude CLI (default: claude)
    --codex-path <path>      Path to Codex CLI (default: codex)
-t, --timeout <seconds>      Process timeout (default: 600)
    --log-level <level>      debug, info, warn, error (default: info)
    --origins <origins>      Comma-separated allowed origins
-V, --version                Show version
-h, --help                   Show help
```

## Project Structure

```
agent-ws/
├── src/
│   ├── index.ts               # Barrel export (library entry point)
│   ├── cli.ts                 # Commander CLI entry point
│   ├── agent.ts               # Orchestrator: wires server + logger
│   ├── server/
│   │   ├── websocket.ts       # WS server, heartbeat, per-connection state
│   │   └── protocol.ts        # Message types, validation
│   ├── process/
│   │   ├── base-runner.ts          # Abstract BaseRunner: spawn/kill/timeout, file-write sandbox, isWithin helper
│   │   ├── claude-runner.ts        # ClaudeRunner (extends BaseRunner): wires the parser, post-edit reads
│   │   ├── claude-stream-parser.ts # Stateless parser for Claude's stream-json NDJSON output
│   │   ├── codex-runner.ts         # CodexRunner (extends BaseRunner): JSONL parsing, thread resumption
│   │   └── output-cleaner.ts       # ANSI stripping via node:util
│   └── utils/
│       ├── logger.ts          # Pino logger factory
│       └── claude-check.ts    # Claude CLI availability check
├── test/
│   ├── protocol.test.ts       # Message parsing, validation
│   ├── base-runner.test.ts    # BaseRunner: caching, disposal, spawn failure
│   ├── claude-runner.test.ts  # Claude NDJSON stream parsing
│   ├── codex-runner.test.ts   # Codex JSONL stream parsing
│   ├── runner-args.test.ts    # CLI argument building for both runners
│   ├── output-cleaner.test.ts # ANSI/VT sequence stripping
│   └── websocket.test.ts      # Integration: WS server, rate limiting, auth
├── build.js                   # esbuild bundler config
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

## Message Protocol

### Client → Agent

```typescript
{ type: "prompt", prompt: string, requestId: string, model?: string, provider?: "claude" | "codex", projectId?: string, systemPrompt?: string, thinkingTokens?: number, images?: PromptImage[], files?: PromptFile[] }
{ type: "cancel", requestId?: string }
```

- `requestId` max 256 chars.
- `provider` is validated; unknown values are rejected with an error.
- `projectId` scopes CLI session by CWD and enables `--continue` for multi-turn. Alphanumeric/hyphens/underscores/dots only, max 128 chars.
- `systemPrompt` is passed via `--append-system-prompt` (max 64KB). Cached per-connection: if omitted on follow-up messages, the last value is reused.
- `thinkingTokens` controls thinking budget. `0` disables thinking. Omit to let Claude decide. Codex ignores this field.
- `images` is an optional array of `{ media_type: string, data: string }` (base64). Up to 4 images, max 10MB base64 each. Allowed types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. Claude uses `--input-format stream-json` with content blocks; Codex writes temp files and passes via `-i` flags.
- `files` is an optional array of `{ path: string, content: string }`. Up to 100 files, max 50MB total. Written to session directory before spawning the CLI agent.

### Agent → Client

```typescript
{ type: "connected", version: "1.0", agent: "agent-ws", mode: "safe" | "agentic" | "unrestricted" }
{ type: "chunk", content: string, requestId: string, thinking?: boolean }
{ type: "tool_event", requestId: string, event: "start" | "complete", toolName?: string, toolId?: string, input?: Record<string, unknown> }
{ type: "file_change", requestId: string, path: string, changeType: "create" | "update" | "delete", content?: string }
{ type: "complete", requestId: string }
{ type: "error", message: string, requestId?: string }
```

Chunks with `thinking: true` contain Claude's reasoning (streamed when `thinkingTokens > 0`).

`tool_event` and `file_change` are emitted in `agentic` and `unrestricted` modes when the CLI agent uses file-modifying tools. Edit emits two `file_change` events: a synchronous one (no content) when the edit fires, and an async follow-up with post-edit content read from disk via `realpath` (symlink-safe).

Common error messages:
- `"Invalid JSON"` — malformed message
- `"Request already in progress"` — prompt sent while another is running
- `"Process timed out"` — CLI exceeded timeout (default 10min)
- `"Runner has been disposed"` — connection was cleaned up
- `"<Agent> CLI exited with code N"` — CLI process failed
- `"Request cancelled"` — cancel message received
- `"Server is shutting down"` — graceful shutdown in progress

## Key Architecture Decisions

- **Dumb pipe**: No prompt engineering. All prompt construction happens in the client.
- **Per-connection processes**: Each WebSocket gets its own `Runner` instance.
- **Runner interface**: `Runner` interface allows test injection without real process spawning.
- **Configurable identity**: `agentName` and `sessionDir` options let consumers customise the agent.
- **No `strip-ansi` dep**: Uses `node:util.stripVTControlCharacters` (built-in since Node 16.11).
- **OSC-first stripping**: OSC sequences (which use BEL as terminator) are removed before BEL characters.

## Security

- Only listens on localhost by default
- Optional origin validation (`--origins`)
- No API keys stored or transmitted
- 50MB max WebSocket payload, 512KB max prompt, 10MB per image (4 max), 100 files (50MB total)
- 30s heartbeat cleans up dead connections
- 10min default process timeout
- Per-IP connection limit (10 concurrent by default)
- Graceful shutdown with 5s drain period for in-flight requests
- **Sandbox instructions**: In `agentic` and `unrestricted` modes, both runners inject sandbox instructions requiring relative paths. Claude also writes a `CLAUDE.md` to the session directory.

## Testing

The `Runner` interface enables clean dependency injection for the WebSocket server tests.

```bash
npm test                     # Run all tests
npm test -- test/protocol    # Run specific test file
```

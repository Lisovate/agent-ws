# agent-ws - Claude Context

You are working on agent-ws, a standalone WebSocket bridge for CLI AI agents (Claude Code, Codex).

## Project Overview

agent-ws is a TypeScript Node.js process that bridges any frontend with CLI AI agents over WebSocket. It is a **dumb pipe** — no prompt engineering, no credential handling, just transport.

**Key principle: Local-first.** All AI processing happens on the user's machine using their existing CLI agent authentication.

## Tech Stack

- Node.js 18+ (TypeScript, ESM)
- ws (WebSocket server)
- commander (CLI argument parsing)
- pino (structured logging)
- esbuild (bundling)
- vitest (testing)

## How It Works

```
┌───────────────┐     WebSocket      ┌─────────────┐      stdio       ┌─────────────┐
│ Your Frontend │ <=================> │  agent-ws   │ <===============> │ Claude Code │
│   (Browser)   │   localhost:9999   │  (Node.js)  │   --print --json │  / Codex    │
└───────────────┘                    └─────────────┘                   └─────────────┘
```

1. User runs `agent-ws` on their machine
2. Agent starts WebSocket server on localhost:9999
3. Each connection gets its own CLI process
4. User sends prompt → agent spawns the appropriate CLI agent
5. Response streams back to browser in real-time

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
-t, --timeout <seconds>      Process timeout (default: 300)
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
│   │   └── protocol.ts        # Message types, validation, legacy adapter
│   ├── process/
│   │   ├── claude-runner.ts   # Claude Code process spawn/kill/timeout
│   │   ├── codex-runner.ts    # Codex process spawn/kill/timeout
│   │   └── output-cleaner.ts  # ANSI stripping via node:util
│   └── utils/
│       ├── logger.ts          # Pino logger factory
│       └── claude-check.ts    # Claude CLI availability check
├── test/
│   ├── protocol.test.ts       # Message parsing, validation, legacy
│   ├── output-cleaner.test.ts # ANSI/VT sequence stripping
│   └── websocket.test.ts      # Integration: WS server with mock runner
├── build.js                   # esbuild bundler config
├── tsconfig.json
├── vitest.config.ts
└── package.json
```

## Message Protocol

### Client → Agent

```typescript
{ type: "prompt", prompt: string, requestId: string, model?: string, provider?: "claude" | "codex" }
{ type: "cancel", requestId?: string }
```

### Agent → Client

```typescript
{ type: "connected", version: "1.0", agent: "agent-ws" }
{ type: "chunk", content: string, requestId: string }
{ type: "complete", requestId: string }
{ type: "error", message: string, requestId?: string }
```

### Backward Compatibility

Legacy messages using `content` instead of `prompt` (without `requestId`) are auto-adapted. Deprecation warning logged.

## Key Architecture Decisions

- **Dumb pipe**: No prompt engineering. All prompt construction happens in the frontend.
- **Per-connection processes**: Each WebSocket gets its own `Runner` instance.
- **Runner interface**: `Runner` interface allows test injection without real process spawning.
- **Configurable identity**: `agentName` and `sessionDir` options let consumers customise the agent.
- **No `strip-ansi` dep**: Uses `node:util.stripVTControlCharacters` (built-in since Node 16.11).
- **OSC-first stripping**: OSC sequences (which use BEL as terminator) are removed before BEL characters.

## Security

- Only listens on localhost by default
- Optional origin validation (`--origins`)
- No API keys stored or transmitted
- 1MB max WebSocket payload, 512KB max prompt size
- 30s heartbeat cleans up dead connections
- 5min default process timeout

## Testing

Tests use `vi.mock("node-pty")` to avoid PTY dependency in the test environment. The `Runner` interface enables clean dependency injection for the WebSocket server tests.

```bash
npm test                     # Run all tests
npm test -- test/protocol    # Run specific test file
```

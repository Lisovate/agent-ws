[![npm version](https://img.shields.io/npm/v/agent-ws)](https://www.npmjs.com/package/agent-ws)
[![npm downloads](https://img.shields.io/npm/dm/agent-ws)](https://www.npmjs.com/package/agent-ws)
[![license](https://img.shields.io/npm/l/agent-ws)](https://www.npmjs.com/package/agent-ws)

# agent-ws

WebSocket bridge for CLI AI agents. Stream responses from Claude Code and Codex CLI over WebSocket. A dumb pipe: no prompt engineering, no credential handling, just transport.

## Prerequisites

- Node.js 20+
- At least one supported CLI agent installed:
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code) (`npm install -g @anthropic-ai/claude-code`)
  - [Codex](https://github.com/openai/codex) (`npm install -g @openai/codex`)

## Installation

```bash
# From npm
npm install -g agent-ws

# Or run directly
npx agent-ws

# Or clone and run locally
git clone https://github.com/Lisovate/agent-ws.git
cd agent-ws
npm install
npm run build
npm start
```

## Quick Start

```bash
# Start the WebSocket bridge
agent-ws

# The server prints a one-time auth token on startup:
#   Auth token: <token>
#   Connect:    ws://localhost:9999?token=<token>
```

## Library Usage (Node.js only)

If you want to embed the WebSocket server into your own Node.js backend (e.g. Express, Fastify, or a Next.js API route) instead of running the CLI:

```typescript
import { AgentWS } from "agent-ws";

const agent = new AgentWS({
  port: 9999,
  host: "localhost",
  agentName: "my-app",       // Customise the agent identity in connected messages
  sessionDir: "my-sessions", // Customise the temp directory name for sessions
});

await agent.start();
```

> **Note:** This is server-side only. Browser/React clients should connect to the running agent-ws server as a WebSocket client (see [Protocol](#protocol)).

## CLI Options

```
-p, --port <port>            WebSocket server port (default: 9999)
-H, --host <host>            WebSocket server host (default: localhost)
-m, --mode <mode>            Permission mode: safe, agentic, unrestricted (default: safe)
-c, --claude-path <path>     Path to Claude CLI (default: claude)
    --codex-path <path>      Path to Codex CLI (default: codex)
-t, --timeout <seconds>      Process timeout in seconds (default: 900)
    --no-auth                Disable auth token (allows any application to connect)
    --log-level <level>      Log level: debug, info, warn, error (default: info)
    --origins <origins>      Comma-separated allowed origins
-V, --version                Output version number
-h, --help                   Display help
```

## Permission Modes

Control what the CLI agents can do with `--mode`:

```bash
agent-ws --mode safe          # Default — text generation only
agent-ws --mode agentic       # File operations (read/write/edit)
agent-ws --mode unrestricted  # Full system access — shell, network, everything
```

| Mode | Claude CLI flags | Codex CLI flags | Capabilities |
|------|-----------------|-----------------|--------------|
| `safe` | `--max-turns 1 --tools ""` | `--full-auto` | Text only, no tools |
| `agentic` | `--permission-mode dontAsk --allowedTools "Read,Write,Edit,Glob,Grep"` | `--full-auto` | File ops only, no shell/network |
| `unrestricted` | `--dangerously-skip-permissions` | `--sandbox danger-full-access --ask-for-approval never` | Everything |

**Choosing a mode:**
- Use `safe` when you only need text responses (Q&A, code generation without file access)
- Use `agentic` when Claude needs to read/write project files but shouldn't run commands
- Use `unrestricted` only in trusted, isolated environments where full system access is acceptable

## Architecture

```
┌───────────────┐     WebSocket      ┌─────────────┐      stdio       ┌─────────────┐
│  Your App     │ <=================> │  agent-ws   │ <===============> │ Claude Code │
│  (any client) │   localhost:9999   │  (Node.js)  │      stdio       │  / Codex    │
└───────────────┘                    └─────────────┘                   └─────────────┘
```

Any WebSocket client can connect — browser frontends, backend services, scripts, other CLI tools. Each connection gets its own CLI process. The agent:
1. Accepts WebSocket connections on localhost
2. Receives prompt messages from your client
3. Spawns the appropriate CLI agent (Claude Code or Codex)
4. Streams output back in real-time
5. Manages process lifecycle (timeout, cancellation, cleanup)

## Supported Agents

| Agent | Provider field | CLI |
|-------|---------------|-----|
| Claude Code | `"claude"` (default) | `claude --print --verbose --output-format stream-json` |
| Codex | `"codex"` | `codex --json` |

## Protocol

### Client → Agent

```json
{ "type": "prompt", "prompt": "Build a login form", "requestId": "uuid", "model": "opus", "provider": "claude" }
{ "type": "prompt", "prompt": "...", "requestId": "uuid", "projectId": "my-app", "systemPrompt": "...", "thinkingTokens": 2048 }
{ "type": "prompt", "prompt": "Describe this image", "requestId": "uuid", "images": [{ "media_type": "image/png", "data": "<base64>" }] }
{ "type": "cancel", "requestId": "uuid" }
```

| Field | Required | Description |
|-------|----------|-------------|
| `prompt` | yes | The prompt text (max 512KB) |
| `requestId` | yes | Unique request identifier |
| `model` | no | Model name (e.g. `"sonnet"`, `"opus"`) |
| `provider` | no | `"claude"` (default) or `"codex"` |
| `projectId` | no | Scopes CLI session by directory. Enables `--continue` for multi-turn. Alphanumeric, hyphens, underscores, dots only. |
| `systemPrompt` | no | Appended as system prompt (max 64KB) |
| `thinkingTokens` | no | Max thinking tokens. `0` disables thinking. Omit to let Claude decide. |
| `images` | no | Array of `{ media_type, data }` objects. Up to 4 images, max 10MB base64 each. Supported types: `image/png`, `image/jpeg`, `image/gif`, `image/webp`. |
| `files` | no | Array of `{ path, content }` objects. Up to 100 files, max 50MB total. Written to session directory for Claude to read/edit. |

### Agent → Client

```json
{ "type": "connected", "version": "1.0", "agent": "agent-ws", "mode": "safe" }
{ "type": "chunk", "content": "Here's a login form...", "requestId": "uuid" }
{ "type": "chunk", "content": "Let me think...", "requestId": "uuid", "thinking": true }
{ "type": "complete", "requestId": "uuid" }
{ "type": "error", "message": "Process timed out", "requestId": "uuid" }
```

Chunks with `thinking: true` contain Claude's reasoning. Clients can display these as a thinking indicator or ignore them.

## Authentication

agent-ws generates a random auth token on every startup. Clients must include it as a query parameter:

```
ws://localhost:9999?token=<token>
```

This prevents other websites or applications from connecting to your local agent-ws instance. Without this, any page you visit could open a WebSocket to `localhost:9999` and execute commands on your machine (browsers don't enforce CORS on WebSocket connections).

To disable authentication (e.g. for local development/testing):

```bash
agent-ws --no-auth
```

When using the library API, pass `authToken` in options:

```typescript
import { AgentWS } from "agent-ws";
import { randomBytes } from "node:crypto";

const token = randomBytes(32).toString("hex");
const agent = new AgentWS({ authToken: token });
await agent.start();
```

## Security

- **Auth token**: Random token generated on startup, required for all connections (disable with `--no-auth`)
- **Safe by default**: `--mode safe` restricts to text-only responses with no tool access
- **Local only**: Binds to `localhost` by default
- **Origin validation**: Optional `--origins` flag restricts allowed origins
- **No credentials**: Never stores or transmits API keys
- **Process isolation**: One CLI process per connection
- **Message limits**: 50MB max WebSocket payload, 512KB max prompt, 10MB per image (4 max), 100 files (50MB total)
- **Heartbeat**: Dead connections are cleaned up every 30 seconds
- **Path traversal protection**: File paths are validated to stay within the session directory

## Development

```bash
npm install          # Install dependencies
npm run build        # Build TypeScript
npm test             # Run tests
npm run typecheck    # Type check
npm start            # Start from built output
```

### Project Structure

```
src/
├── index.ts               # Barrel export (library entry point)
├── cli.ts                 # CLI entry point (Commander)
├── agent.ts               # Orchestrator: wires server + logger
├── server/
│   ├── websocket.ts       # WebSocket server, heartbeat, per-connection state
│   └── protocol.ts        # Message types, validation
├── process/
│   ├── claude-runner.ts   # Claude Code process spawn/kill/timeout
│   ├── codex-runner.ts    # Codex process spawn/kill/timeout
│   ├── file-watcher.ts    # Session directory file change detection
│   └── output-cleaner.ts  # ANSI stripping via node:util
└── utils/
    ├── logger.ts          # Pino logger factory
    └── claude-check.ts    # Claude CLI availability check
```

## Troubleshooting

### "Claude CLI not found"
Make sure Claude Code is installed:
```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

### "Port 9999 already in use"
Another instance might be running. Kill it or use a different port:
```bash
agent-ws --port 9998
```

## License

MIT

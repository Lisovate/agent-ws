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

# Connect via WebSocket on ws://localhost:9999
```

## Library Usage

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

## CLI Options

```
-p, --port <port>            WebSocket server port (default: 9999)
-H, --host <host>            WebSocket server host (default: localhost)
-c, --claude-path <path>     Path to Claude CLI (default: claude)
-t, --timeout <seconds>      Process timeout in seconds (default: 300)
    --log-level <level>      Log level: debug, info, warn, error (default: info)
    --origins <origins>      Comma-separated allowed origins
-V, --version                Output version number
-h, --help                   Display help
```

## Architecture

```
┌───────────────┐     WebSocket      ┌─────────────┐      stdio       ┌─────────────┐
│  Your App     │ <=================> │  agent-ws   │ <===============> │ Claude Code │
│  (any client) │   localhost:9999   │  (Node.js)  │   --print --json │  / Codex    │
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
| Claude Code | `"claude"` (default) | `claude --print` (+ `--continue` when `projectId` is set) |
| Codex | `"codex"` | `codex --json` |

## Protocol

### Client → Agent

```json
{ "type": "prompt", "prompt": "Build a login form", "requestId": "uuid", "model": "opus", "provider": "claude" }
{ "type": "prompt", "prompt": "...", "requestId": "uuid", "projectId": "my-app", "systemPrompt": "...", "thinkingTokens": 2048 }
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

### Agent → Client

```json
{ "type": "connected", "version": "1.0", "agent": "agent-ws" }
{ "type": "chunk", "content": "Here's a login form...", "requestId": "uuid" }
{ "type": "chunk", "content": "Let me think...", "requestId": "uuid", "thinking": true }
{ "type": "complete", "requestId": "uuid" }
{ "type": "error", "message": "Process timed out", "requestId": "uuid" }
```

Chunks with `thinking: true` contain Claude's reasoning. Clients can display these as a thinking indicator or ignore them.

## Security

- **Local only**: Binds to `localhost` by default
- **Origin validation**: Optional `--origins` flag restricts allowed origins
- **No credentials**: Never stores or transmits API keys
- **Process isolation**: One CLI process per connection
- **Message limits**: 1MB max WebSocket payload, 512KB max prompt size
- **Heartbeat**: Dead connections are cleaned up every 30 seconds

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

# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in agent-ws, please report it through [GitHub Security Advisories](https://github.com/Lisovate/agent-ws/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

agent-ws runs locally on your machine and bridges WebSocket connections to CLI AI agents. Security considerations include:

- **Local-only by default**: The WebSocket server binds to `localhost` to prevent external access.
- **Origin validation**: Optional `--origins` flag restricts which browser origins can connect.
- **No credential handling**: The agent never stores, processes, or transmits API keys or passwords.
- **Process isolation**: Each WebSocket connection gets its own CLI process.
- **Message size limits**: WebSocket payload capped at 1MB by default.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Latest release only |

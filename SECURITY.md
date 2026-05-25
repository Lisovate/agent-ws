# Security Policy

## Reporting a Vulnerability

If you discover a security vulnerability in agent-ws, please report it through [GitHub Security Advisories](https://github.com/Lisovate/agent-ws/security/advisories/new).

**Do not open a public issue for security vulnerabilities.**

We will acknowledge your report within 48 hours and aim to release a fix within 7 days for critical issues.

## Scope

agent-ws runs locally on your machine and bridges WebSocket connections to CLI AI agents. Security considerations include:

- **Local-only by default**: The WebSocket server binds to `localhost` to prevent external access.
- **Auth token**: A random 32-byte token is generated on startup and required as a `?token=` query parameter on all connections (disable with `--no-auth`). Comparison is timing-safe.
- **Permission modes**: `--mode safe` (default) restricts CLI agents to text-only output. `agentic` allows file ops only; `unrestricted` grants full system access (warned at startup). These flags are honoured by the CLI agent itself — for an OS-enforced boundary, combine with `--sandbox`.
- **OS sandbox (opt-in)**: `--sandbox os` wraps every spawned CLI in macOS Seatbelt (`sandbox-exec`) or Linux bubblewrap (`bwrap`). Writes are confined to the per-project session directory; credential dirs are bind-mounted read-only; macOS additionally allowlists outbound TCP to known agent endpoints. The default is `--sandbox none` — opt in explicitly. See the README for caveats (Seatbelt is Apple-deprecated; bwrap requires unprivileged user namespaces, which Ubuntu 24.04+ restricts by default; the Linux backend currently permits all outbound network).
- **Origin validation**: Optional `--origins` flag restricts which browser origins can connect.
- **Per-IP rate limiting**: Maximum 10 concurrent connections per source IP (configurable).
- **No credential handling**: The agent never stores, processes, or transmits API keys or passwords. Child processes inherit only an explicit allowlist of environment variables.
- **Process isolation**: Each WebSocket connection gets its own CLI process.
- **Path-traversal protection**: All file paths supplied via the `files` field — and post-edit reads — are validated to stay within the per-project session directory. Symlinks are resolved (`realpath`) before reading to prevent escape.
- **Message size limits**: WebSocket payload capped at 50MB (to support large images), prompt limited to 512KB, individual images to 10MB (4 max), files to 50MB total (100 max).
- **Graceful shutdown**: SIGINT/SIGTERM trigger a 5-second drain so in-flight requests can complete before the process exits.

## What the OS sandbox does *not* guarantee

`--sandbox os` is a meaningful improvement over no sandbox, but it is not a kernel-isolation boundary like a VM or container. Specifically:

- **macOS Seatbelt** is Apple-deprecated. The mechanism works today and is what every published agent sandbox uses, but Apple has not committed to keeping it. Profile maintenance per macOS minor release is real.
- **Linux bwrap** uses mount namespaces and unshare; it is bypassable by kernel exploits and does not isolate the network stack by hostname. It refuses to start when unprivileged user namespaces are blocked (Ubuntu 24.04+ default) — see README troubleshooting.
- **Windows** has no native sandbox in this version. We recommend WSL2 with the Linux bwrap backend.
- **Credential dirs are read-only** in the sandbox. A future CLI version that writes back to `~/.claude` or `~/.codex` (e.g. for token refresh) will need a writable copy or an explicit allow rule.

If you need a kernel-isolation boundary (running untrusted prompts, multi-tenant deployments), run agent-ws inside a container or VM. The dumb-pipe design composes cleanly with Docker, Podman, Firecracker, or similar.

## Supported Versions

| Version | Supported |
|---------|-----------|
| 1.x     | Latest release only |

import { statSync } from "node:fs";
import type {
  Sandbox,
  SandboxSpawnOpts,
  SandboxSpawnResult,
} from "./types.js";
import type { PermissionMode } from "../../server/protocol.js";

const SANDBOX_EXEC_PATH = "/usr/bin/sandbox-exec";

/** Hostnames the CLI agents need outbound HTTPS access to. Kept narrow on
 * purpose — extend via --sandbox-network-allowlist in a future iteration. */
const DEFAULT_NETWORK_HOSTS = [
  "api.anthropic.com",
  "api.openai.com",
  "openaipublic.blob.core.windows.net",
  "openaiapi-site.azureedge.net",
] as const;

function quoteLiteral(value: string): string {
  // SBPL string literal: backslash and double-quote must be escaped.
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/** Produce the SBPL (sandbox profile language) source for a given mode and
 * session directory. Pure function — used by tests and the spawn wrapper. */
export function buildSeatbeltProfile(opts: {
  mode: PermissionMode;
  sessionDir?: string;
  credentialDirs: string[];
  networkHosts?: readonly string[];
}): string {
  const { mode, sessionDir, credentialDirs } = opts;
  const networkHosts = opts.networkHosts ?? DEFAULT_NETWORK_HOSTS;

  const lines: string[] = [
    "(version 1)",
    "(deny default)",
    // Required for fork/exec, signals, pipes, ipc — without these the CLI
    // can't even spawn its tool subprocesses.
    "(allow process-fork)",
    "(allow signal (target same-sandbox))",
    "(allow file-read-metadata)",
    "(allow file-read*)",
    "(allow sysctl-read)",
    "(allow mach-lookup)",
    "(allow ipc-posix-shm)",
    // Process execution is mode-dependent.
  ];

  if (mode === "safe") {
    // Read-only mode: allow exec of the CLI itself and core unix tooling,
    // but no writes anywhere.
    lines.push(
      "(allow process-exec (literal \"/bin/sh\") (literal \"/bin/bash\") (literal \"/usr/bin/env\"))",
    );
  } else {
    // agentic and unrestricted: allow exec of common dev tools.
    lines.push("(allow process-exec)");
  }

  // Writes: only the session dir + a small set of OS-required paths.
  // Without /private/var/folders writes, Node + most CLIs fail to start.
  const writeSubpaths: string[] = [
    "/private/tmp",
    "/private/var/folders",
    "/private/var/tmp",
  ];
  if (sessionDir) writeSubpaths.push(sessionDir);

  if (mode !== "safe") {
    const writeRules = writeSubpaths
      .map((p) => `  (subpath "${quoteLiteral(p)}")`)
      .join("\n");
    lines.push(`(allow file-write*\n${writeRules})`);
  } else {
    // Safe mode: only allow temp scratch writes (the CLI itself needs them).
    const tmpRules = [
      "/private/tmp",
      "/private/var/folders",
      "/private/var/tmp",
    ]
      .map((p) => `  (subpath "${quoteLiteral(p)}")`)
      .join("\n");
    lines.push(`(allow file-write*\n${tmpRules})`);
  }

  // Credential dirs are explicitly read-only (file-read* above already
  // covers them, but make it explicit so a future tightening doesn't
  // accidentally lock the CLI out of its config).
  for (const dir of credentialDirs) {
    lines.push(`(allow file-read* (subpath "${quoteLiteral(dir)}"))`);
  }

  // Network: outbound to known agent endpoints + DNS.
  lines.push("(allow network-bind (local ip))");
  lines.push("(allow network-outbound (remote unix-socket))");
  lines.push("(allow network-outbound (control-name \"com.apple.netsrc\"))");
  lines.push("(allow system-socket)");
  lines.push("(allow network-outbound (remote tcp \"localhost:*\"))");
  lines.push("(allow network-outbound (remote udp \"*:53\"))");
  for (const host of networkHosts) {
    lines.push(`(allow network-outbound (remote tcp "${quoteLiteral(host)}:443"))`);
  }

  return lines.join("\n") + "\n";
}

/** macOS Seatbelt (sandbox-exec) backed sandbox.
 *
 * Apple has marked sandbox-exec as deprecated but it remains the only
 * available mechanism for sandboxing non-bundled binaries on macOS, and is
 * what every published agent-sandboxing setup uses today. See
 * docs/improvement-plan.html and the SECURITY.md for the trade-offs. */
export class SeatbeltSandbox implements Sandbox {
  readonly id = "seatbelt" as const;
  readonly available: boolean;
  readonly unavailableReason?: string;

  constructor() {
    if (process.platform !== "darwin") {
      this.available = false;
      this.unavailableReason = "Seatbelt is macOS-only";
      return;
    }
    try {
      const st = statSync(SANDBOX_EXEC_PATH);
      this.available = st.isFile();
      if (!this.available) {
        this.unavailableReason = `${SANDBOX_EXEC_PATH} is not a regular file`;
      }
    } catch (err) {
      this.available = false;
      this.unavailableReason = `sandbox-exec not found at ${SANDBOX_EXEC_PATH}`;
      void err;
    }
  }

  wrapSpawn(cmd: string, args: string[], opts: SandboxSpawnOpts): SandboxSpawnResult {
    const profile = buildSeatbeltProfile({
      mode: opts.mode,
      sessionDir: opts.sessionDir,
      credentialDirs: opts.credentialDirs,
    });
    return {
      cmd: SANDBOX_EXEC_PATH,
      args: ["-p", profile, cmd, ...args],
    };
  }
}

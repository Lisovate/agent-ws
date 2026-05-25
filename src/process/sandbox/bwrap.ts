import { execFileSync } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import type {
  Sandbox,
  SandboxSpawnOpts,
  SandboxSpawnResult,
} from "./types.js";
import type { PermissionMode } from "../../server/protocol.js";

const CANDIDATE_BWRAP_PATHS = [
  "/usr/bin/bwrap",
  "/usr/local/bin/bwrap",
  "/opt/homebrew/bin/bwrap",
] as const;

function findBwrap(): string | undefined {
  for (const path of CANDIDATE_BWRAP_PATHS) {
    try {
      if (statSync(path).isFile()) return path;
    } catch {
      // not present at this path, try next
    }
  }
  // Try PATH lookup as a fallback (bwrap installed somewhere non-standard).
  try {
    const out = execFileSync("/usr/bin/env", ["bwrap", "--version"], {
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 2_000,
    });
    if (out.length > 0) return "bwrap";
  } catch {
    // bwrap not on PATH
  }
  return undefined;
}

/** True when the running Linux kernel disallows unprivileged user namespaces
 * (the bwrap mount-isolation primitive requires them). Ubuntu 24.04+ ships
 * with this restriction by default. */
function userNamespacesRestricted(): boolean {
  try {
    const raw = readFileSync("/proc/sys/kernel/unprivileged_userns_clone", "utf-8").trim();
    if (raw === "0") return true;
  } catch {
    // file not present on this kernel — not the blocker, fall through
  }
  try {
    const raw = readFileSync(
      "/proc/sys/kernel/apparmor_restrict_unprivileged_userns",
      "utf-8",
    ).trim();
    if (raw === "1") return true;
  } catch {
    // not present — fine
  }
  return false;
}

/** Produce the bwrap argv (excluding the bwrap binary itself and the trailing
 * `-- cmd args` user command). Pure function for tests. */
export function buildBwrapArgs(opts: {
  mode: PermissionMode;
  sessionDir?: string;
  credentialDirs: string[];
}): string[] {
  const { mode, sessionDir, credentialDirs } = opts;
  const args: string[] = [
    // Filesystem skeleton: read-only OS, fresh /tmp, /proc, /dev.
    "--ro-bind", "/usr", "/usr",
    "--ro-bind-try", "/lib", "/lib",
    "--ro-bind-try", "/lib64", "/lib64",
    "--ro-bind-try", "/lib32", "/lib32",
    "--ro-bind-try", "/bin", "/bin",
    "--ro-bind-try", "/sbin", "/sbin",
    "--ro-bind-try", "/etc/resolv.conf", "/etc/resolv.conf",
    "--ro-bind-try", "/etc/ssl", "/etc/ssl",
    "--ro-bind-try", "/etc/ca-certificates", "/etc/ca-certificates",
    "--proc", "/proc",
    "--dev", "/dev",
    "--tmpfs", "/tmp",
    "--unshare-all",
    "--share-net",
    "--die-with-parent",
    "--new-session",
  ];

  for (const dir of credentialDirs) {
    args.push("--ro-bind-try", dir, dir);
  }

  if (sessionDir) {
    if (mode === "safe") {
      args.push("--ro-bind", sessionDir, sessionDir);
    } else {
      args.push("--bind", sessionDir, sessionDir);
    }
    args.push("--chdir", sessionDir);
  }

  // HOME is required by many CLIs (cache dirs, dotfiles). Without one, the
  // bwrap'd process gets HOME=/ which most tools refuse.
  args.push("--setenv", "HOME", "/tmp");

  return args;
}

/** Linux bubblewrap-backed sandbox. Requires unprivileged user namespaces;
 * detect-and-warn when Ubuntu 24.04+ blocks them. */
export class BwrapSandbox implements Sandbox {
  readonly id = "bwrap" as const;
  readonly available: boolean;
  readonly unavailableReason?: string;
  private readonly bwrapPath?: string;

  constructor() {
    if (process.platform !== "linux") {
      this.available = false;
      this.unavailableReason = "bwrap is Linux-only";
      return;
    }
    const path = findBwrap();
    if (!path) {
      this.available = false;
      this.unavailableReason = "bwrap binary not found on PATH (apt install bubblewrap)";
      return;
    }
    if (userNamespacesRestricted()) {
      this.available = false;
      this.unavailableReason =
        "unprivileged user namespaces are restricted (Ubuntu 24.04+ default); " +
        "run `sudo sysctl -w kernel.apparmor_restrict_unprivileged_userns=0` to enable";
      return;
    }
    this.available = true;
    this.bwrapPath = path;
  }

  wrapSpawn(cmd: string, args: string[], opts: SandboxSpawnOpts): SandboxSpawnResult {
    if (!this.bwrapPath) {
      throw new Error(`BwrapSandbox is unavailable: ${this.unavailableReason}`);
    }
    const bwrapArgs = buildBwrapArgs({
      mode: opts.mode,
      sessionDir: opts.sessionDir,
      credentialDirs: opts.credentialDirs,
    });
    return {
      cmd: this.bwrapPath,
      args: [...bwrapArgs, "--", cmd, ...args],
    };
  }
}

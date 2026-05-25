import type { PermissionMode } from "../../server/protocol.js";

/** Concrete sandbox implementation IDs (one per backend). */
export type SandboxId = "none" | "seatbelt" | "bwrap";

/** User-facing --sandbox values. "os" picks the best OS-native sandbox for the
 * current platform; explicit ids force a specific backend. */
export type SandboxPreference = SandboxId | "auto" | "os";

export interface SandboxSpawnOpts {
  mode: PermissionMode;
  /** Project session directory. When undefined the CLI runs with no
   * project-scoped writable area; sandboxes may restrict writes accordingly. */
  sessionDir?: string;
  /** Absolute paths that must be readable inside the sandbox (typically the
   * agent's credential directories like ~/.claude or ~/.codex). */
  credentialDirs: string[];
}

export interface SandboxSpawnResult {
  cmd: string;
  args: string[];
  /** Extra env vars to merge into the spawn env. Sandbox env overrides
   * the caller's env for the same key. */
  env?: Record<string, string>;
}

/** Wraps a child-process spawn with platform-appropriate isolation. */
export interface Sandbox {
  readonly id: SandboxId;
  /** True when this sandbox can actually be applied on the current host
   * (binary present, OS supported, kernel features enabled, etc.). */
  readonly available: boolean;
  /** When `available` is false, a short human-readable reason — used in
   * startup warnings and the capabilities handshake. */
  readonly unavailableReason?: string;

  wrapSpawn(cmd: string, args: string[], opts: SandboxSpawnOpts): SandboxSpawnResult;
}

import type {
  Sandbox,
  SandboxSpawnOpts,
  SandboxSpawnResult,
} from "./types.js";

/** Pass-through sandbox: returns the original cmd/args unchanged.
 * Used when --sandbox is "none", or as a fallback when no OS sandbox is
 * available on the current host. */
export class NoopSandbox implements Sandbox {
  readonly id = "none" as const;
  readonly available = true;

  wrapSpawn(cmd: string, args: string[], _opts: SandboxSpawnOpts): SandboxSpawnResult {
    return { cmd, args };
  }
}

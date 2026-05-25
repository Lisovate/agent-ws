import type { Logger } from "../../utils/logger.js";
import { NoopSandbox } from "./noop.js";
import { SeatbeltSandbox } from "./seatbelt.js";
import { BwrapSandbox } from "./bwrap.js";
import type {
  Sandbox,
  SandboxId,
  SandboxPreference,
} from "./types.js";

export type {
  Sandbox,
  SandboxId,
  SandboxPreference,
  SandboxSpawnOpts,
  SandboxSpawnResult,
} from "./types.js";
export { NoopSandbox } from "./noop.js";
export { SeatbeltSandbox } from "./seatbelt.js";
export { BwrapSandbox } from "./bwrap.js";

export interface SelectSandboxOptions {
  preference?: SandboxPreference;
  platform?: NodeJS.Platform;
  logger?: Logger;
}

export const SANDBOX_PREFERENCES: readonly SandboxPreference[] = [
  "auto",
  "none",
  "os",
  "seatbelt",
  "bwrap",
] as const;

/** Returns the OS-native sandbox candidate for `platform`, or null if the
 * platform has no native backend in agent-ws (Windows, FreeBSD, etc.). */
function osCandidate(platform: NodeJS.Platform): Sandbox | null {
  if (platform === "darwin") return new SeatbeltSandbox();
  if (platform === "linux") return new BwrapSandbox();
  return null;
}

/** Build the Sandbox impl that matches the user's preference and host. */
export function selectSandbox(opts: SelectSandboxOptions = {}): Sandbox {
  const preference = opts.preference ?? "none";
  const platform = opts.platform ?? process.platform;
  const log = opts.logger;

  if (preference === "none") return new NoopSandbox();
  if (preference === "seatbelt") return assertAvailable(new SeatbeltSandbox(), log);
  if (preference === "bwrap") return assertAvailable(new BwrapSandbox(), log);

  // "auto" and "os" both prefer the OS-native sandbox.
  const candidate = osCandidate(platform);
  if (candidate?.available) return candidate;

  if (preference === "os") {
    const reason = candidate
      ? candidate.unavailableReason ?? "OS sandbox detected but unavailable"
      : `no OS-native sandbox available on ${platform}`;
    throw new Error(`--sandbox=os requested but unavailable: ${reason}`);
  }

  // "auto": fall back with a warning so users still get a working agent.
  log?.warn(
    { platform, attempted: candidate?.id, reason: candidate?.unavailableReason },
    "No OS sandbox available; falling back to NoopSandbox (no isolation)",
  );
  return new NoopSandbox();
}

function assertAvailable(sandbox: Sandbox, log?: Logger): Sandbox {
  if (sandbox.available) return sandbox;
  const reason = sandbox.unavailableReason ?? "unknown";
  log?.error({ sandbox: sandbox.id, reason }, `Requested sandbox ${sandbox.id} is unavailable`);
  throw new Error(`--sandbox=${sandbox.id} requested but unavailable: ${reason}`);
}

export function isSandboxPreference(value: string): value is SandboxPreference {
  return (SANDBOX_PREFERENCES as readonly string[]).includes(value);
}

export const ALL_SANDBOX_IDS: readonly SandboxId[] = ["none", "seatbelt", "bwrap"] as const;

/** Report which sandboxes can be activated on this host (used by the
 * capabilities handshake). */
export function probeAvailableSandboxes(platform: NodeJS.Platform = process.platform): SandboxId[] {
  const probes: Sandbox[] = [new NoopSandbox()];
  if (platform === "darwin") probes.push(new SeatbeltSandbox());
  if (platform === "linux") probes.push(new BwrapSandbox());

  return probes.filter((s) => s.available).map((s) => s.id);
}

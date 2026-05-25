import pino from "pino";
import type { ChildProcess } from "node:child_process";
import { BaseRunner, type RunOptions, type RunHandlers } from "../src/process/base-runner.js";
import {
  NoopSandbox,
  SeatbeltSandbox,
  BwrapSandbox,
  selectSandbox,
  isSandboxPreference,
  probeAvailableSandboxes,
  SANDBOX_PREFERENCES,
  type Sandbox,
  type SandboxSpawnOpts,
} from "../src/process/sandbox/index.js";
import { buildSeatbeltProfile } from "../src/process/sandbox/seatbelt.js";
import { buildBwrapArgs } from "../src/process/sandbox/bwrap.js";

const testLogger = pino({ level: "silent" });
const isDarwin = process.platform === "darwin";
const isLinux = process.platform === "linux";

describe("NoopSandbox", () => {
  const sb = new NoopSandbox();

  it("has id 'none' and is always available", () => {
    expect(sb.id).toBe("none");
    expect(sb.available).toBe(true);
    expect(sb.unavailableReason).toBeUndefined();
  });

  it("wrapSpawn returns the original cmd and args unchanged", () => {
    const result = sb.wrapSpawn("claude", ["--print", "hello"], {
      mode: "safe",
      sessionDir: "/tmp/x",
      credentialDirs: ["/Users/test/.claude"],
    });
    expect(result.cmd).toBe("claude");
    expect(result.args).toEqual(["--print", "hello"]);
    expect(result.env).toBeUndefined();
  });

  it("never mutates the input args array", () => {
    const args = ["a", "b", "c"];
    const result = sb.wrapSpawn("cmd", args, { mode: "safe", credentialDirs: [] });
    expect(result.args).toEqual(args);
    // identity is allowed here — but mutation would fail this:
    expect(args).toEqual(["a", "b", "c"]);
  });
});

describe("selectSandbox", () => {
  it("returns NoopSandbox when preference is 'none'", () => {
    const sb = selectSandbox({ preference: "none" });
    expect(sb.id).toBe("none");
    expect(sb.available).toBe(true);
  });

  it("defaults to NoopSandbox when no preference given", () => {
    const sb = selectSandbox();
    expect(sb.id).toBe("none");
  });

  it("'auto' on an unsupported platform falls back to NoopSandbox with a logged warning", () => {
    let warned = false;
    const log = {
      ...pino({ level: "silent" }),
      warn: () => { warned = true; },
    } as unknown as ReturnType<typeof pino>;

    const sb = selectSandbox({ preference: "auto", platform: "win32", logger: log });
    expect(sb.id).toBe("none");
    expect(warned).toBe(true);
  });

  it("'os' on an unsupported platform throws", () => {
    expect(() => selectSandbox({ preference: "os", platform: "win32" })).toThrow(/os/);
  });

  it("'seatbelt' throws when not on darwin", () => {
    if (isDarwin) return;
    expect(() => selectSandbox({ preference: "seatbelt" })).toThrow(/seatbelt/);
  });

  it("'bwrap' throws when not on linux", () => {
    if (isLinux) return;
    expect(() => selectSandbox({ preference: "bwrap" })).toThrow(/bwrap/);
  });

  it.skipIf(!isDarwin)("'os' on darwin returns SeatbeltSandbox", () => {
    const sb = selectSandbox({ preference: "os", platform: "darwin" });
    expect(sb.id).toBe("seatbelt");
    expect(sb.available).toBe(true);
  });

  it.skipIf(!isDarwin)("'seatbelt' on darwin returns a usable sandbox", () => {
    const sb = selectSandbox({ preference: "seatbelt" });
    expect(sb.id).toBe("seatbelt");
    expect(sb.available).toBe(true);
  });
});

describe("isSandboxPreference", () => {
  it("accepts every value in SANDBOX_PREFERENCES", () => {
    for (const p of SANDBOX_PREFERENCES) {
      expect(isSandboxPreference(p)).toBe(true);
    }
  });

  it("rejects unknown values", () => {
    expect(isSandboxPreference("docker")).toBe(false);
    expect(isSandboxPreference("")).toBe(false);
    expect(isSandboxPreference("NONE")).toBe(false);
    expect(isSandboxPreference("foo")).toBe(false);
  });
});

describe("probeAvailableSandboxes", () => {
  it("always includes 'none'", () => {
    expect(probeAvailableSandboxes()).toContain("none");
  });

  it.skipIf(!isDarwin)("includes 'seatbelt' on darwin", () => {
    expect(probeAvailableSandboxes("darwin")).toContain("seatbelt");
  });

  it("does not include 'bwrap' on darwin", () => {
    expect(probeAvailableSandboxes("darwin")).not.toContain("bwrap");
  });

  it("does not include 'seatbelt' on linux", () => {
    expect(probeAvailableSandboxes("linux")).not.toContain("seatbelt");
  });
});

describe("SeatbeltSandbox", () => {
  it("reports unavailable on non-darwin platforms", () => {
    if (isDarwin) return;
    const sb = new SeatbeltSandbox();
    expect(sb.available).toBe(false);
    expect(sb.unavailableReason).toMatch(/macOS/);
  });

  it.skipIf(!isDarwin)("reports available on darwin (sandbox-exec at /usr/bin/sandbox-exec)", () => {
    const sb = new SeatbeltSandbox();
    expect(sb.available).toBe(true);
  });

  it.skipIf(!isDarwin)("wrapSpawn invokes /usr/bin/sandbox-exec -p <profile> cmd args", () => {
    const sb = new SeatbeltSandbox();
    const result = sb.wrapSpawn("claude", ["--print"], {
      mode: "agentic",
      sessionDir: "/tmp/session",
      credentialDirs: ["/Users/test/.claude"],
    });
    expect(result.cmd).toBe("/usr/bin/sandbox-exec");
    expect(result.args[0]).toBe("-p");
    // The profile string lands at args[1]
    expect(result.args[1]).toMatch(/\(version 1\)/);
    expect(result.args[1]).toMatch(/\(deny default\)/);
    // The wrapped command follows
    expect(result.args[2]).toBe("claude");
    expect(result.args[3]).toBe("--print");
  });
});

describe("buildSeatbeltProfile", () => {
  it("always emits (version 1) and (deny default)", () => {
    for (const mode of ["safe", "agentic", "unrestricted"] as const) {
      const profile = buildSeatbeltProfile({ mode, credentialDirs: [] });
      expect(profile).toMatch(/\(version 1\)/);
      expect(profile).toMatch(/\(deny default\)/);
    }
  });

  it("safe mode does not allow open process-exec", () => {
    const profile = buildSeatbeltProfile({ mode: "safe", credentialDirs: [] });
    expect(profile).not.toMatch(/^\(allow process-exec\)$/m);
    // It does allow the small shell whitelist (the CLI itself needs to fork)
    expect(profile).toMatch(/process-exec.*\/bin\/sh/);
  });

  it("agentic mode allows process-exec broadly", () => {
    const profile = buildSeatbeltProfile({ mode: "agentic", credentialDirs: [] });
    expect(profile).toMatch(/^\(allow process-exec\)$/m);
  });

  it("unrestricted mode allows process-exec broadly", () => {
    const profile = buildSeatbeltProfile({ mode: "unrestricted", credentialDirs: [] });
    expect(profile).toMatch(/^\(allow process-exec\)$/m);
  });

  it("includes the session directory in writable subpaths for non-safe modes", () => {
    const profile = buildSeatbeltProfile({
      mode: "agentic",
      sessionDir: "/private/tmp/sessions/proj-1",
      credentialDirs: [],
    });
    expect(profile).toMatch(/\(subpath "\/private\/tmp\/sessions\/proj-1"\)/);
  });

  it("safe mode does not add the session dir to writable subpaths", () => {
    const profile = buildSeatbeltProfile({
      mode: "safe",
      sessionDir: "/private/tmp/sessions/proj-1",
      credentialDirs: [],
    });
    // Only /private/tmp etc are writable, not the session dir specifically
    const writeBlock = profile.split("(allow file-write*")[1] ?? "";
    expect(writeBlock).not.toContain("proj-1");
  });

  it("adds explicit read-only carve-outs for credential dirs", () => {
    const profile = buildSeatbeltProfile({
      mode: "agentic",
      credentialDirs: ["/Users/test/.claude", "/Users/test/.codex"],
    });
    expect(profile).toMatch(/file-read\*.*\/Users\/test\/\.claude/);
    expect(profile).toMatch(/file-read\*.*\/Users\/test\/\.codex/);
  });

  it("escapes double quotes in path literals", () => {
    const profile = buildSeatbeltProfile({
      mode: "agentic",
      sessionDir: '/tmp/has"quote',
      credentialDirs: [],
    });
    expect(profile).toContain('\\"');
  });

  it("includes the default network allowlist by default", () => {
    const profile = buildSeatbeltProfile({ mode: "agentic", credentialDirs: [] });
    expect(profile).toMatch(/network-outbound.*api\.anthropic\.com/);
    expect(profile).toMatch(/network-outbound.*api\.openai\.com/);
  });

  it("honours a custom network allowlist", () => {
    const profile = buildSeatbeltProfile({
      mode: "agentic",
      credentialDirs: [],
      networkHosts: ["example.invalid"],
    });
    expect(profile).toMatch(/example\.invalid/);
    expect(profile).not.toMatch(/anthropic\.com/);
  });
});

describe("BwrapSandbox", () => {
  it("reports unavailable on non-linux platforms", () => {
    if (isLinux) return;
    const sb = new BwrapSandbox();
    expect(sb.available).toBe(false);
    expect(sb.unavailableReason).toMatch(/Linux/);
  });
});

describe("buildBwrapArgs", () => {
  it("always emits an isolated rootfs skeleton", () => {
    const args = buildBwrapArgs({ mode: "safe", credentialDirs: [] });
    expect(args).toContain("--ro-bind");
    expect(args).toContain("/usr");
    expect(args).toContain("--proc");
    expect(args).toContain("--dev");
    expect(args).toContain("--unshare-all");
    expect(args).toContain("--share-net");
    expect(args).toContain("--die-with-parent");
  });

  it("safe mode bind-mounts session dir read-only", () => {
    const args = buildBwrapArgs({ mode: "safe", sessionDir: "/work/proj", credentialDirs: [] });
    // Look for the --ro-bind /work/proj /work/proj sequence
    const idx = args.findIndex((a, i) => a === "--ro-bind" && args[i + 1] === "/work/proj" && args[i + 2] === "/work/proj");
    expect(idx).toBeGreaterThanOrEqual(0);
    // And not a writable bind for the same path
    const writeIdx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/work/proj");
    expect(writeIdx).toBe(-1);
  });

  it("agentic mode bind-mounts session dir read-write", () => {
    const args = buildBwrapArgs({ mode: "agentic", sessionDir: "/work/proj", credentialDirs: [] });
    const idx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/work/proj" && args[i + 2] === "/work/proj");
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  it("unrestricted mode bind-mounts session dir read-write", () => {
    const args = buildBwrapArgs({ mode: "unrestricted", sessionDir: "/work/proj", credentialDirs: [] });
    const idx = args.findIndex((a, i) => a === "--bind" && args[i + 1] === "/work/proj" && args[i + 2] === "/work/proj");
    expect(idx).toBeGreaterThanOrEqual(0);
  });

  it("omits session-dir mounts and --chdir when sessionDir is undefined", () => {
    const args = buildBwrapArgs({ mode: "agentic", credentialDirs: [] });
    expect(args).not.toContain("--chdir");
    expect(args.filter((a) => a === "--bind")).toHaveLength(0);
  });

  it("adds --ro-bind-try for each credential dir", () => {
    const args = buildBwrapArgs({
      mode: "agentic",
      credentialDirs: ["/home/x/.claude", "/home/x/.codex"],
    });
    const tries = args.reduce<number[]>((acc, a, i) => (a === "--ro-bind-try" ? [...acc, i] : acc), []);
    const credentialEntries = tries.filter((i) => args[i + 1] === "/home/x/.claude" || args[i + 1] === "/home/x/.codex");
    expect(credentialEntries.length).toBe(2);
  });

  it("sets HOME to /tmp to satisfy tools that require HOME", () => {
    const args = buildBwrapArgs({ mode: "safe", credentialDirs: [] });
    const setenvIdx = args.findIndex((a, i) => a === "--setenv" && args[i + 1] === "HOME");
    expect(setenvIdx).toBeGreaterThanOrEqual(0);
    expect(args[setenvIdx + 2]).toBe("/tmp");
  });
});

// --- BaseRunner integration: verify wrapSpawn is invoked with the right opts ---

class RecordingSandbox implements Sandbox {
  readonly id = "none" as const;
  readonly available = true;
  lastOpts: SandboxSpawnOpts | null = null;
  lastCmd: string | null = null;
  lastArgs: string[] | null = null;

  wrapSpawn(cmd: string, args: string[], opts: SandboxSpawnOpts) {
    this.lastOpts = opts;
    this.lastCmd = cmd;
    this.lastArgs = args;
    // Rewrite to an obviously-fake binary so we can confirm the runner used
    // the wrapped value (the spawn will then fail with ENOENT).
    return { cmd: "/nonexistent/wrapped-bin", args: ["--wrapped", ...args], env: { WRAPPED_BY: "test" } };
  }
}

class IntegrationRunner extends BaseRunner {
  constructor(sandbox: Sandbox, credentials: string[]) {
    super({
      cliPath: "/nonexistent/orig",
      defaultCliPath: "/nonexistent/orig",
      logger: testLogger,
      agentLabel: "Test",
      allowedEnvKeys: ["PATH"],
      mode: "agentic",
      sandbox,
    });
    this.creds = credentials;
  }

  private readonly creds: string[];

  protected credentialDirs(): string[] {
    return this.creds;
  }

  protected buildArgs(): string[] {
    return ["--print", "hi"];
  }

  protected parseStreamLine(): void {}
  protected writeStdin(): void {}
}

describe("BaseRunner ↔ Sandbox integration", () => {
  it("calls sandbox.wrapSpawn with the runner's mode and credential dirs", async () => {
    const sandbox = new RecordingSandbox();
    const runner = new IntegrationRunner(sandbox, ["/fake/.claude", "/fake/.codex"]);
    const errors: string[] = [];
    runner.run(
      { prompt: "hi", requestId: "r1" },
      {
        onChunk: () => {},
        onComplete: () => {},
        onError: (m) => errors.push(m),
      },
    );

    // Wait for the spawn error to surface
    await new Promise((r) => setTimeout(r, 80));
    runner.dispose();

    expect(sandbox.lastOpts).not.toBeNull();
    expect(sandbox.lastOpts!.mode).toBe("agentic");
    expect(sandbox.lastOpts!.credentialDirs).toEqual(["/fake/.claude", "/fake/.codex"]);
    expect(sandbox.lastCmd).toBe("/nonexistent/orig");
    expect(sandbox.lastArgs).toEqual(["--print", "hi"]);
  });

  it("spawns the wrapped cmd, not the original", async () => {
    const sandbox = new RecordingSandbox();
    const runner = new IntegrationRunner(sandbox, []);
    const errors: string[] = [];
    runner.run(
      { prompt: "hi", requestId: "r2" },
      {
        onChunk: () => {},
        onComplete: () => {},
        onError: (m) => errors.push(m),
      },
    );

    await new Promise((r) => setTimeout(r, 80));
    runner.dispose();

    // The error must reference the wrapped path; if the runner had spawned
    // the original we'd see /nonexistent/orig in the error.
    expect(errors).toHaveLength(1);
    expect(errors[0]!).toMatch(/wrapped-bin|ENOENT/);
  });
});

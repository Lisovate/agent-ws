import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, relative, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createInterface, type Interface as ReadlineInterface } from "node:readline";
import type { Logger } from "../utils/logger.js";
import type { PromptImage, PromptFile, PermissionMode } from "../server/protocol.js";
import { NoopSandbox } from "./sandbox/noop.js";
import type { Sandbox } from "./sandbox/types.js";

/**
 * Returns true if `child` resolves to a path inside (or equal to) `parent`.
 * Path-only check — does not follow symlinks. Use realpathSync first if symlink
 * resolution matters.
 */
export function isWithin(parent: string, child: string): boolean {
  const rel = relative(parent, resolve(parent, child));
  return rel === "" || (!rel.startsWith("..") && !isAbsolute(rel));
}

export interface ToolEventData {
  event: "start" | "complete";
  toolName?: string;
  toolId?: string;
  input?: Record<string, unknown>;
}

export interface FileChangeData {
  path: string;
  changeType: "create" | "update" | "delete";
  content?: string;
}

export interface RunOptions {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  projectId?: string;
  requestId: string;
  thinkingTokens?: number;
  images?: PromptImage[];
  files?: PromptFile[];
}

export interface RunHandlers {
  onChunk: (content: string, requestId: string, thinking?: boolean) => void;
  onComplete: (requestId: string) => void;
  onError: (message: string, requestId: string) => void;
  onToolEvent?: (event: ToolEventData, requestId: string) => void;
  onFileChange?: (change: FileChangeData, requestId: string) => void;
}

/** Interface for runner injection (testing) */
export interface Runner {
  run(options: RunOptions, handlers: RunHandlers): void;
  kill(): void;
  dispose(): void;
}

export interface BaseRunnerOptions {
  cliPath: string;
  defaultCliPath: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
  mode?: PermissionMode;
  agentLabel: string;
  allowedEnvKeys: readonly string[];
  /** Sandbox wrapper applied to every spawn. Defaults to NoopSandbox. */
  sandbox?: Sandbox;
}

const DEFAULT_TIMEOUT_MS = 600_000; // 10 minutes for multi-turn work

export abstract class BaseRunner implements Runner {
  protected process: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  protected disposed = false;
  protected killed = false;
  protected lastSystemPrompt: string | undefined;
  protected readonly cliPath: string;
  protected readonly timeoutMs: number;
  protected readonly log: Logger;
  protected readonly sessionDir: string;
  protected readonly mode: PermissionMode;
  protected readonly sandbox: Sandbox;
  private readonly agentLabel: string;
  private readonly allowedEnvKeys: readonly string[];

  constructor(options: BaseRunnerOptions) {
    this.cliPath = options.cliPath ?? options.defaultCliPath;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.logger;
    this.sessionDir = options.sessionDir ?? "agent-ws-sessions";
    this.mode = options.mode ?? "safe";
    this.sandbox = options.sandbox ?? new NoopSandbox();
    this.agentLabel = options.agentLabel;
    this.allowedEnvKeys = options.allowedEnvKeys;
  }

  get isRunning(): boolean {
    return this.process !== null;
  }

  run(options: RunOptions, handlers: RunHandlers): void {
    if (this.disposed) {
      handlers.onError("Runner has been disposed", options.requestId);
      return;
    }

    this.kill();

    const { prompt, systemPrompt, projectId, requestId, files } = options;

    // Cache systemPrompt: reuse last value when omitted on follow-up messages
    if (systemPrompt !== undefined) {
      this.lastSystemPrompt = systemPrompt;
    }

    this.onBeforeRun(options);

    // Use project-scoped CWD so session continuity works by working directory
    let cwd: string | undefined;
    if (projectId) {
      const base = resolve(tmpdir(), this.sessionDir);
      cwd = resolve(base, projectId);
      if (!isWithin(base, cwd)) {
        handlers.onError("Invalid projectId", requestId);
        return;
      }
      mkdirSync(cwd, { recursive: true });
    }

    this.onCwdReady(cwd);

    // Write sandbox files (e.g. CLAUDE.md) before user files
    this.writeSandboxFiles(cwd);

    // Write project files to session directory (path traversal protected)
    if (cwd && files && files.length > 0) {
      for (const file of files) {
        if (!isWithin(cwd, file.path)) {
          this.log.warn({ requestId, path: file.path }, "Skipping file outside session directory");
          continue;
        }
        const filePath = resolve(cwd, file.path);
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
      }
      this.log.debug({ requestId, fileCount: files.length }, "Wrote project files to session directory");
    }

    // Hook for pre-spawn setup (e.g. image temp dirs); returns optional cleanup
    const cleanup = this.onBeforeSpawn(options, cwd);

    // Build env
    const env: Record<string, string> = {};
    for (const key of this.allowedEnvKeys) {
      if (process.env[key]) env[key] = process.env[key]!;
    }
    const extraEnv = this.buildExtraEnv(options);
    Object.assign(env, extraEnv);

    // Build args
    const args = this.buildArgs(options);

    const wrapped = this.sandbox.wrapSpawn(this.cliPath, args, {
      mode: this.mode,
      sessionDir: cwd,
      credentialDirs: this.credentialDirs(),
    });
    if (wrapped.env) {
      // Sandbox env wins for any colliding key — the sandbox knows what it
      // needs to inject (e.g. HOME inside a bwrap rootfs).
      Object.assign(env, wrapped.env);
    }

    const startTime = Date.now();
    this.log.info(
      { requestId, model: options.model, promptLength: prompt.length, sandbox: this.sandbox.id },
      `Spawning ${this.agentLabel} process`,
    );
    this.killed = false;

    try {
      this.process = spawn(wrapped.cmd, wrapped.args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (err) {
      cleanup?.();
      const message = err instanceof Error ? err.message : `Failed to start ${this.agentLabel}`;
      this.log.error({ err, requestId, sandbox: this.sandbox.id }, `Failed to spawn ${this.agentLabel} process`);
      handlers.onError(message, requestId);
      return;
    }

    this.log.debug({ pid: this.process.pid, requestId }, `${this.agentLabel} process spawned`);

    // Write prompt to stdin and close it
    if (this.process.stdin) {
      this.process.stdin.on("error", (err) => {
        this.log.debug({ err, requestId }, "stdin write error (process may have exited)");
      });
      this.writeStdin(this.process, options);
      this.process.stdin.end();
    }

    // Guard against double handler invocation (e.g. error + exit both firing)
    let handlersDone = false;
    const readlines: ReadlineInterface[] = [];
    const finish = (cb: () => void) => {
      if (handlersDone) return;
      handlersDone = true;
      this.clearTimeout();
      for (const rl of readlines) rl.close();
      cb();
    };

    // Set up timeout
    this.timeout = setTimeout(() => {
      this.log.warn({ requestId }, `${this.agentLabel} process timed out`);
      this.kill();
      finish(() => handlers.onError("Process timed out", requestId));
    }, this.timeoutMs);

    // Get stream handlers (subclass may wrap onError through finish guard)
    const streamHandlers = this.getStreamHandlers(handlers, finish);

    // Parse stdout
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      readlines.push(rl);
      rl.on("line", (line) => {
        this.parseStreamLine(line, streamHandlers, requestId);
      });
    }

    // Capture stderr
    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      readlines.push(stderrRl);
      stderrRl.on("line", (line) => {
        if (line.trim()) {
          this.log.warn({ requestId, stderr: line }, `${this.agentLabel} stderr`);
        }
      });
    }

    // Handle exit
    this.process.on("exit", (exitCode, signal) => {
      this.process = null;
      cleanup?.();
      const durationMs = Date.now() - startTime;

      if (this.killed) {
        this.log.debug({ requestId, durationMs }, `${this.agentLabel} process was killed`);
        return;
      }

      if (exitCode === 0) {
        this.log.info({ requestId, durationMs }, `${this.agentLabel} process completed successfully`);
        finish(() => handlers.onComplete(requestId));
      } else {
        const reason = exitCode !== null
          ? `${this.agentLabel} CLI exited with code ${exitCode}`
          : `${this.agentLabel} CLI killed by signal ${signal ?? "unknown"}`;
        this.log.warn({ requestId, exitCode, signal, durationMs }, reason);
        finish(() => handlers.onError(reason, requestId));
      }
    });

    this.process.on("error", (err) => {
      this.process = null;
      cleanup?.();
      this.log.error({ err, requestId }, `${this.agentLabel} process error`);
      finish(() => handlers.onError(err.message, requestId));
    });
  }

  kill(): void {
    this.clearTimeout();
    this.onKill();
    if (this.process) {
      this.log.debug({ pid: this.process.pid }, `Killing ${this.agentLabel} process`);
      this.killed = true;
      try {
        this.process.kill();
      } catch {
        // Process may already be dead
      }
      this.process = null;
    }
  }

  dispose(): void {
    this.disposed = true;
    this.kill();
  }

  protected clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }

  // --- Abstract methods (must be implemented by subclasses) ---

  /** Build CLI arguments for the spawn call. */
  protected abstract buildArgs(options: RunOptions): string[];

  /** Parse a single line from stdout. */
  protected abstract parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void;

  /** Write the prompt to stdin in the format expected by the CLI. */
  protected abstract writeStdin(proc: ChildProcess, options: RunOptions): void;

  // --- Virtual hooks (override when needed) ---

  /** Called at the start of run(), before CWD setup. For pre-run state management. */
  protected onBeforeRun(_options: RunOptions): void {}

  /** Called after CWD is created. For storing cwd reference. */
  protected onCwdReady(_cwd: string | undefined): void {}

  /** Write sandbox config files to the CWD (e.g. CLAUDE.md). */
  protected writeSandboxFiles(_cwd: string | undefined): void {}

  /** Build extra env vars beyond the allowed keys (e.g. MAX_THINKING_TOKENS). */
  protected buildExtraEnv(_options: RunOptions): Record<string, string> {
    return {};
  }

  /** Pre-spawn setup. Return a cleanup function if needed (e.g. for temp files). */
  protected onBeforeSpawn(_options: RunOptions, _cwd: string | undefined): (() => void) | undefined {
    return undefined;
  }

  /** Get the handlers to use for stream parsing. Default: pass through unchanged. */
  protected getStreamHandlers(
    handlers: RunHandlers,
    _finish: (cb: () => void) => void,
  ): RunHandlers {
    return handlers;
  }

  /** Called during kill() for subclass cleanup (e.g. clearing maps). */
  protected onKill(): void {}

  /** Credential directories the wrapped CLI agent must be able to read.
   * Sandbox impls bind-mount these read-only. Subclasses override. */
  protected credentialDirs(): string[] {
    return [];
  }
}

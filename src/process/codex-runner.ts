import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { Logger } from "../utils/logger.js";
import type { Runner, RunOptions, RunHandlers } from "./claude-runner.js";

export interface CodexRunnerOptions {
  codexPath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;

export class CodexRunner implements Runner {
  private process: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;
  private killed = false;
  private threadId: string | null = null;
  private readonly codexPath: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly sessionDir: string;

  constructor(options: CodexRunnerOptions) {
    this.codexPath = options.codexPath ?? "codex";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.logger;
    this.sessionDir = options.sessionDir ?? "agent-ws-sessions";
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

    const { prompt, model, systemPrompt, projectId, requestId } = options;

    // Build the full prompt: prepend system prompt since Codex doesn't have
    // a dedicated --append-system-prompt flag
    let fullPrompt = prompt;
    if (systemPrompt) {
      fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
    }

    // Resume existing thread if we have one and a projectId is set (session scoping)
    const resuming = projectId && this.threadId;
    const args: string[] = resuming
      ? ["exec", "resume", this.threadId!, "--json", "--full-auto", "--skip-git-repo-check"]
      : ["exec", "--json", "--full-auto", "--skip-git-repo-check"];
    if (model && !resuming) {
      args.push("--model", model);
    }
    // Read prompt from stdin
    args.push("-");

    this.log.info({ requestId, model, promptLength: prompt.length }, "Spawning Codex process");
    this.killed = false;

    let cwd: string | undefined;
    if (projectId) {
      const base = resolve(tmpdir(), this.sessionDir);
      cwd = resolve(base, projectId);
      if (!cwd.startsWith(base + "/") && cwd !== base) {
        handlers.onError("Invalid projectId", requestId);
        return;
      }
      mkdirSync(cwd, { recursive: true });
    }

    const ALLOWED_ENV_KEYS = [
      "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
      "OPENAI_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
    ];
    const env: Record<string, string> = {};
    for (const key of ALLOWED_ENV_KEYS) {
      if (process.env[key]) env[key] = process.env[key]!;
    }

    try {
      this.process = spawn(this.codexPath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Codex";
      this.log.error({ err, requestId }, "Failed to spawn Codex process");
      handlers.onError(message, requestId);
      return;
    }

    this.log.debug({ pid: this.process.pid, requestId }, "Codex process spawned");

    if (this.process.stdin) {
      this.process.stdin.write(fullPrompt);
      this.process.stdin.end();
    }

    // Guard against double handler invocation (e.g. error + exit both firing)
    let handlersDone = false;
    const finish = (cb: () => void) => {
      if (handlersDone) return;
      handlersDone = true;
      this.clearTimeout();
      cb();
    };

    this.timeout = setTimeout(() => {
      this.log.warn({ requestId }, "Codex process timed out");
      this.kill();
      finish(() => handlers.onError("Process timed out", requestId));
    }, this.timeoutMs);

    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on("line", (line) => {
        this.parseStreamLine(line, handlers, requestId);
      });
    }

    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      stderrRl.on("line", (line) => {
        if (line.trim()) {
          this.log.warn({ requestId, stderr: line }, "Codex stderr");
        }
      });
    }

    this.process.on("exit", (exitCode, signal) => {
      this.process = null;

      if (this.killed) {
        this.log.debug({ requestId }, "Codex process was killed");
        return;
      }

      if (exitCode === 0) {
        this.log.info({ requestId }, "Codex process completed successfully");
        finish(() => handlers.onComplete(requestId));
      } else {
        const reason = exitCode !== null
          ? `Codex CLI exited with code ${exitCode}`
          : `Codex CLI killed by signal ${signal ?? "unknown"}`;
        this.log.warn({ requestId, exitCode, signal }, reason);
        finish(() => handlers.onError(reason, requestId));
      }
    });

    this.process.on("error", (err) => {
      this.process = null;
      this.log.error({ err, requestId }, "Codex process error");
      finish(() => handlers.onError(err.message, requestId));
    });
  }

  /**
   * Parse JSONL output from `codex exec --json`.
   *
   * Event format (one JSON object per line):
   *   { type: "thread.started", thread_id }
   *   { type: "turn.started" }
   *   { type: "item.started", item: { id, type, ... } }
   *   { type: "item.completed", item: { id, type: "agent_message", text } }
   *   { type: "item.completed", item: { id, type: "command_execution", command, exit_code } }
   *   { type: "turn.completed", usage: { input_tokens, output_tokens, ... } }
   */
  private parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);

      // Capture thread_id for session resumption
      if (event.type === "thread.started" && event.thread_id) {
        this.threadId = event.thread_id;
        this.log.debug({ threadId: this.threadId, requestId }, "Captured Codex thread ID");
        return;
      }

      // Agent message — the actual text content we want to stream
      if (event.type === "item.completed" && event.item?.type === "agent_message" && event.item.text) {
        handlers.onChunk(event.item.text, requestId);
        return;
      }

      // Reasoning trace — forward as thinking
      if (event.type === "item.completed" && event.item?.type === "reasoning" && event.item.text) {
        handlers.onChunk(event.item.text, requestId, true);
        return;
      }

      // Turn failed — surface as error
      if (event.type === "turn.failed") {
        const msg = event.error?.message || event.message || "Codex turn failed";
        handlers.onError(msg, requestId);
        return;
      }

      // error event
      if (event.type === "error") {
        const msg = event.message || event.error?.message || "Codex error";
        handlers.onError(msg, requestId);
        return;
      }
    } catch {
      // Non-JSON line, skip
    }
  }

  kill(): void {
    this.clearTimeout();
    if (this.process) {
      this.log.debug({ pid: this.process.pid }, "Killing Codex process");
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

  private clearTimeout(): void {
    if (this.timeout) {
      clearTimeout(this.timeout);
      this.timeout = null;
    }
  }
}

import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync, unlinkSync } from "node:fs";
import { resolve, join, dirname, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { Logger } from "../utils/logger.js";
import type { Runner, RunOptions, RunHandlers } from "./claude-runner.js";
import type { PermissionMode } from "../server/protocol.js";

export interface CodexRunnerOptions {
  codexPath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
  mode?: PermissionMode;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for multi-turn work

const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "OPENAI_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
];

export function buildCodexArgs(mode: PermissionMode, options: {
  resuming: boolean;
  threadId?: string;
  model?: string;
  imagePaths: string[];
}): string[] {
  const args: string[] = options.resuming && options.threadId
    ? ["exec", "resume", options.threadId, "--json", "--skip-git-repo-check"]
    : ["exec", "--json", "--skip-git-repo-check"];

  if (mode === "unrestricted") {
    args.push("--sandbox", "danger-full-access", "--ask-for-approval", "never");
  } else {
    args.push("--full-auto");
  }

  if (options.model && !options.resuming) {
    args.push("--model", options.model);
  }
  for (const imgPath of options.imagePaths) {
    args.push("-i", imgPath);
  }
  args.push("-");

  return args;
}

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
  private readonly mode: PermissionMode;

  constructor(options: CodexRunnerOptions) {
    this.codexPath = options.codexPath ?? "codex";
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.log = options.logger;
    this.sessionDir = options.sessionDir ?? "agent-ws-sessions";
    this.mode = options.mode ?? "safe";
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

    // Note: thinkingTokens is intentionally not used — Codex does not support thinking tokens
    const { prompt, model, systemPrompt, projectId, requestId, images } = options;

    // Build the full prompt: prepend system prompt since Codex doesn't have
    // a dedicated --append-system-prompt flag
    let fullPrompt = prompt;
    if (systemPrompt) {
      fullPrompt = `${systemPrompt}\n\n---\n\n${prompt}`;
    }

    // Write images to temp files for the -i flag
    const imagePaths: string[] = [];
    if (images && images.length > 0) {
      const imgDir = resolve(tmpdir(), "agent-ws-images");
      mkdirSync(imgDir, { recursive: true });
      // Sanitize requestId for safe use in filenames (strip anything that isn't alphanumeric/hyphen/underscore)
      const safeId = requestId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 64);
      for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const rawExt = img.media_type.split("/")[1] || "png";
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "png";
        const imgPath = join(imgDir, `${safeId}-${i}.${ext}`);
        writeFileSync(imgPath, Buffer.from(img.data, "base64"));
        imagePaths.push(imgPath);
      }
    }

    // Resume existing thread if we have one and a projectId is set (session scoping)
    const resuming = !!(projectId && this.threadId);
    const args = buildCodexArgs(this.mode, {
      resuming,
      threadId: this.threadId ?? undefined,
      model,
      imagePaths,
    });

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

    // Write project files to session directory
    if (cwd && options.files && options.files.length > 0) {
      for (const file of options.files) {
        const filePath = normalize(resolve(cwd, file.path));
        if (!filePath.startsWith(cwd + "/") && filePath !== cwd) {
          this.log.warn({ requestId, path: file.path }, "Skipping file outside session directory");
          continue;
        }
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
      }
      this.log.debug({ requestId, fileCount: options.files.length }, "Wrote project files to session directory");
    }

    const cleanupImages = () => {
      for (const p of imagePaths) {
        try { unlinkSync(p); } catch { /* already cleaned */ }
      }
    };

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
      cleanupImages();
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
      cleanupImages();

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
      cleanupImages();
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

      // File change event — forward to UI
      if (event.type === "item.completed" && event.item?.type === "file_change") {
        handlers.onFileChange?.({
          path: event.item.path || event.item.filename || "",
          changeType: event.item.change_type || "update",
          content: event.item.content,
        }, requestId);
        return;
      }

      // Command execution — forward as tool event
      if (event.type === "item.completed" && event.item?.type === "command_execution") {
        handlers.onToolEvent?.({
          event: "start",
          toolName: "command",
          toolId: event.item.id,
          input: { command: event.item.command },
        }, requestId);
        handlers.onToolEvent?.({
          event: "complete",
          toolId: event.item.id,
        }, requestId);
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

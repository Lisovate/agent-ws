import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { Logger } from "../utils/logger.js";

export interface RunOptions {
  prompt: string;
  model?: string;
  systemPrompt?: string;
  projectId?: string;
  requestId: string;
}

export interface RunHandlers {
  onChunk: (content: string, requestId: string) => void;
  onComplete: (requestId: string) => void;
  onError: (message: string, requestId: string) => void;
}

/** Interface for runner injection (testing) */
export interface Runner {
  run(options: RunOptions, handlers: RunHandlers): void;
  kill(): void;
  dispose(): void;
}

export interface ClaudeRunnerOptions {
  claudePath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
}

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

export class ClaudeRunner implements Runner {
  private process: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;
  private killed = false;
  private readonly claudePath: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly sessionDir: string;

  constructor(options: ClaudeRunnerOptions) {
    this.claudePath = options.claudePath ?? "claude";
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

    // Kill any existing process first
    this.kill();

    const { prompt, model, systemPrompt, projectId, requestId } = options;

    const args = [
      "--print", "--verbose", "--continue",
      "--output-format", "stream-json",
      "--max-turns", "1",  // Single-turn text output, no agentic loops
      "--tools", "",       // Disable tool use — we only want generated text
    ];
    if (model) {
      args.push("--model", model);
    }
    if (systemPrompt) {
      args.push("--append-system-prompt", systemPrompt);
    }
    // Prompt is piped via stdin (no arg length limits, no flag-parsing issues)
    args.push("-");

    this.log.info({ requestId, model, promptLength: prompt.length }, "Spawning Claude process");
    this.killed = false;

    // Use project-scoped CWD so --continue resumes the correct session
    // (Claude CLI scopes sessions by working directory)
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

    try {
      const ALLOWED_ENV_KEYS = [
        "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
        "ANTHROPIC_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
      ];
      const env: Record<string, string> = { MAX_THINKING_TOKENS: "2048" };
      for (const key of ALLOWED_ENV_KEYS) {
        if (process.env[key]) env[key] = process.env[key]!;
      }

      this.process = spawn(this.claudePath, args, {
        stdio: ["pipe", "pipe", "pipe"],
        cwd,
        env,
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Failed to start Claude";
      this.log.error({ err, requestId }, "Failed to spawn Claude process");
      handlers.onError(message, requestId);
      return;
    }

    this.log.debug({ pid: this.process.pid, requestId }, "Claude process spawned");

    // Write prompt to stdin and close it
    if (this.process.stdin) {
      this.process.stdin.write(prompt);
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

    // Set up timeout
    this.timeout = setTimeout(() => {
      this.log.warn({ requestId }, "Claude process timed out");
      this.kill();
      finish(() => handlers.onError("Process timed out", requestId));
    }, this.timeoutMs);

    // Parse NDJSON from stdout
    if (this.process.stdout) {
      const rl = createInterface({ input: this.process.stdout });
      rl.on("line", (line) => {
        this.parseStreamLine(line, handlers, requestId);
      });
    }

    // Capture stderr — logs at warn level so errors are visible
    if (this.process.stderr) {
      const stderrRl = createInterface({ input: this.process.stderr });
      stderrRl.on("line", (line) => {
        if (line.trim()) {
          this.log.warn({ requestId, stderr: line }, "Claude stderr");
        }
      });
    }

    // Handle exit
    this.process.on("exit", (exitCode, signal) => {
      this.process = null;

      if (this.killed) {
        this.log.debug({ requestId }, "Claude process was killed");
        return;
      }

      if (exitCode === 0) {
        this.log.info({ requestId }, "Claude process completed successfully");
        finish(() => handlers.onComplete(requestId));
      } else {
        const reason = exitCode !== null
          ? `Claude CLI exited with code ${exitCode}`
          : `Claude CLI killed by signal ${signal ?? "unknown"}`;
        this.log.warn({ requestId, exitCode, signal }, reason);
        finish(() => handlers.onError(reason, requestId));
      }
    });

    this.process.on("error", (err) => {
      this.process = null;
      this.log.error({ err, requestId }, "Claude process error");
      finish(() => handlers.onError(err.message, requestId));
    });
  }

  /**
   * Parse a single NDJSON line from Claude CLI's stream-json output.
   *
   * The stream-json format can emit several event types. We look for text
   * content in these known patterns (in priority order):
   *
   * 1. Raw Anthropic API event: { type: "content_block_delta", delta: { type: "text_delta", text } }
   * 2. Wrapped stream event:    { type: "stream_event", event: { type: "content_block_delta", ... } }
   * 3. Complete assistant msg:   { type: "assistant", message: { content: [{ type: "text", text }] } }
   */
  private parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);

      // Pattern 1: Raw content_block_delta
      if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
        handlers.onChunk(event.delta.text, requestId);
        return;
      }

      // Pattern 2: Wrapped in stream_event
      if (event.type === "stream_event" && event.event) {
        const inner = event.event;
        if (inner.type === "content_block_delta" && inner.delta?.type === "text_delta" && inner.delta.text) {
          handlers.onChunk(inner.delta.text, requestId);
        }
        return;
      }

      // Pattern 3: Complete assistant message
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            handlers.onChunk(block.text, requestId);
          }
        }
        return;
      }

      // Result event — ignore (we already streamed the content)
      if (event.type === "result") {
        return;
      }
    } catch {
      // Non-JSON line, skip
    }
  }

  kill(): void {
    this.clearTimeout();
    if (this.process) {
      this.log.debug({ pid: this.process.pid }, "Killing Claude process");
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

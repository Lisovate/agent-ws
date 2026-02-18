import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve, dirname, normalize } from "node:path";
import { tmpdir } from "node:os";
import { createInterface } from "node:readline";
import type { Logger } from "../utils/logger.js";
import type { PromptImage, PromptFile, PermissionMode } from "../server/protocol.js";

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

export interface ClaudeRunnerOptions {
  claudePath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
  mode?: PermissionMode;
}

const DEFAULT_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes for multi-turn work

const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "ANTHROPIC_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
];

export function buildClaudeArgs(mode: PermissionMode, options: {
  hasImages: boolean;
  projectId?: string;
  model?: string;
  systemPrompt?: string;
}): string[] {
  const args = [
    "--print",
    "--verbose",
    "--output-format", "stream-json",
  ];

  switch (mode) {
    case "safe":
      args.push("--max-turns", "1", "--tools", "");
      break;
    case "agentic":
      args.push("--permission-mode", "dontAsk", "--allowedTools", "Read,Write,Edit,Glob,Grep");
      break;
    case "unrestricted":
      args.push("--dangerously-skip-permissions");
      break;
  }

  if (options.hasImages) {
    args.push("--input-format", "stream-json");
  }
  if (options.projectId) {
    args.push("--continue");
  }
  if (options.model) {
    args.push("--model", options.model);
  }
  if (options.systemPrompt) {
    args.push("--system-prompt", options.systemPrompt);
  }
  args.push("-");

  return args;
}

export class ClaudeRunner implements Runner {
  private process: ChildProcess | null = null;
  private timeout: NodeJS.Timeout | null = null;
  private disposed = false;
  private killed = false;
  private readonly claudePath: string;
  private readonly timeoutMs: number;
  private readonly log: Logger;
  private readonly sessionDir: string;
  private readonly mode: PermissionMode;

  constructor(options: ClaudeRunnerOptions) {
    this.claudePath = options.claudePath ?? "claude";
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

    // Kill any existing process first
    this.kill();

    const { prompt, model, systemPrompt, projectId, requestId, thinkingTokens, images, files } = options;
    const hasImages = !!(images && images.length > 0);

    const args = buildClaudeArgs(this.mode, { hasImages, projectId, model, systemPrompt });

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

    // Write project files to session directory so Claude can read/edit them
    if (cwd && files && files.length > 0) {
      for (const file of files) {
        const filePath = normalize(resolve(cwd, file.path));
        // Validate path stays within cwd (prevent path traversal)
        if (!filePath.startsWith(cwd + "/") && filePath !== cwd) {
          this.log.warn({ requestId, path: file.path }, "Skipping file outside session directory");
          continue;
        }
        mkdirSync(dirname(filePath), { recursive: true });
        writeFileSync(filePath, file.content, "utf-8");
      }
      this.log.debug({ requestId, fileCount: files.length }, "Wrote project files to session directory");
    }

    try {
      const env: Record<string, string> = {};
      if (thinkingTokens !== undefined) {
        env["MAX_THINKING_TOKENS"] = String(thinkingTokens);
      }
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
      if (hasImages) {
        // stream-json input: structured message with image content blocks
        const content: Array<Record<string, unknown>> = [];
        for (const img of images!) {
          content.push({
            type: "image",
            source: { type: "base64", media_type: img.media_type, data: img.data },
          });
        }
        content.push({ type: "text", text: prompt });
        const msg = JSON.stringify({ type: "user", message: { role: "user", content } });
        this.process.stdin.write(msg + "\n");
      } else {
        this.process.stdin.write(prompt);
      }
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
   * The stream-json format can emit several event types. We look for content
   * in these known patterns (in priority order):
   *
   * 1. Raw Anthropic API event: { type: "content_block_delta", delta: { type: "text_delta"|"thinking_delta", text|thinking } }
   * 2. Raw content_block_start with tool_use → emit tool event start
   * 3. Raw content_block_stop → emit tool event complete
   * 4. Wrapped stream event:    { type: "stream_event", event: { ... } }
   * 5. Complete assistant msg:   { type: "assistant", message: { content: [{ type: "text"|"thinking"|"tool_use", ... }] } }
   */
  private parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    if (!line.trim()) return;

    try {
      const event = JSON.parse(line);

      // Pattern 1: Raw content_block_delta
      if (event.type === "content_block_delta") {
        if (event.delta?.type === "text_delta" && event.delta.text) {
          handlers.onChunk(event.delta.text, requestId);
        } else if (event.delta?.type === "thinking_delta" && event.delta.thinking) {
          handlers.onChunk(event.delta.thinking, requestId, true);
        }
        return;
      }

      // Pattern 2: Raw content_block_start with tool_use
      if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
        handlers.onToolEvent?.({
          event: "start",
          toolName: event.content_block.name,
          toolId: event.content_block.id,
        }, requestId);
        return;
      }

      // Pattern 3: Raw content_block_stop
      if (event.type === "content_block_stop") {
        // Only emit if we have a tool_use block ending (toolId from index tracking)
        // The stop event doesn't carry the block type, so emit generically
        handlers.onToolEvent?.({
          event: "complete",
          toolId: event.content_block?.id,
        }, requestId);
        return;
      }

      // Pattern 4: Wrapped in stream_event
      if (event.type === "stream_event" && event.event) {
        const inner = event.event;
        if (inner.type === "content_block_delta") {
          if (inner.delta?.type === "text_delta" && inner.delta.text) {
            handlers.onChunk(inner.delta.text, requestId);
          } else if (inner.delta?.type === "thinking_delta" && inner.delta.thinking) {
            handlers.onChunk(inner.delta.thinking, requestId, true);
          }
        } else if (inner.type === "content_block_start" && inner.content_block?.type === "tool_use") {
          handlers.onToolEvent?.({
            event: "start",
            toolName: inner.content_block.name,
            toolId: inner.content_block.id,
          }, requestId);
        } else if (inner.type === "content_block_stop") {
          handlers.onToolEvent?.({
            event: "complete",
            toolId: inner.content_block?.id,
          }, requestId);
        }
        return;
      }

      // Pattern 5: Complete assistant message
      if (event.type === "assistant" && Array.isArray(event.message?.content)) {
        for (const block of event.message.content) {
          if (block.type === "text" && block.text) {
            handlers.onChunk(block.text, requestId);
          } else if (block.type === "thinking" && block.thinking) {
            handlers.onChunk(block.thinking, requestId, true);
          } else if (block.type === "tool_use") {
            handlers.onToolEvent?.({
              event: "start",
              toolName: block.name,
              toolId: block.id,
              input: block.input as Record<string, unknown> | undefined,
            }, requestId);
            handlers.onToolEvent?.({
              event: "complete",
              toolId: block.id,
            }, requestId);
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

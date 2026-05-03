import type { ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { Logger } from "../utils/logger.js";
import type { PermissionMode } from "../server/protocol.js";
import {
  BaseRunner,
  type RunOptions,
  type RunHandlers,
} from "./base-runner.js";

export interface CodexRunnerOptions {
  codexPath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
  mode?: PermissionMode;
}

const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "OPENAI_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
] as const;

const SANDBOX_INSTRUCTIONS = [
  "IMPORTANT: You are working in a sandboxed project directory.",
  "All file operations MUST use relative paths within the current working directory.",
  "NEVER use absolute paths starting with /.",
  "Example: use 'src/App.tsx', NOT '/Users/.../src/App.tsx'.",
].join(" ");

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

export class CodexRunner extends BaseRunner {
  private threadId: string | null = null;
  private lastProjectId: string | undefined;
  private imagePaths: string[] = [];
  private imgDir: string | null = null;

  constructor(options: CodexRunnerOptions) {
    super({
      cliPath: options.codexPath ?? "codex",
      defaultCliPath: "codex",
      timeoutMs: options.timeoutMs,
      logger: options.logger,
      sessionDir: options.sessionDir,
      mode: options.mode,
      agentLabel: "Codex",
      allowedEnvKeys: ALLOWED_ENV_KEYS,
    });
  }

  protected onBeforeRun(options: RunOptions): void {
    // Clear threadId when projectId changes (sessions are scoped per project)
    if (options.projectId !== this.lastProjectId) {
      this.threadId = null;
      this.lastProjectId = options.projectId;
    }
  }

  protected onBeforeSpawn(options: RunOptions, _cwd: string | undefined): (() => void) | undefined {
    // Write images to temp files for the -i flag (unique dir per request)
    this.imagePaths = [];
    this.imgDir = null;
    const images = options.images;
    if (images && images.length > 0) {
      this.imgDir = mkdtempSync(join(tmpdir(), "agent-ws-img-"));
      for (let i = 0; i < images.length; i++) {
        const img = images[i]!;
        const rawExt = img.media_type.split("/")[1] || "png";
        const ext = rawExt.replace(/[^a-zA-Z0-9]/g, "").slice(0, 10) || "png";
        const imgPath = join(this.imgDir, `${i}.${ext}`);
        writeFileSync(imgPath, Buffer.from(img.data, "base64"));
        this.imagePaths.push(imgPath);
      }
    }

    const imgDir = this.imgDir;
    return () => {
      if (imgDir) {
        try { rmSync(imgDir, { recursive: true, force: true }); } catch { /* already cleaned */ }
      }
    };
  }

  protected buildArgs(options: RunOptions): string[] {
    const resuming = !!(options.projectId && this.threadId);
    return buildCodexArgs(this.mode, {
      resuming,
      threadId: this.threadId ?? undefined,
      model: options.model,
      imagePaths: this.imagePaths,
    });
  }

  protected writeStdin(proc: ChildProcess, options: RunOptions): void {
    // Build the full prompt: prepend system prompt and sandbox instructions
    // since Codex doesn't have a dedicated --append-system-prompt flag
    const parts: string[] = [];
    if (this.mode === "agentic" || this.mode === "unrestricted") {
      parts.push(SANDBOX_INSTRUCTIONS);
    }
    if (this.lastSystemPrompt) {
      parts.push(this.lastSystemPrompt);
    }
    let fullPrompt = options.prompt;
    if (parts.length > 0) {
      fullPrompt = `${parts.join("\n\n")}\n\n---\n\n${options.prompt}`;
    }
    proc.stdin!.write(fullPrompt);
  }

  protected getStreamHandlers(
    handlers: RunHandlers,
    finish: (cb: () => void) => void,
  ): RunHandlers {
    // Wrap onError so stream-level errors (turn.failed, error) go through
    // the finish guard — prevents double error when exit also fires
    return {
      ...handlers,
      onError: (msg, rid) => finish(() => handlers.onError(msg, rid)),
    };
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
  protected parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
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
        const filePath = event.item.path || event.item.filename || "";
        if (!filePath) {
          this.log.warn({ requestId }, "Codex file_change event missing path and filename");
        }
        handlers.onFileChange?.({
          path: filePath,
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
}

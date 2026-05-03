import type { ChildProcess } from "node:child_process";
import { readFile, realpath } from "node:fs/promises";
import { resolve } from "node:path";
import { writeFileSync } from "node:fs";
import type { Logger } from "../utils/logger.js";
import type { PermissionMode } from "../server/protocol.js";
import {
  BaseRunner,
  isWithin,
  type RunOptions,
  type RunHandlers,
} from "./base-runner.js";
import { ClaudeStreamParser } from "./claude-stream-parser.js";

export interface ClaudeRunnerOptions {
  claudePath?: string;
  timeoutMs?: number;
  logger: Logger;
  sessionDir?: string;
  mode?: PermissionMode;
}

const ALLOWED_ENV_KEYS = [
  "PATH", "HOME", "USER", "SHELL", "TERM", "LANG", "LC_ALL",
  "ANTHROPIC_API_KEY", "NODE_PATH", "XDG_CONFIG_HOME",
] as const;

const SANDBOX_SYSTEM_PROMPT = [
  "IMPORTANT: You are working in a sandboxed project directory.",
  "All file operations (Write, Edit, Read, Glob, Grep) MUST use relative paths within the current working directory.",
  "NEVER use absolute paths starting with /.",
  "Example: use 'src/App.tsx', NOT '/Users/.../src/App.tsx'.",
].join(" ");

const SANDBOX_CLAUDE_MD = [
  "# Project Rules",
  "",
  "CRITICAL: This is a sandboxed workspace. All file operations MUST use relative paths.",
  "",
  "- ALWAYS use relative paths (e.g. `src/App.tsx`)",
  "- NEVER use absolute paths (e.g. `/Users/.../src/App.tsx`)",
  "- All project files are in the current working directory",
  "",
].join("\n");

export function buildClaudeArgs(mode: PermissionMode, options: {
  hasImages: boolean;
  projectId?: string;
  model?: string;
  systemPrompt?: string;
}): string[] {
  const args = ["--print", "--verbose", "--output-format", "stream-json"];

  switch (mode) {
    case "safe":
      args.push("--max-turns", "1", "--tools", "");
      break;
    case "agentic":
      args.push(
        "--permission-mode", "dontAsk",
        "--allowedTools", "Read(**),Write(**),Edit(**),Glob(**),Grep(**)",
      );
      break;
    case "unrestricted":
      args.push("--dangerously-skip-permissions");
      break;
  }

  // Sandbox instructions for modes that allow file tools
  if (mode === "agentic" || mode === "unrestricted") {
    args.push("--append-system-prompt", SANDBOX_SYSTEM_PROMPT);
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
    args.push("--append-system-prompt", options.systemPrompt);
  }
  args.push("-");

  return args;
}

export class ClaudeRunner extends BaseRunner {
  private currentCwd: string | null = null;
  private readonly parser = new ClaudeStreamParser();

  constructor(options: ClaudeRunnerOptions) {
    super({
      cliPath: options.claudePath ?? "claude",
      defaultCliPath: "claude",
      timeoutMs: options.timeoutMs,
      logger: options.logger,
      sessionDir: options.sessionDir,
      mode: options.mode,
      agentLabel: "Claude",
      allowedEnvKeys: ALLOWED_ENV_KEYS,
    });
  }

  protected onBeforeRun(_options: RunOptions): void {
    this.parser.reset();
  }

  protected onCwdReady(cwd: string | undefined): void {
    this.currentCwd = cwd ?? null;
  }

  protected writeSandboxFiles(cwd: string | undefined): void {
    if (cwd && (this.mode === "agentic" || this.mode === "unrestricted")) {
      writeFileSync(resolve(cwd, "CLAUDE.md"), SANDBOX_CLAUDE_MD, "utf-8");
    }
  }

  protected buildExtraEnv(options: RunOptions): Record<string, string> {
    if (options.thinkingTokens === undefined) return {};
    return { MAX_THINKING_TOKENS: String(options.thinkingTokens) };
  }

  protected buildArgs(options: RunOptions): string[] {
    return buildClaudeArgs(this.mode, {
      hasImages: !!(options.images && options.images.length > 0),
      projectId: options.projectId,
      model: options.model,
      systemPrompt: this.lastSystemPrompt,
    });
  }

  protected writeStdin(proc: ChildProcess, options: RunOptions): void {
    const hasImages = !!(options.images && options.images.length > 0);
    if (!hasImages) {
      proc.stdin!.write(options.prompt);
      return;
    }
    const content: Array<Record<string, unknown>> = options.images!.map((img) => ({
      type: "image",
      source: { type: "base64", media_type: img.media_type, data: img.data },
    }));
    content.push({ type: "text", text: options.prompt });
    proc.stdin!.write(JSON.stringify({ type: "user", message: { role: "user", content } }) + "\n");
  }

  protected onKill(): void {
    this.parser.reset();
  }

  protected parseStreamLine(line: string, handlers: RunHandlers, requestId: string): void {
    const cwd = this.currentCwd;
    this.parser.parseLine(line, {
      onChunk: (content, thinking) => handlers.onChunk(content, requestId, thinking),
      onToolEvent: (event) => handlers.onToolEvent?.(event, requestId),
      onFileChange: (change) => handlers.onFileChange?.(change, requestId),
      onEditPath: (filePath) => {
        if (cwd) this.readEditFile(cwd, filePath, handlers, requestId);
      },
    });
  }

  /**
   * Resolve symlinks before reading so a planted symlink can't escape cwd.
   * Fire-and-forget: errors are logged but don't propagate.
   */
  private readEditFile(cwd: string, filePath: string, handlers: RunHandlers, requestId: string): void {
    if (!isWithin(cwd, filePath)) {
      this.log.warn({ requestId, path: filePath }, "Skipping Edit file outside session directory");
      return;
    }
    const fullPath = resolve(cwd, filePath);
    realpath(fullPath)
      .then((realPath) => {
        if (!isWithin(cwd, realPath)) {
          this.log.warn({ requestId, path: filePath, realPath }, "Skipping Edit file: symlink escapes session dir");
          return undefined;
        }
        return readFile(realPath, "utf-8");
      })
      .then((content) => {
        if (content === undefined) return;
        try {
          handlers.onFileChange?.({ path: filePath, changeType: "update", content }, requestId);
        } catch (err) {
          this.log.debug({ requestId, path: filePath, err }, "Error in onFileChange callback");
        }
      })
      .catch((err) => {
        this.log.debug({ requestId, path: filePath, err }, "Failed to read edited file");
      });
  }
}

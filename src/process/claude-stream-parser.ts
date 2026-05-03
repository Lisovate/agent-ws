import type { ToolEventData, FileChangeData } from "./base-runner.js";

interface ActiveToolBlock {
  toolName: string;
  toolId: string;
  inputFragments: string[];
}

export interface StreamHandlers {
  onChunk: (content: string, thinking?: boolean) => void;
  onToolEvent?: (event: ToolEventData) => void;
  onFileChange?: (change: FileChangeData) => void;
  /** Called when an Edit-style tool finishes so the runner can read post-edit content from disk. */
  onEditPath?: (filePath: string) => void;
}

/**
 * Parses Claude CLI's `--output-format stream-json` line by line.
 *
 * The stream emits several event shapes:
 *   1. `content_block_delta` — incremental text/thinking/tool-input
 *   2. `content_block_start` (tool_use) — register a tool block by index
 *   3. `content_block_stop`  — flush accumulated input + emit complete event
 *   4. `stream_event`        — same as 1-3 but wrapped one level deeper
 *   5. `assistant`           — a complete assistant message with all blocks
 */
export class ClaudeStreamParser {
  private activeBlocks = new Map<number, ActiveToolBlock>();

  reset(): void {
    this.activeBlocks.clear();
  }

  parseLine(line: string, h: StreamHandlers): void {
    if (!line.trim()) return;

    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      return;
    }

    if (this.handleStreamEvent(event, h)) return;

    if (event["type"] === "stream_event" && event["event"]) {
      this.handleStreamEvent(event["event"] as Record<string, unknown>, h);
      return;
    }

    if (event["type"] === "assistant") {
      const message = event["message"] as { content?: unknown } | undefined;
      if (Array.isArray(message?.content)) {
        this.handleAssistantContent(message.content, h);
      }
    }
  }

  /** Handle a raw stream event (Patterns 1-3). Returns true if it matched. */
  private handleStreamEvent(event: Record<string, unknown>, h: StreamHandlers): boolean {
    switch (event["type"]) {
      case "content_block_delta":
        this.handleDelta(event, h);
        return true;
      case "content_block_start": {
        const cb = event["content_block"] as Record<string, unknown> | undefined;
        if (cb?.["type"] === "tool_use") {
          this.handleToolStart(event["index"] as number, cb, h);
        }
        return true;
      }
      case "content_block_stop":
        this.handleToolStop(event["index"] as number, h);
        return true;
      default:
        return false;
    }
  }

  private handleDelta(event: Record<string, unknown>, h: StreamHandlers): void {
    const delta = event["delta"] as Record<string, unknown> | undefined;
    if (!delta) return;
    if (delta["type"] === "text_delta" && typeof delta["text"] === "string") {
      h.onChunk(delta["text"]);
    } else if (delta["type"] === "thinking_delta" && typeof delta["thinking"] === "string") {
      h.onChunk(delta["thinking"], true);
    } else if (delta["type"] === "input_json_delta" && typeof delta["partial_json"] === "string") {
      const block = this.activeBlocks.get(event["index"] as number);
      block?.inputFragments.push(delta["partial_json"]);
    }
  }

  private handleToolStart(index: number, cb: Record<string, unknown>, h: StreamHandlers): void {
    const toolName = cb["name"] as string;
    const toolId = cb["id"] as string;
    this.activeBlocks.set(index, { toolName, toolId, inputFragments: [] });
    h.onToolEvent?.({ event: "start", toolName, toolId });
  }

  private handleToolStop(index: number, h: StreamHandlers): void {
    const block = this.activeBlocks.get(index);
    if (!block) {
      // Stray stop — emit a generic complete for backward compat
      h.onToolEvent?.({ event: "complete" });
      return;
    }
    this.activeBlocks.delete(index);

    let input: Record<string, unknown> | undefined;
    if (block.inputFragments.length > 0) {
      try {
        input = JSON.parse(block.inputFragments.join(""));
      } catch {
        // Malformed input — leave undefined
      }
    }

    h.onToolEvent?.({ event: "complete", toolName: block.toolName, toolId: block.toolId, input });
    emitFileChange(block.toolName, input, h);
  }

  private handleAssistantContent(content: unknown[], h: StreamHandlers): void {
    for (const raw of content) {
      const block = raw as Record<string, unknown>;
      if (block["type"] === "text" && typeof block["text"] === "string") {
        if (block["text"]) h.onChunk(block["text"]);
      } else if (block["type"] === "thinking" && typeof block["thinking"] === "string") {
        if (block["thinking"]) h.onChunk(block["thinking"], true);
      } else if (block["type"] === "tool_use") {
        const toolName = block["name"] as string;
        const toolId = block["id"] as string;
        const input = block["input"] as Record<string, unknown> | undefined;
        h.onToolEvent?.({ event: "start", toolName, toolId, input });
        h.onToolEvent?.({ event: "complete", toolName, toolId, input });
        emitFileChange(toolName, input, h);
      }
    }
  }
}

/**
 * Emit a file_change for file-modifying tools.
 * Write → sync emit with content. Edit → sync emit without content + onEditPath signal.
 */
function emitFileChange(
  toolName: string,
  input: Record<string, unknown> | undefined,
  h: StreamHandlers,
): void {
  const filePath = input?.["file_path"];
  if (typeof filePath !== "string") return;

  if (toolName === "Write") {
    h.onFileChange?.({
      path: filePath,
      changeType: "create",
      content: typeof input?.["content"] === "string" ? input["content"] : undefined,
    });
  } else if (toolName === "Edit") {
    h.onFileChange?.({ path: filePath, changeType: "update" });
    h.onEditPath?.(filePath);
  }
}

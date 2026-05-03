import pino from "pino";
import { ClaudeRunner } from "../src/process/claude-runner.js";
import type { RunHandlers, ToolEventData, FileChangeData } from "../src/process/base-runner.js";

const testLogger = pino({ level: "silent" });

function createRunner() {
  return new ClaudeRunner({ logger: testLogger, claudePath: "/nonexistent" });
}

function createHandlers() {
  const chunks: Array<{ content: string; requestId: string; thinking?: boolean }> = [];
  const toolEvents: Array<{ event: ToolEventData; requestId: string }> = [];
  const fileChanges: Array<{ change: FileChangeData; requestId: string }> = [];
  const errors: Array<{ message: string; requestId: string }> = [];

  const handlers: RunHandlers = {
    onChunk: (content, requestId, thinking) => chunks.push({ content, requestId, thinking }),
    onComplete: () => {},
    onError: (message, requestId) => errors.push({ message, requestId }),
    onToolEvent: (event, requestId) => toolEvents.push({ event, requestId }),
    onFileChange: (change, requestId) => fileChanges.push({ change, requestId }),
  };

  return { handlers, chunks, toolEvents, fileChanges, errors };
}

function parse(runner: ClaudeRunner, line: string, handlers: RunHandlers, requestId = "req-1") {
  (runner as any).parseStreamLine(line, handlers, requestId);
}

describe("ClaudeRunner.parseStreamLine", () => {
  describe("input_json_delta accumulation", () => {
    it("accumulates fragments and includes parsed input in content_block_stop", () => {
      const runner = createRunner();
      const { handlers, toolEvents } = createHandlers();

      // content_block_start registers the block
      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_123", name: "Write" },
      }), handlers);

      // input_json_delta fragments
      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"file_' },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: 'path":"src/App.tsx","content":"hello"}' },
      }), handlers);

      // content_block_stop triggers parse + complete event
      parse(runner, JSON.stringify({
        type: "content_block_stop",
        index: 2,
      }), handlers);

      expect(toolEvents).toHaveLength(2); // start + complete
      const complete = toolEvents[1]!;
      expect(complete.event.event).toBe("complete");
      expect(complete.event.toolName).toBe("Write");
      expect(complete.event.toolId).toBe("toolu_123");
      expect(complete.event.input).toEqual({ file_path: "src/App.tsx", content: "hello" });
    });

    it("handles text_delta and input_json_delta on different indices simultaneously", () => {
      const runner = createRunner();
      const { handlers, chunks, toolEvents } = createHandlers();

      // Start a tool block at index 2
      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 2,
        content_block: { type: "tool_use", id: "toolu_a", name: "Read" },
      }), handlers);

      // text_delta at index 0 (text block, no registration needed)
      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "text_delta", text: "Hello" },
      }), handlers);

      // input_json_delta at index 2
      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 2,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"test.ts"}' },
      }), handlers);

      parse(runner, JSON.stringify({ type: "content_block_stop", index: 2 }), handlers);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe("Hello");
      expect(toolEvents[1]!.event.input).toEqual({ file_path: "test.ts" });
    });
  });

  describe("Write tool file_change emission", () => {
    it("emits file_change with content for Write tool", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_w", name: "Write" },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"src/index.ts","content":"export {}"}' },
      }), handlers);

      parse(runner, JSON.stringify({ type: "content_block_stop", index: 0 }), handlers);

      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change).toEqual({
        path: "src/index.ts",
        changeType: "create",
        content: "export {}",
      });
    });
  });

  describe("Edit tool file_change emission", () => {
    it("emits file_change without content for Edit tool", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_e", name: "Edit" },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"src/app.ts","old_string":"foo","new_string":"bar"}' },
      }), handlers);

      parse(runner, JSON.stringify({ type: "content_block_stop", index: 1 }), handlers);

      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change).toEqual({
        path: "src/app.ts",
        changeType: "update",
      });
      expect(fileChanges[0]!.change.content).toBeUndefined();
    });
  });

  describe("multiple concurrent tool blocks", () => {
    it("tracks blocks independently by index", () => {
      const runner = createRunner();
      const { handlers, toolEvents, fileChanges } = createHandlers();

      // Start two tools at different indices
      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 1,
        content_block: { type: "tool_use", id: "toolu_1", name: "Write" },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 3,
        content_block: { type: "tool_use", id: "toolu_2", name: "Edit" },
      }), handlers);

      // Interleaved deltas
      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"a.ts",' },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 3,
        delta: { type: "input_json_delta", partial_json: '{"file_path":"b.ts","old_string":"x","new_string":"y"}' },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 1,
        delta: { type: "input_json_delta", partial_json: '"content":"code"}' },
      }), handlers);

      // Stop in reverse order
      parse(runner, JSON.stringify({ type: "content_block_stop", index: 3 }), handlers);
      parse(runner, JSON.stringify({ type: "content_block_stop", index: 1 }), handlers);

      // 2 starts + 2 completes
      expect(toolEvents).toHaveLength(4);
      expect(toolEvents[2]!.event.toolName).toBe("Edit");
      expect(toolEvents[2]!.event.input).toEqual({ file_path: "b.ts", old_string: "x", new_string: "y" });
      expect(toolEvents[3]!.event.toolName).toBe("Write");
      expect(toolEvents[3]!.event.input).toEqual({ file_path: "a.ts", content: "code" });

      // File changes for both
      expect(fileChanges).toHaveLength(2);
      expect(fileChanges[0]!.change.path).toBe("b.ts");
      expect(fileChanges[0]!.change.changeType).toBe("update");
      expect(fileChanges[1]!.change.path).toBe("a.ts");
      expect(fileChanges[1]!.change.changeType).toBe("create");
      expect(fileChanges[1]!.change.content).toBe("code");
    });
  });

  describe("malformed JSON handling", () => {
    it("leaves input undefined when accumulated JSON is invalid", () => {
      const runner = createRunner();
      const { handlers, toolEvents } = createHandlers();

      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bad", name: "Write" },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"broken' },
      }), handlers);

      parse(runner, JSON.stringify({ type: "content_block_stop", index: 0 }), handlers);

      const complete = toolEvents[1]!;
      expect(complete.event.event).toBe("complete");
      expect(complete.event.toolName).toBe("Write");
      expect(complete.event.input).toBeUndefined();
    });
  });

  describe("content_block_stop without prior start", () => {
    it("emits generic complete with no input", () => {
      const runner = createRunner();
      const { handlers, toolEvents } = createHandlers();

      parse(runner, JSON.stringify({
        type: "content_block_stop",
        index: 99,
      }), handlers);

      expect(toolEvents).toHaveLength(1);
      expect(toolEvents[0]!.event).toEqual({ event: "complete" });
    });
  });

  describe("stream_event wrapper", () => {
    it("handles wrapped content_block_start + delta + stop identically", () => {
      const runner = createRunner();
      const { handlers, toolEvents, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_start",
          index: 0,
          content_block: { type: "tool_use", id: "toolu_wrapped", name: "Write" },
        },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: '{"file_path":"w.ts","content":"wrapped"}' },
        },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "stream_event",
        event: { type: "content_block_stop", index: 0 },
      }), handlers);

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[1]!.event.input).toEqual({ file_path: "w.ts", content: "wrapped" });
      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change).toEqual({
        path: "w.ts",
        changeType: "create",
        content: "wrapped",
      });
    });

    it("handles wrapped text_delta and thinking_delta", () => {
      const runner = createRunner();
      const { handlers, chunks } = createHandlers();

      parse(runner, JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 0,
          delta: { type: "text_delta", text: "hello" },
        },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "stream_event",
        event: {
          type: "content_block_delta",
          index: 1,
          delta: { type: "thinking_delta", thinking: "hmm" },
        },
      }), handlers);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.content).toBe("hello");
      expect(chunks[0]!.thinking).toBeUndefined();
      expect(chunks[1]!.content).toBe("hmm");
      expect(chunks[1]!.thinking).toBe(true);
    });
  });

  describe("Pattern 5: complete assistant message", () => {
    it("includes toolName and input in both start and complete events", () => {
      const runner = createRunner();
      const { handlers, toolEvents } = createHandlers();

      parse(runner, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              id: "toolu_p5",
              input: { file_path: "readme.md" },
            },
          ],
        },
      }), handlers);

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]!.event).toEqual({
        event: "start",
        toolName: "Read",
        toolId: "toolu_p5",
        input: { file_path: "readme.md" },
      });
      expect(toolEvents[1]!.event).toEqual({
        event: "complete",
        toolName: "Read",
        toolId: "toolu_p5",
        input: { file_path: "readme.md" },
      });
    });

    it("handles text and thinking blocks", () => {
      const runner = createRunner();
      const { handlers, chunks } = createHandlers();

      parse(runner, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "let me think" },
            { type: "text", text: "here is my answer" },
          ],
        },
      }), handlers);

      expect(chunks).toHaveLength(2);
      expect(chunks[0]!.thinking).toBe(true);
      expect(chunks[1]!.thinking).toBeUndefined();
    });
  });

  describe("non-file tools", () => {
    it("does not emit file_change for non-file tools like Bash", () => {
      const runner = createRunner();
      const { handlers, toolEvents, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bash", name: "Bash" },
      }), handlers);

      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"command":"ls"}' },
      }), handlers);

      parse(runner, JSON.stringify({ type: "content_block_stop", index: 0 }), handlers);

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[1]!.event.input).toEqual({ command: "ls" });
      expect(fileChanges).toHaveLength(0);
    });
  });

  describe("Pattern 5: Write file_change via complete assistant message", () => {
    it("emits file_change with changeType create and content for Write tool_use", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Write",
              id: "toolu_w5",
              input: { file_path: "src/new-file.ts", content: "const x = 1;" },
            },
          ],
        },
      }), handlers);

      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change).toEqual({
        path: "src/new-file.ts",
        changeType: "create",
        content: "const x = 1;",
      });
    });
  });

  describe("Pattern 5: Edit without cwd", () => {
    it("emits sync file_change without content; skips disk read when currentCwd is null", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      // currentCwd is null by default (no projectId)
      parse(runner, JSON.stringify({
        type: "assistant",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Edit",
              id: "toolu_e5",
              input: { file_path: "src/app.ts", old_string: "a", new_string: "b" },
            },
          ],
        },
      }), handlers);

      // Sync event fires regardless of cwd; the disk-backed follow-up is skipped.
      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change).toEqual({ path: "src/app.ts", changeType: "update" });
    });
  });

  describe("multi-fragment input_json_delta accumulation", () => {
    it("accumulates 6+ small fragments into valid JSON", () => {
      const runner = createRunner();
      const { handlers, toolEvents } = createHandlers();

      parse(runner, JSON.stringify({
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_frag", name: "Write" },
      }), handlers);

      // 6 small fragments
      const fragments = ['{"fi', 'le_', 'path', '":"a', '.ts","co', 'ntent":"hello"}'];
      for (const frag of fragments) {
        parse(runner, JSON.stringify({
          type: "content_block_delta",
          index: 0,
          delta: { type: "input_json_delta", partial_json: frag },
        }), handlers);
      }

      parse(runner, JSON.stringify({ type: "content_block_stop", index: 0 }), handlers);

      const complete = toolEvents[1]!;
      expect(complete.event.input).toEqual({ file_path: "a.ts", content: "hello" });
    });
  });

  describe("edge cases", () => {
    it("skips empty lines", () => {
      const runner = createRunner();
      const { handlers, chunks, toolEvents } = createHandlers();
      parse(runner, "", handlers);
      parse(runner, "   ", handlers);
      expect(chunks).toHaveLength(0);
      expect(toolEvents).toHaveLength(0);
    });

    it("skips non-JSON lines", () => {
      const runner = createRunner();
      const { handlers, chunks } = createHandlers();
      parse(runner, "not json at all", handlers);
      expect(chunks).toHaveLength(0);
    });

    it("ignores input_json_delta for unknown index", () => {
      const runner = createRunner();
      const { handlers } = createHandlers();

      // Delta without prior start — should not throw
      parse(runner, JSON.stringify({
        type: "content_block_delta",
        index: 42,
        delta: { type: "input_json_delta", partial_json: '{"x":1}' },
      }), handlers);
    });

    it("ignores result events", () => {
      const runner = createRunner();
      const { handlers, chunks, toolEvents } = createHandlers();
      parse(runner, JSON.stringify({ type: "result", result: "something" }), handlers);
      expect(chunks).toHaveLength(0);
      expect(toolEvents).toHaveLength(0);
    });
  });
});

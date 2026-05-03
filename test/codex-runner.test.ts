import pino from "pino";
import { CodexRunner } from "../src/process/codex-runner.js";
import type { RunHandlers, ToolEventData, FileChangeData } from "../src/process/base-runner.js";

const testLogger = pino({ level: "silent" });

function createRunner() {
  return new CodexRunner({ logger: testLogger, codexPath: "/nonexistent" });
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

function parse(runner: CodexRunner, line: string, handlers: RunHandlers, requestId = "req-1") {
  (runner as any).parseStreamLine(line, handlers, requestId);
}

describe("CodexRunner.parseStreamLine", () => {
  describe("thread.started", () => {
    it("captures threadId", () => {
      const runner = createRunner();
      const { handlers } = createHandlers();

      parse(runner, JSON.stringify({
        type: "thread.started",
        thread_id: "thread_abc123",
      }), handlers);

      // threadId is private, but we can verify indirectly via buildArgs
      // by checking that a subsequent run with projectId would use resume
      expect((runner as any).threadId).toBe("thread_abc123");
    });
  });

  describe("item.completed with agent_message", () => {
    it("emits chunk with text content", () => {
      const runner = createRunner();
      const { handlers, chunks } = createHandlers();

      parse(runner, JSON.stringify({
        type: "item.completed",
        item: { id: "item_1", type: "agent_message", text: "Hello, world!" },
      }), handlers);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe("Hello, world!");
      expect(chunks[0]!.requestId).toBe("req-1");
      expect(chunks[0]!.thinking).toBeUndefined();
    });
  });

  describe("item.completed with reasoning", () => {
    it("emits thinking chunk", () => {
      const runner = createRunner();
      const { handlers, chunks } = createHandlers();

      parse(runner, JSON.stringify({
        type: "item.completed",
        item: { id: "item_2", type: "reasoning", text: "Let me think about this..." },
      }), handlers);

      expect(chunks).toHaveLength(1);
      expect(chunks[0]!.content).toBe("Let me think about this...");
      expect(chunks[0]!.thinking).toBe(true);
    });
  });

  describe("item.completed with command_execution", () => {
    it("emits tool event start and complete", () => {
      const runner = createRunner();
      const { handlers, toolEvents } = createHandlers();

      parse(runner, JSON.stringify({
        type: "item.completed",
        item: { id: "cmd_1", type: "command_execution", command: "ls -la", exit_code: 0 },
      }), handlers);

      expect(toolEvents).toHaveLength(2);
      expect(toolEvents[0]!.event).toEqual({
        event: "start",
        toolName: "command",
        toolId: "cmd_1",
        input: { command: "ls -la" },
      });
      expect(toolEvents[1]!.event).toEqual({
        event: "complete",
        toolId: "cmd_1",
      });
    });
  });

  describe("item.completed with file_change", () => {
    it("emits file change event with path", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", path: "src/App.tsx", change_type: "create", content: "export {}" },
      }), handlers);

      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change).toEqual({
        path: "src/App.tsx",
        changeType: "create",
        content: "export {}",
      });
    });

    it("falls back to filename when path is missing", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", filename: "index.ts", change_type: "update" },
      }), handlers);

      expect(fileChanges).toHaveLength(1);
      expect(fileChanges[0]!.change.path).toBe("index.ts");
      expect(fileChanges[0]!.change.changeType).toBe("update");
    });

    it("defaults changeType to update when missing", () => {
      const runner = createRunner();
      const { handlers, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({
        type: "item.completed",
        item: { type: "file_change", path: "file.txt" },
      }), handlers);

      expect(fileChanges[0]!.change.changeType).toBe("update");
    });
  });

  describe("turn.failed", () => {
    it("emits error with error.message", () => {
      const runner = createRunner();
      const { handlers, errors } = createHandlers();

      parse(runner, JSON.stringify({
        type: "turn.failed",
        error: { message: "Rate limit exceeded" },
      }), handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Rate limit exceeded");
    });

    it("emits error with fallback message when error.message is missing", () => {
      const runner = createRunner();
      const { handlers, errors } = createHandlers();

      parse(runner, JSON.stringify({
        type: "turn.failed",
        message: "Something went wrong",
      }), handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Something went wrong");
    });

    it("emits default message when no message fields present", () => {
      const runner = createRunner();
      const { handlers, errors } = createHandlers();

      parse(runner, JSON.stringify({ type: "turn.failed" }), handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Codex turn failed");
    });
  });

  describe("error event", () => {
    it("emits error with message", () => {
      const runner = createRunner();
      const { handlers, errors } = createHandlers();

      parse(runner, JSON.stringify({
        type: "error",
        message: "Connection failed",
      }), handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Connection failed");
    });

    it("falls back to error.message", () => {
      const runner = createRunner();
      const { handlers, errors } = createHandlers();

      parse(runner, JSON.stringify({
        type: "error",
        error: { message: "API error" },
      }), handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("API error");
    });

    it("uses default message when no message fields", () => {
      const runner = createRunner();
      const { handlers, errors } = createHandlers();

      parse(runner, JSON.stringify({ type: "error" }), handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Codex error");
    });
  });

  describe("edge cases", () => {
    it("skips empty lines", () => {
      const runner = createRunner();
      const { handlers, chunks, errors } = createHandlers();
      parse(runner, "", handlers);
      parse(runner, "   ", handlers);
      expect(chunks).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it("skips non-JSON lines", () => {
      const runner = createRunner();
      const { handlers, chunks, errors } = createHandlers();
      parse(runner, "not json at all", handlers);
      expect(chunks).toHaveLength(0);
      expect(errors).toHaveLength(0);
    });

    it("silently skips unknown event types", () => {
      const runner = createRunner();
      const { handlers, chunks, errors, toolEvents, fileChanges } = createHandlers();

      parse(runner, JSON.stringify({ type: "turn.started" }), handlers);
      parse(runner, JSON.stringify({ type: "turn.completed", usage: {} }), handlers);
      parse(runner, JSON.stringify({ type: "item.started", item: { id: "x" } }), handlers);

      expect(chunks).toHaveLength(0);
      expect(errors).toHaveLength(0);
      expect(toolEvents).toHaveLength(0);
      expect(fileChanges).toHaveLength(0);
    });
  });

  describe("threadId scoping", () => {
    it("resets threadId when projectId changes", () => {
      const runner = createRunner();
      const { handlers } = createHandlers();

      // Capture a threadId
      parse(runner, JSON.stringify({
        type: "thread.started",
        thread_id: "thread_old",
      }), handlers);
      expect((runner as any).threadId).toBe("thread_old");

      // Simulate onBeforeRun with a new projectId
      (runner as any).lastProjectId = "project-1";
      (runner as any).onBeforeRun({ projectId: "project-2", requestId: "r2", prompt: "hi" });

      expect((runner as any).threadId).toBeNull();
    });
  });
});

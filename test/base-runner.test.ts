import pino from "pino";
import type { ChildProcess } from "node:child_process";
import { existsSync, readFileSync, rmSync } from "node:fs";
import { resolve } from "node:path";
import { tmpdir } from "node:os";
import { BaseRunner, isWithin, type RunOptions, type RunHandlers } from "../src/process/base-runner.js";

const testLogger = pino({ level: "silent" });

/** Minimal concrete subclass that never spawns a real process. */
class TestRunner extends BaseRunner {
  writtenPrompt = "";

  constructor(opts?: { mode?: "safe" | "agentic" | "unrestricted"; sessionDir?: string }) {
    super({
      cliPath: "/nonexistent",
      defaultCliPath: "/nonexistent",
      logger: testLogger,
      agentLabel: "Test",
      allowedEnvKeys: ["PATH"],
      mode: opts?.mode,
      sessionDir: opts?.sessionDir,
    });
  }

  protected buildArgs(_options: RunOptions): string[] {
    return [];
  }

  protected parseStreamLine(_line: string, _handlers: RunHandlers, _requestId: string): void {}

  protected writeStdin(_proc: ChildProcess, options: RunOptions): void {
    this.writtenPrompt = options.prompt;
  }

  // Expose for testing
  getLastSystemPrompt(): string | undefined {
    return this.lastSystemPrompt;
  }

  /** Set systemPrompt cache without running (avoids spawn). */
  simulateRun(options: RunOptions): void {
    if (options.systemPrompt !== undefined) {
      this.lastSystemPrompt = options.systemPrompt;
    }
  }
}

function createHandlers() {
  const errors: Array<{ message: string; requestId: string }> = [];
  const handlers: RunHandlers = {
    onChunk: () => {},
    onComplete: () => {},
    onError: (message, requestId) => errors.push({ message, requestId }),
  };
  return { handlers, errors };
}

describe("BaseRunner", () => {
  describe("system prompt caching", () => {
    it("caches systemPrompt from first prompt", () => {
      const runner = new TestRunner();
      expect(runner.getLastSystemPrompt()).toBeUndefined();

      runner.simulateRun({ prompt: "hi", requestId: "r1", systemPrompt: "Be helpful" });
      expect(runner.getLastSystemPrompt()).toBe("Be helpful");
    });

    it("reuses cached systemPrompt when omitted on follow-up", () => {
      const runner = new TestRunner();

      runner.simulateRun({ prompt: "hi", requestId: "r1", systemPrompt: "Be helpful" });
      expect(runner.getLastSystemPrompt()).toBe("Be helpful");

      runner.simulateRun({ prompt: "hi again", requestId: "r2" });
      expect(runner.getLastSystemPrompt()).toBe("Be helpful");
    });

    it("overwrites cached systemPrompt with new value", () => {
      const runner = new TestRunner();

      runner.simulateRun({ prompt: "hi", requestId: "r1", systemPrompt: "First" });
      expect(runner.getLastSystemPrompt()).toBe("First");

      runner.simulateRun({ prompt: "hi", requestId: "r2", systemPrompt: "Second" });
      expect(runner.getLastSystemPrompt()).toBe("Second");
    });
  });

  describe("disposed runner", () => {
    it("returns error when run() is called on disposed runner", () => {
      const runner = new TestRunner();
      runner.dispose();

      const { handlers, errors } = createHandlers();
      runner.run({ prompt: "hi", requestId: "r1" }, handlers);

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toBe("Runner has been disposed");
    });
  });

  describe("spawn failure", () => {
    it("reports error when CLI path does not exist", async () => {
      const runner = new TestRunner();
      const { handlers, errors } = createHandlers();

      runner.run({ prompt: "hi", requestId: "r1" }, handlers);

      // spawn error fires asynchronously — wait for it
      await new Promise((r) => setTimeout(r, 100));

      expect(errors).toHaveLength(1);
      expect(errors[0]!.message).toMatch(/ENOENT|spawn|Failed/i);

      runner.dispose();
    });
  });

  describe("file uploads", () => {
    const sessionDir = "agent-ws-test-files";
    const projectId = "test-proj";
    const projectPath = resolve(tmpdir(), sessionDir, projectId);

    afterEach(async () => {
      // wait for spawn() exit handler to run before removing the dir
      await new Promise((r) => setTimeout(r, 50));
      rmSync(resolve(tmpdir(), sessionDir), { recursive: true, force: true });
    });

    async function runWithFiles(files: Array<{ path: string; content: string }>) {
      const runner = new TestRunner({ sessionDir });
      const { handlers } = createHandlers();
      runner.run({ prompt: "hi", requestId: "r1", projectId, files }, handlers);
      // Files are written synchronously inside run() before spawn — wait for the
      // ENOENT to surface so vitest doesn't see dangling async work.
      await new Promise((r) => setTimeout(r, 50));
      runner.dispose();
    }

    it("writes files into the session directory", async () => {
      await runWithFiles([
        { path: "a.txt", content: "alpha" },
        { path: "sub/b.txt", content: "beta" },
      ]);
      expect(readFileSync(resolve(projectPath, "a.txt"), "utf-8")).toBe("alpha");
      expect(readFileSync(resolve(projectPath, "sub/b.txt"), "utf-8")).toBe("beta");
    });

    it("rejects path traversal via ../", async () => {
      await runWithFiles([{ path: "../escape.txt", content: "leaked" }]);
      expect(existsSync(resolve(tmpdir(), sessionDir, "escape.txt"))).toBe(false);
    });

    it("rejects absolute paths", async () => {
      await runWithFiles([{ path: "/tmp/agent-ws-absolute-test.txt", content: "leaked" }]);
      expect(existsSync("/tmp/agent-ws-absolute-test.txt")).toBe(false);
    });
  });

  describe("isWithin", () => {
    it("accepts paths inside the parent", () => {
      expect(isWithin("/a/b", "/a/b/c.txt")).toBe(true);
      expect(isWithin("/a/b", "/a/b")).toBe(true);
      expect(isWithin("/a/b", "sub/c.txt")).toBe(true);
    });

    it("rejects paths outside the parent", () => {
      expect(isWithin("/a/b", "/a/c.txt")).toBe(false);
      expect(isWithin("/a/b", "../escape")).toBe(false);
      expect(isWithin("/a/b", "/etc/passwd")).toBe(false);
    });
  });
});

import { WebSocket } from "ws";
import { AgentWebSocketServer } from "../src/server/websocket.js";
import type { Runner, RunOptions, RunHandlers } from "../src/process/base-runner.js";
import pino from "pino";

const testLogger = pino({ level: "silent" });

class MockRunner implements Runner {
  lastHandlers: RunHandlers | null = null;
  lastOptions: RunOptions | null = null;
  killCalled = false;
  disposeCalled = false;

  run(options: RunOptions, handlers: RunHandlers): void {
    this.lastOptions = options;
    this.lastHandlers = handlers;
  }

  kill(): void {
    this.killCalled = true;
  }

  dispose(): void {
    this.disposeCalled = true;
  }
}

let nextPort = 19200;

function connect(port: number, token?: string): Promise<{ client: WebSocket; firstMsg: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const url = token ? `ws://localhost:${port}?token=${token}` : `ws://localhost:${port}`;
    const client = new WebSocket(url);
    const timer = setTimeout(() => reject(new Error("connect timeout")), 3000);
    client.on("error", (err) => { clearTimeout(timer); reject(err); });
    client.on("message", (data) => {
      clearTimeout(timer);
      resolve({ client, firstMsg: JSON.parse(data.toString()) });
    });
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("message timeout")), 3000);
    ws.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()));
    });
  });
}

describe("AgentWebSocketServer", () => {
  let server: AgentWebSocketServer;
  let client: WebSocket;
  let port: number;

  afterEach(async () => {
    client?.close();
    server?.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  function createServer(opts?: { mode?: string; authToken?: string }): { claudeRunner: () => MockRunner; codexRunner: () => MockRunner } {
    port = nextPort++;
    let currentClaudeRunner: MockRunner;
    let currentCodexRunner: MockRunner;
    server = new AgentWebSocketServer({
      port,
      host: "localhost",
      logger: testLogger,
      claudeRunnerFactory: () => {
        currentClaudeRunner = new MockRunner();
        return currentClaudeRunner;
      },
      codexRunnerFactory: () => {
        currentCodexRunner = new MockRunner();
        return currentCodexRunner;
      },
      ...(opts?.mode ? { mode: opts.mode as "safe" | "agentic" | "unrestricted" } : {}),
      ...(opts?.authToken ? { authToken: opts.authToken } : {}),
    });
    return {
      claudeRunner: () => currentClaudeRunner!,
      codexRunner: () => currentCodexRunner!,
    };
  }

  it("sends connected message on connection with default safe mode", async () => {
    createServer();
    await server.start();

    const { client: c, firstMsg } = await connect(port);
    client = c;

    expect(firstMsg).toEqual({
      type: "connected",
      version: "1.0",
      agent: "agent-ws",
      mode: "safe",
    });
  });

  it("handles prompt message and streams chunks", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "Hello Claude",
      requestId: "req-1",
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();
    expect(runner.lastOptions?.prompt).toBe("Hello Claude");
    expect(runner.lastOptions?.requestId).toBe("req-1");

    // Simulate chunk
    const chunkP = nextMessage(client);
    runner.lastHandlers!.onChunk("Hello!", "req-1");
    const chunk = await chunkP;
    expect(chunk).toEqual({ type: "chunk", content: "Hello!", requestId: "req-1" });

    // Simulate complete
    const completeP = nextMessage(client);
    runner.lastHandlers!.onComplete("req-1");
    const complete = await completeP;
    expect(complete).toEqual({ type: "complete", requestId: "req-1" });
  });

  it("handles cancel message and sends error response", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "Hello",
      requestId: "req-1",
    }));
    await new Promise((r) => setTimeout(r, 50));

    const cancelP = nextMessage(client);
    client.send(JSON.stringify({ type: "cancel" }));
    const msg = await cancelP;

    expect(ctx.claudeRunner().killCalled).toBe(true);
    expect(msg).toEqual({ type: "error", message: "Request cancelled", requestId: "req-1" });
  });

  it("returns error for invalid JSON", async () => {
    createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    const errorP = nextMessage(client);
    client.send("not valid json");
    const msg = await errorP;

    expect(msg["type"]).toBe("error");
    expect(msg["message"]).toBe("Invalid JSON");
  });

  it("disposes runner on client disconnect", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "test",
      requestId: "r1",
    }));
    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();

    client.close();
    await new Promise((r) => setTimeout(r, 100));

    expect(runner.disposeCalled).toBe(true);
  });

  it("returns error for unknown message type", async () => {
    createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    const errorP = nextMessage(client);
    client.send(JSON.stringify({ type: "bogus" }));
    const msg = await errorP;

    expect(msg["type"]).toBe("error");
    expect(msg["message"]).toMatch(/Unknown message type/);
  });

  it("uses codex runner when provider is codex", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "Hello Codex",
      requestId: "req-codex-1",
      provider: "codex",
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.codexRunner();
    expect(runner.lastOptions?.prompt).toBe("Hello Codex");
    expect(runner.lastOptions?.requestId).toBe("req-codex-1");

    const chunkP = nextMessage(client);
    runner.lastHandlers!.onChunk("Codex reply", "req-codex-1");
    const chunk = await chunkP;
    expect(chunk).toEqual({ type: "chunk", content: "Codex reply", requestId: "req-codex-1" });
  });

  it("passes images through to runner", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    const images = [{ media_type: "image/png", data: "iVBORbase64data" }];
    client.send(JSON.stringify({
      type: "prompt",
      prompt: "describe this image",
      requestId: "req-img-1",
      images,
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();
    expect(runner.lastOptions?.images).toEqual(images);
    expect(runner.lastOptions?.prompt).toBe("describe this image");
  });

  it("passes files through to runner", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    const files = [{ path: "src/App.tsx", content: "export default function App() {}" }];
    client.send(JSON.stringify({
      type: "prompt",
      prompt: "add a button",
      requestId: "req-files-1",
      files,
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();
    expect(runner.lastOptions?.files).toEqual(files);
  });

  it("forwards tool_event messages from runner", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "create files",
      requestId: "req-tool-1",
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();

    // Simulate tool event start
    const toolP = nextMessage(client);
    runner.lastHandlers!.onToolEvent!(
      { event: "start", toolName: "Write", toolId: "tool-1" },
      "req-tool-1",
    );
    const toolMsg = await toolP;
    expect(toolMsg).toEqual({
      type: "tool_event",
      requestId: "req-tool-1",
      event: "start",
      toolName: "Write",
      toolId: "tool-1",
    });
  });

  it("forwards file_change messages from runner", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "create files",
      requestId: "req-fc-1",
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();

    // Simulate file change
    const fcP = nextMessage(client);
    runner.lastHandlers!.onFileChange!(
      { path: "src/App.tsx", changeType: "create", content: "hello" },
      "req-fc-1",
    );
    const fcMsg = await fcP;
    expect(fcMsg).toEqual({
      type: "file_change",
      requestId: "req-fc-1",
      path: "src/App.tsx",
      changeType: "create",
      content: "hello",
    });
  });

  it("rejects second prompt while request is in progress", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "first",
      requestId: "req-1",
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Send second prompt before first completes
    const errorP = nextMessage(client);
    client.send(JSON.stringify({
      type: "prompt",
      prompt: "second",
      requestId: "req-2",
    }));
    const msg = await errorP;

    expect(msg).toEqual({
      type: "error",
      message: "Request already in progress",
      requestId: "req-2",
    });
  });

  it("forwards thinking chunks with thinking flag", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      prompt: "think about this",
      requestId: "req-think-1",
    }));
    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();

    const thinkP = nextMessage(client);
    runner.lastHandlers!.onChunk("reasoning...", "req-think-1", true);
    const thinkMsg = await thinkP;

    expect(thinkMsg).toEqual({
      type: "chunk",
      content: "reasoning...",
      requestId: "req-think-1",
      thinking: true,
    });
  });

  it("allows new prompt after onError resets state", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    // Send first prompt
    client.send(JSON.stringify({
      type: "prompt",
      prompt: "first",
      requestId: "req-err-1",
    }));
    await new Promise((r) => setTimeout(r, 50));

    // Simulate error on first request
    const errorP = nextMessage(client);
    ctx.claudeRunner().lastHandlers!.onError("something broke", "req-err-1");
    await errorP;

    // Second prompt should succeed (not "Request already in progress")
    client.send(JSON.stringify({
      type: "prompt",
      prompt: "second",
      requestId: "req-err-2",
    }));
    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.claudeRunner();
    expect(runner.lastOptions?.requestId).toBe("req-err-2");
  });

  it("cancel with no active request does not crash", async () => {
    createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    // Send cancel without any prior prompt — should not throw or send error
    client.send(JSON.stringify({ type: "cancel" }));
    await new Promise((r) => setTimeout(r, 50));

    // Connection should still be alive — verify by sending a valid prompt after
    client.send(JSON.stringify({
      type: "prompt",
      prompt: "after cancel",
      requestId: "req-ac-1",
    }));
    await new Promise((r) => setTimeout(r, 50));
  });

  it("connected message includes specified mode", async () => {
    createServer({ mode: "unrestricted" });
    await server.start();

    const { client: c, firstMsg } = await connect(port);
    client = c;

    expect(firstMsg).toEqual({
      type: "connected",
      version: "1.0",
      agent: "agent-ws",
      mode: "unrestricted",
    });
  });

  describe("per-IP rate limiting", () => {
    it("rejects connections exceeding per-IP limit", async () => {
      port = nextPort++;
      server = new AgentWebSocketServer({
        port,
        host: "localhost",
        logger: testLogger,
        claudeRunnerFactory: () => new MockRunner(),
        maxConnectionsPerIp: 2,
      });
      await server.start();

      // First two connections should succeed
      const { client: c1 } = await connect(port);
      const { client: c2 } = await connect(port);

      // Third should be rejected with 4029
      const ws3 = new WebSocket(`ws://localhost:${port}`);
      const code = await new Promise<number>((resolve) => {
        ws3.on("close", (closeCode) => resolve(closeCode));
      });
      expect(code).toBe(4029);

      c1.close();
      c2.close();
      await new Promise((r) => setTimeout(r, 50));
    });

    it("allows new connections after previous ones disconnect", async () => {
      port = nextPort++;
      server = new AgentWebSocketServer({
        port,
        host: "localhost",
        logger: testLogger,
        claudeRunnerFactory: () => new MockRunner(),
        maxConnectionsPerIp: 1,
      });
      await server.start();

      const { client: c1 } = await connect(port);
      c1.close();
      await new Promise((r) => setTimeout(r, 100));

      // Should succeed after first disconnected
      const { client: c2, firstMsg } = await connect(port);
      expect(firstMsg.type).toBe("connected");
      c2.close();
      await new Promise((r) => setTimeout(r, 50));
    });
  });

  describe("graceful shutdown", () => {
    it("resolves immediately when no requests are in flight", async () => {
      createServer();
      await server.start();
      const { client: c } = await connect(port);
      client = c;

      const start = Date.now();
      await server.gracefulStop(2000);
      const elapsed = Date.now() - start;

      expect(elapsed).toBeLessThan(500);
    });

    it("sends 'Server is shutting down' error to clients with active requests", async () => {
      const ctx = createServer();
      await server.start();
      const { client: c } = await connect(port);
      client = c;

      client.send(JSON.stringify({ type: "prompt", prompt: "long task", requestId: "req-gs" }));
      await new Promise((r) => setTimeout(r, 50));

      const errorP = nextMessage(client);
      // Don't await — gracefulStop will hang until the request completes
      const stopP = server.gracefulStop(500);

      const msg = await errorP;
      expect(msg).toEqual({ type: "error", message: "Server is shutting down" });

      // Simulate the runner completing so gracefulStop can resolve
      ctx.claudeRunner().lastHandlers!.onComplete("req-gs");
      await stopP;
    });

    it("waits for in-flight request to complete before stopping", async () => {
      const ctx = createServer();
      await server.start();
      const { client: c } = await connect(port);
      client = c;

      client.send(JSON.stringify({ type: "prompt", prompt: "task", requestId: "req-wait" }));
      await new Promise((r) => setTimeout(r, 50));

      const stopP = server.gracefulStop(2000);

      // Drain the "shutting down" notice so it doesn't surface later
      client.on("message", () => {});

      // Complete after 150ms — gracefulStop should resolve shortly after
      setTimeout(() => ctx.claudeRunner().lastHandlers!.onComplete("req-wait"), 150);

      const start = Date.now();
      await stopP;
      const elapsed = Date.now() - start;

      expect(elapsed).toBeGreaterThanOrEqual(140);
      expect(elapsed).toBeLessThan(800);
    });

    it("force-stops after timeout when request never completes", async () => {
      createServer();
      await server.start();
      const { client: c } = await connect(port);
      client = c;

      client.send(JSON.stringify({ type: "prompt", prompt: "stuck", requestId: "req-stuck" }));
      await new Promise((r) => setTimeout(r, 50));

      client.on("message", () => {});

      const start = Date.now();
      await server.gracefulStop(200);
      const elapsed = Date.now() - start;

      // Should resolve after ~200ms even though no completion came
      expect(elapsed).toBeGreaterThanOrEqual(180);
      expect(elapsed).toBeLessThan(800);
    });
  });

  describe("auth token", () => {
    const TEST_TOKEN = "a".repeat(64);

    it("rejects connection without token when authToken is set", async () => {
      createServer({ authToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}`);
      const code = await new Promise<number>((resolve) => {
        ws.on("close", (code) => resolve(code));
      });
      expect(code).toBe(4401);
    });

    it("rejects connection with wrong token", async () => {
      createServer({ authToken: TEST_TOKEN });
      await server.start();

      const ws = new WebSocket(`ws://localhost:${port}?token=wrong`);
      const code = await new Promise<number>((resolve) => {
        ws.on("close", (code) => resolve(code));
      });
      expect(code).toBe(4401);
    });

    it("accepts connection with correct token", async () => {
      createServer({ authToken: TEST_TOKEN });
      await server.start();

      const { client: c, firstMsg } = await connect(port, TEST_TOKEN);
      client = c;

      expect(firstMsg.type).toBe("connected");
    });

    it("accepts connection without token when no authToken is set", async () => {
      createServer();
      await server.start();

      const { client: c, firstMsg } = await connect(port);
      client = c;

      expect(firstMsg.type).toBe("connected");
    });
  });
});

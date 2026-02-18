import { WebSocket } from "ws";
import { AgentWebSocketServer } from "../src/server/websocket.js";
import type { Runner, RunOptions, RunHandlers } from "../src/process/claude-runner.js";
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

function connect(port: number): Promise<{ client: WebSocket; firstMsg: Record<string, unknown> }> {
  return new Promise((resolve, reject) => {
    const client = new WebSocket(`ws://localhost:${port}`);
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

  function createServer(opts?: { mode?: string }): { claudeRunner: () => MockRunner; codexRunner: () => MockRunner } {
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
});

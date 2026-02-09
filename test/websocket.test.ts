import { describe, it, expect, afterEach, vi } from "vitest";
import { WebSocket } from "ws";

vi.mock("node-pty", () => ({ spawn: vi.fn() }));

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
    client.on("error", reject);
    client.on("message", (data) => {
      resolve({ client, firstMsg: JSON.parse(data.toString()) });
    });
    setTimeout(() => reject(new Error("connect timeout")), 3000);
  });
}

function nextMessage(ws: WebSocket): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    ws.once("message", (data) => resolve(JSON.parse(data.toString())));
    setTimeout(() => reject(new Error("message timeout")), 3000);
  });
}

describe("AgentWebSocketServer", () => {
  let server: AgentWebSocketServer;
  let client: WebSocket;
  let mockRunner: MockRunner;
  let port: number;

  afterEach(async () => {
    client?.close();
    server?.stop();
    await new Promise((r) => setTimeout(r, 50));
  });

  function createServer(): { runner: () => MockRunner } {
    port = nextPort++;
    let currentRunner: MockRunner;
    server = new AgentWebSocketServer({
      port,
      host: "localhost",
      logger: testLogger,
      runnerFactory: () => {
        currentRunner = new MockRunner();
        return currentRunner;
      },
    });
    return { runner: () => currentRunner! };
  }

  it("sends connected message on connection", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c, firstMsg } = await connect(port);
    client = c;

    expect(firstMsg).toEqual({
      type: "connected",
      version: "1.0",
      agent: "agent-ws",
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

    const runner = ctx.runner();
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

  it("handles cancel message", async () => {
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

    client.send(JSON.stringify({ type: "cancel" }));
    await new Promise((r) => setTimeout(r, 50));

    expect(ctx.runner().killCalled).toBe(true);
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

  it("handles legacy format messages", async () => {
    const ctx = createServer();
    await server.start();

    const { client: c } = await connect(port);
    client = c;

    client.send(JSON.stringify({
      type: "prompt",
      content: "Hello from old client",
      projectId: "proj-1",
      files: [],
      model: "opus",
    }));

    await new Promise((r) => setTimeout(r, 50));

    const runner = ctx.runner();
    expect(runner.lastOptions?.prompt).toBe("Hello from old client");
    expect(runner.lastOptions?.model).toBe("opus");
    expect(runner.lastOptions?.requestId).toBeDefined();
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

    const runner = ctx.runner();

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
});

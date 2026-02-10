import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { ClaudeRunner, type ClaudeRunnerOptions, type Runner, type RunHandlers } from "../process/claude-runner.js";
import { CodexRunner } from "../process/codex-runner.js";
import {
  parseClientMessage,
  serializeMessage,
  type AgentMessage,
  type PromptMessage,
} from "./protocol.js";
import type { Logger } from "../utils/logger.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PAYLOAD = 1024 * 1024; // 1MB

export type RunnerFactory = (log: Logger) => Runner;

interface ConnectionState {
  claudeRunner: Runner | null;
  codexRunner: Runner | null;
  activeRunner: Runner | null;
  isAlive: boolean;
  activeRequestId: string | null;
}

export interface AgentWebSocketServerOptions {
  port: number;
  host: string;
  logger: Logger;
  claudePath?: string;
  codexPath?: string;
  timeoutMs?: number;
  allowedOrigins?: string[];
  maxPayload?: number;
  runnerFactory?: RunnerFactory;
  agentName?: string;
  sessionDir?: string;
}

export class AgentWebSocketServer {
  private wss: WebSocketServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly log: Logger;
  private readonly options: AgentWebSocketServerOptions;

  constructor(options: AgentWebSocketServerOptions) {
    this.options = options;
    this.log = options.logger;
  }

  start(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.wss = new WebSocketServer({
        port: this.options.port,
        host: this.options.host,
        maxPayload: this.options.maxPayload ?? DEFAULT_MAX_PAYLOAD,
      });

      this.wss.on("listening", () => {
        this.log.info({ port: this.options.port, host: this.options.host }, "WebSocket server started");
        this.startHeartbeat();
        resolve();
      });

      this.wss.on("error", (err: NodeJS.ErrnoException) => {
        if (err.code === "EADDRINUSE") {
          this.log.fatal({ port: this.options.port }, "Port already in use");
        } else {
          this.log.error({ err }, "WebSocket server error");
        }
        reject(err);
      });

      this.wss.on("connection", (ws, req) => this.handleConnection(ws, req));
    });
  }

  stop(): void {
    if (this.heartbeatInterval) {
      clearInterval(this.heartbeatInterval);
      this.heartbeatInterval = null;
    }

    for (const [ws, state] of this.connections) {
      state.claudeRunner?.dispose();
      state.codexRunner?.dispose();
      ws.terminate();
    }
    this.connections.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.log.info("WebSocket server stopped");
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Origin check
    if (this.options.allowedOrigins && this.options.allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      if (!origin || !this.options.allowedOrigins.includes(origin)) {
        this.log.warn({ origin: origin ?? "(none)" }, "Rejected connection: origin not in allowlist");
        ws.close(4003, "Origin not allowed");
        return;
      }
    }

    const clientIp = req.socket.remoteAddress;
    this.log.info({ clientIp }, "Client connected");

    const state: ConnectionState = { claudeRunner: null, codexRunner: null, activeRunner: null, isAlive: true, activeRequestId: null };
    this.connections.set(ws, state);

    // Send connected message
    this.sendMessage(ws, {
      type: "connected",
      version: "1.0",
      agent: this.options.agentName ?? "agent-ws",
    });

    ws.on("pong", () => {
      state.isAlive = true;
    });

    ws.on("message", (data) => {
      const raw = data.toString();
      this.handleMessage(ws, state, raw);
    });

    ws.on("close", () => {
      this.log.info({ clientIp }, "Client disconnected");
      state.claudeRunner?.dispose();
      state.codexRunner?.dispose();
      this.connections.delete(ws);
    });

    ws.on("error", (err) => {
      this.log.error({ err, clientIp }, "WebSocket error");
    });
  }

  private handleMessage(ws: WebSocket, state: ConnectionState, raw: string): void {
    const result = parseClientMessage(raw);

    if (!result.ok) {
      this.sendMessage(ws, { type: "error", message: result.error });
      return;
    }

    const { message } = result;

    switch (message.type) {
      case "prompt":
        this.handlePrompt(ws, state, message);
        break;
      case "cancel":
        this.handleCancel(ws, state);
        break;
    }
  }

  private handlePrompt(ws: WebSocket, state: ConnectionState, message: PromptMessage): void {
    if (state.activeRequestId !== null) {
      this.sendMessage(ws, {
        type: "error",
        message: "Request already in progress",
        requestId: message.requestId,
      });
      return;
    }

    state.activeRequestId = message.requestId;

    // Select runner for the requested provider (lazy-created, preserved across switches)
    if (message.provider === "codex") {
      if (!state.codexRunner) {
        state.codexRunner = new CodexRunner({
          codexPath: this.options.codexPath,
          timeoutMs: this.options.timeoutMs,
          logger: this.log.child({ component: "codex-runner" }),
          sessionDir: this.options.sessionDir,
        });
      }
      state.activeRunner = state.codexRunner;
    } else {
      if (!state.claudeRunner) {
        state.claudeRunner = this.createRunner();
      }
      state.activeRunner = state.claudeRunner;
    }

    const handlers: RunHandlers = {
      onChunk: (content, requestId, thinking) => {
        try {
          this.sendMessage(ws, { type: "chunk", content, requestId, ...(thinking ? { thinking: true } : {}) });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onChunk handler");
        }
      },
      onComplete: (requestId) => {
        try {
          state.activeRequestId = null;
          this.sendMessage(ws, { type: "complete", requestId });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onComplete handler");
        }
      },
      onError: (errorMessage, requestId) => {
        try {
          state.activeRequestId = null;
          this.sendMessage(ws, { type: "error", message: errorMessage, requestId });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onError handler");
        }
      },
    };

    state.activeRunner!.run(
      { prompt: message.prompt, model: message.model, systemPrompt: message.systemPrompt, projectId: message.projectId, requestId: message.requestId, thinkingTokens: message.thinkingTokens },
      handlers,
    );
  }

  private handleCancel(ws: WebSocket, state: ConnectionState): void {
    state.activeRunner?.kill();
    const requestId = state.activeRequestId;
    state.activeRequestId = null;
    this.log.info({ requestId }, "Request cancelled");
  }

  private sendMessage(ws: WebSocket, message: AgentMessage): void {
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(serializeMessage(message));
    } else {
      this.log.warn({ messageType: message.type, readyState: ws.readyState }, "Dropping message, WebSocket not OPEN");
    }
  }

  private createRunner(): Runner {
    if (this.options.runnerFactory) {
      return this.options.runnerFactory(this.log);
    }

    const runnerOptions: ClaudeRunnerOptions = {
      claudePath: this.options.claudePath,
      timeoutMs: this.options.timeoutMs,
      logger: this.log.child({ component: "runner" }),
      sessionDir: this.options.sessionDir,
    };
    return new ClaudeRunner(runnerOptions);
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, state] of this.connections) {
        if (!state.isAlive) {
          this.log.debug("Terminating dead connection");
          state.claudeRunner?.dispose();
          state.codexRunner?.dispose();
          this.connections.delete(ws);
          ws.terminate();
          continue;
        }

        state.isAlive = false;
        try {
          ws.ping();
        } catch {
          this.log.debug("Ping failed, terminating connection");
          state.claudeRunner?.dispose();
          state.codexRunner?.dispose();
          this.connections.delete(ws);
          ws.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

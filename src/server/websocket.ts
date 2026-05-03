import { WebSocketServer, WebSocket } from "ws";
import type { IncomingMessage } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { type Runner, type RunHandlers } from "../process/base-runner.js";
import { ClaudeRunner } from "../process/claude-runner.js";
import { CodexRunner } from "../process/codex-runner.js";
import {
  parseClientMessage,
  serializeMessage,
  type AgentMessage,
  type PermissionMode,
  type PromptMessage,
} from "./protocol.js";
import type { Logger } from "../utils/logger.js";

const HEARTBEAT_INTERVAL_MS = 30_000;
const DEFAULT_MAX_PAYLOAD = 50 * 1024 * 1024; // 50MB (images can be large)
const REJECTION_LOG_INTERVAL_MS = 10_000;
const MAX_CONNECTIONS_PER_IP = 10;
const GRACEFUL_SHUTDOWN_MS = 5_000;

export type RunnerFactory = (log: Logger) => Runner;

interface ConnectionState {
  claudeRunner: Runner | null;
  codexRunner: Runner | null;
  activeRunner: Runner | null;
  isAlive: boolean;
  activeRequestId: string | null;
  clientIp: string | undefined;
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
  /** @deprecated Use claudeRunnerFactory instead */
  runnerFactory?: RunnerFactory;
  claudeRunnerFactory?: RunnerFactory;
  codexRunnerFactory?: RunnerFactory;
  agentName?: string;
  sessionDir?: string;
  mode?: PermissionMode;
  authToken?: string;
  maxConnectionsPerIp?: number;
}

export class AgentWebSocketServer {
  private wss: WebSocketServer | null = null;
  private heartbeatInterval: NodeJS.Timeout | null = null;
  private rejectionFlushInterval: NodeJS.Timeout | null = null;
  private readonly rejectionCounts = new Map<string, { reason: string; count: number }>();
  private readonly connections = new Map<WebSocket, ConnectionState>();
  private readonly ipConnectionCounts = new Map<string, number>();
  private readonly maxConnectionsPerIp: number;
  private readonly log: Logger;
  private readonly options: AgentWebSocketServerOptions;

  constructor(options: AgentWebSocketServerOptions) {
    this.options = options;
    this.log = options.logger;
    this.maxConnectionsPerIp = options.maxConnectionsPerIp ?? MAX_CONNECTIONS_PER_IP;
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

    this.flushRejections();

    for (const [ws, state] of this.connections) {
      this.cleanupConnection(ws, state);
      ws.terminate();
    }
    this.connections.clear();
    this.ipConnectionCounts.clear();

    if (this.wss) {
      this.wss.close();
      this.wss = null;
    }

    this.log.info("WebSocket server stopped");
  }

  /**
   * Graceful shutdown: notify clients, wait for in-flight requests, then stop.
   * Returns a promise that resolves when all connections are closed.
   */
  async gracefulStop(timeoutMs = GRACEFUL_SHUTDOWN_MS): Promise<void> {
    // Stop accepting new connections
    if (this.wss) {
      this.wss.removeAllListeners("connection");
    }

    // Check if any connections have active requests
    const hasActiveRequests = [...this.connections.values()].some(
      (state) => state.activeRequestId !== null,
    );

    if (!hasActiveRequests) {
      this.stop();
      return;
    }

    // Notify all connected clients
    for (const [ws] of this.connections) {
      this.sendMessage(ws, {
        type: "error",
        message: "Server is shutting down",
      });
    }

    // Wait for in-flight requests to finish, up to the timeout
    await new Promise<void>((resolve) => {
      const checkInterval = setInterval(() => {
        const stillActive = [...this.connections.values()].some(
          (state) => state.activeRequestId !== null,
        );
        if (!stillActive) {
          clearInterval(checkInterval);
          resolve();
        }
      }, 100);

      setTimeout(() => {
        clearInterval(checkInterval);
        resolve();
      }, timeoutMs);
    });

    this.stop();
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage): void {
    // Origin check
    if (this.options.allowedOrigins && this.options.allowedOrigins.length > 0) {
      const origin = req.headers.origin;
      if (!origin || !this.options.allowedOrigins.includes(origin)) {
        this.logRejection(origin ?? "(none)", "origin not in allowlist");
        ws.close(4003, "Origin not allowed");
        return;
      }
    }

    // Auth token check (timing-safe to defeat brute-force timing attacks)
    if (this.options.authToken) {
      const url = new URL(req.url ?? "", `http://${req.headers.host ?? "localhost"}`);
      const token = url.searchParams.get("token") ?? "";
      const expected = Buffer.from(this.options.authToken);
      const got = Buffer.from(token);
      const ok = got.length === expected.length && timingSafeEqual(got, expected);
      if (!ok) {
        this.logRejection(req.headers.origin ?? "(none)", "invalid or missing auth token");
        ws.close(4401, "Invalid or missing auth token");
        return;
      }
    }

    const clientIp = req.socket.remoteAddress;

    // Per-IP connection rate limiting
    if (clientIp) {
      const currentCount = this.ipConnectionCounts.get(clientIp) ?? 0;
      if (currentCount >= this.maxConnectionsPerIp) {
        this.logRejection(clientIp, "too many connections from this IP");
        ws.close(4029, "Too many connections");
        return;
      }
      this.ipConnectionCounts.set(clientIp, currentCount + 1);
    }

    this.log.info({ clientIp }, "Client connected");

    const state: ConnectionState = {
      claudeRunner: null,
      codexRunner: null,
      activeRunner: null,
      isAlive: true,
      activeRequestId: null,
      clientIp,
    };
    this.connections.set(ws, state);

    // Send connected message
    this.sendMessage(ws, {
      type: "connected",
      version: "1.0",
      agent: this.options.agentName ?? "agent-ws",
      mode: this.options.mode ?? "safe",
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
      this.cleanupConnection(ws, state);
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
      this.log.warn(
        { activeRequestId: state.activeRequestId, newRequestId: message.requestId },
        "Rejected prompt: request already in progress"
      );
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
        state.codexRunner = this.createCodexRunner();
      }
      state.activeRunner = state.codexRunner;
    } else {
      if (!state.claudeRunner) {
        state.claudeRunner = this.createClaudeRunner();
      }
      state.activeRunner = state.claudeRunner;
    }

    const runner = state.activeRunner;

    const handlers: RunHandlers = {
      onChunk: (content, requestId, thinking) => {
        try {
          this.sendMessage(ws, { type: "chunk", content, requestId, ...(thinking ? { thinking: true } : {}) });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onChunk handler");
        }
      },
      onComplete: (requestId) => {
        state.activeRequestId = null;
        try {
          this.sendMessage(ws, { type: "complete", requestId });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onComplete handler");
        }
      },
      onError: (errorMessage, requestId) => {
        state.activeRequestId = null;
        try {
          this.sendMessage(ws, { type: "error", message: errorMessage, requestId });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onError handler");
        }
      },
      onToolEvent: (event, requestId) => {
        try {
          this.sendMessage(ws, {
            type: "tool_event",
            requestId,
            event: event.event,
            toolName: event.toolName,
            toolId: event.toolId,
            input: event.input,
          });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onToolEvent handler");
        }
      },
      onFileChange: (change, requestId) => {
        try {
          this.sendMessage(ws, {
            type: "file_change",
            requestId,
            path: change.path,
            changeType: change.changeType,
            content: change.content,
          });
        } catch (err) {
          this.log.warn({ err, requestId }, "Error in onFileChange handler");
        }
      },
    };

    runner.run(
      {
        prompt: message.prompt,
        model: message.model,
        systemPrompt: message.systemPrompt,
        projectId: message.projectId,
        requestId: message.requestId,
        thinkingTokens: message.thinkingTokens,
        images: message.images,
        files: message.files,
      },
      handlers,
    );
  }

  private handleCancel(ws: WebSocket, state: ConnectionState): void {
    const requestId = state.activeRequestId;
    state.activeRunner?.kill();
    state.activeRequestId = null;

    if (requestId) {
      this.sendMessage(ws, { type: "error", message: "Request cancelled", requestId });
    }
    this.log.info({ requestId }, "Request cancelled");
  }

  private cleanupConnection(ws: WebSocket, state: ConnectionState): void {
    state.claudeRunner?.dispose();
    state.codexRunner?.dispose();

    // Decrement per-IP connection count
    if (state.clientIp) {
      const count = this.ipConnectionCounts.get(state.clientIp);
      if (count !== undefined) {
        if (count <= 1) {
          this.ipConnectionCounts.delete(state.clientIp);
        } else {
          this.ipConnectionCounts.set(state.clientIp, count - 1);
        }
      }
    }
  }

  private sendMessage(ws: WebSocket, message: AgentMessage): void {
    if (ws.readyState !== WebSocket.OPEN) {
      this.log.warn({ messageType: message.type, readyState: ws.readyState }, "Dropping message, WebSocket not OPEN");
      return;
    }
    try {
      ws.send(serializeMessage(message));
    } catch (err) {
      this.log.warn({ err, messageType: message.type }, "Failed to send WebSocket message");
    }
  }

  private createClaudeRunner(): Runner {
    const factory = this.options.claudeRunnerFactory ?? this.options.runnerFactory;
    if (factory) {
      return factory(this.log);
    }

    return new ClaudeRunner({
      claudePath: this.options.claudePath,
      timeoutMs: this.options.timeoutMs,
      logger: this.log.child({ component: "claude-runner" }),
      sessionDir: this.options.sessionDir,
      mode: this.options.mode,
    });
  }

  private createCodexRunner(): Runner {
    if (this.options.codexRunnerFactory) {
      return this.options.codexRunnerFactory(this.log);
    }

    return new CodexRunner({
      codexPath: this.options.codexPath,
      timeoutMs: this.options.timeoutMs,
      logger: this.log.child({ component: "codex-runner" }),
      sessionDir: this.options.sessionDir,
      mode: this.options.mode,
    });
  }

  private logRejection(origin: string, reason: string): void {
    const entry = this.rejectionCounts.get(origin);
    if (entry) {
      entry.count++;
      return;
    }
    // First rejection for this origin — log immediately, start tracking
    this.log.warn({ origin }, `Rejected connection: ${reason}`);
    this.rejectionCounts.set(origin, { reason, count: 0 });

    if (!this.rejectionFlushInterval) {
      this.rejectionFlushInterval = setInterval(() => this.flushRejections(), REJECTION_LOG_INTERVAL_MS);
    }
  }

  private flushRejections(): void {
    for (const [origin, entry] of this.rejectionCounts) {
      if (entry.count > 0) {
        this.log.warn({ origin, count: entry.count }, `Rejected ${entry.count} more connection(s): ${entry.reason}`);
      }
    }
    this.rejectionCounts.clear();

    if (this.rejectionFlushInterval) {
      clearInterval(this.rejectionFlushInterval);
      this.rejectionFlushInterval = null;
    }
  }

  private startHeartbeat(): void {
    this.heartbeatInterval = setInterval(() => {
      for (const [ws, state] of this.connections) {
        if (!state.isAlive) {
          this.log.debug("Terminating dead connection");
          this.cleanupConnection(ws, state);
          this.connections.delete(ws);
          ws.terminate();
          continue;
        }

        state.isAlive = false;
        try {
          ws.ping();
        } catch {
          this.log.debug("Ping failed, terminating connection");
          this.cleanupConnection(ws, state);
          this.connections.delete(ws);
          ws.terminate();
        }
      }
    }, HEARTBEAT_INTERVAL_MS);
  }
}

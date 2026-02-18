import { AgentWebSocketServer, type AgentWebSocketServerOptions, type RunnerFactory } from "./server/websocket.js";
import type { PermissionMode } from "./server/protocol.js";
import { createLogger, type Logger } from "./utils/logger.js";

export interface AgentWSOptions {
  port?: number;
  host?: string;
  claudePath?: string;
  codexPath?: string;
  timeoutMs?: number;
  logLevel?: string;
  allowedOrigins?: string[];
  /** @deprecated Use claudeRunnerFactory instead */
  runnerFactory?: RunnerFactory;
  claudeRunnerFactory?: RunnerFactory;
  codexRunnerFactory?: RunnerFactory;
  agentName?: string;
  sessionDir?: string;
  mode?: PermissionMode;
}

export class AgentWS {
  private server: AgentWebSocketServer;
  private readonly log: Logger;

  constructor(options: AgentWSOptions = {}) {
    this.log = createLogger({ level: options.logLevel ?? "info" });

    const serverOptions: AgentWebSocketServerOptions = {
      port: options.port ?? 9999,
      host: options.host ?? "localhost",
      logger: this.log,
      claudePath: options.claudePath,
      codexPath: options.codexPath,
      timeoutMs: options.timeoutMs,
      allowedOrigins: options.allowedOrigins,
      runnerFactory: options.runnerFactory,
      claudeRunnerFactory: options.claudeRunnerFactory,
      codexRunnerFactory: options.codexRunnerFactory,
      agentName: options.agentName,
      sessionDir: options.sessionDir,
      mode: options.mode,
    };

    this.server = new AgentWebSocketServer(serverOptions);
  }

  async start(): Promise<void> {
    await this.server.start();
  }

  stop(): void {
    this.server.stop();
  }
}

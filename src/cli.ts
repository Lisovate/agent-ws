import { Command } from "commander";
import { AgentWS } from "./agent.js";
import { checkClaudeCli } from "./utils/claude-check.js";

declare const PKG_VERSION: string;
const VERSION = typeof PKG_VERSION !== "undefined" ? PKG_VERSION : "0.0.0-dev";

const program = new Command();

program
  .name("agent-ws")
  .description("WebSocket bridge for CLI AI agents (Claude, Codex)")
  .version(VERSION)
  .option("-p, --port <port>", "WebSocket server port", "9999")
  .option("-H, --host <host>", "WebSocket server host", "localhost")
  .option("-c, --claude-path <path>", "Path to Claude CLI", "claude")
  .option("--codex-path <path>", "Path to Codex CLI", "codex")
  .option("-t, --timeout <seconds>", "Process timeout in seconds", "300")
  .option("--log-level <level>", "Log level (debug, info, warn, error)", "info")
  .option("--origins <origins>", "Comma-separated allowed origins")
  .action(async (opts: {
    port: string;
    host: string;
    claudePath: string;
    codexPath: string;
    timeout: string;
    logLevel: string;
    origins?: string;
  }) => {
    // Banner
    console.log(`
╔═══════════════════════════════════════╗
║          agent-ws v${VERSION.padEnd(20)}║
║     CLI AI Agent Bridge              ║
╚═══════════════════════════════════════╝
`);

    // Check Claude CLI
    const check = checkClaudeCli(opts.claudePath);
    if (!check.available) {
      console.error(`Claude CLI not found at: ${opts.claudePath}`);
      console.error("Make sure Claude Code is installed and in your PATH.");
      console.error("Install: npm install -g @anthropic-ai/claude-code");
      console.error(`Or specify path: agent-ws --claude-path /path/to/claude`);
      process.exit(1);
    }
    console.log(`Found Claude CLI: ${check.version}`);

    // Check Codex CLI (optional — just warn if missing)
    const codexCheck = checkClaudeCli(opts.codexPath);
    if (codexCheck.available) {
      console.log(`Found Codex CLI: ${codexCheck.version}`);
    } else {
      console.log("Codex CLI not found (codex provider will be unavailable)");
    }

    const port = parseInt(opts.port, 10);
    if (isNaN(port) || port < 1 || port > 65535) {
      console.error(`Invalid port: ${opts.port} (must be 1–65535)`);
      process.exit(1);
    }

    const timeoutSeconds = parseInt(opts.timeout, 10);
    if (isNaN(timeoutSeconds) || timeoutSeconds < 1 || timeoutSeconds > 3600) {
      console.error(`Invalid timeout: ${opts.timeout} (must be 1–3600 seconds)`);
      process.exit(1);
    }
    const timeoutMs = timeoutSeconds * 1000;

    const allowedOrigins = opts.origins?.split(",").map((o) => o.trim()).filter(Boolean);
    if (allowedOrigins) {
      for (const origin of allowedOrigins) {
        try {
          new URL(origin);
        } catch {
          console.error(`Invalid origin: "${origin}" (must be a valid URL, e.g. https://example.com)`);
          process.exit(1);
        }
      }
    }

    const agent = new AgentWS({
      port,
      host: opts.host,
      claudePath: opts.claudePath,
      codexPath: opts.codexPath,
      timeoutMs,
      logLevel: opts.logLevel,
      allowedOrigins,
    });

    try {
      await agent.start();
    } catch (err) {
      if (err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE") {
        console.error(`Port ${port} is already in use.`);
        console.error("Another instance of agent-ws might be running.");
      }
      process.exit(1);
    }

    console.log(`agent-ws running on ws://${opts.host}:${port}`);
    console.log("Waiting for connections...\n");
    console.log("Press Ctrl+C to stop\n");

    // Graceful shutdown
    const shutdown = () => {
      agent.stop();
      console.log("\nagent-ws stopped");
      process.exit(0);
    };

    process.on("SIGINT", shutdown);
    process.on("SIGTERM", shutdown);
  });

program.parse();

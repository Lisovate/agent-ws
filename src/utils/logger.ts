import pino from "pino";

export interface LoggerOptions {
  level?: string;
  pretty?: boolean;
}

export function createLogger(options: LoggerOptions = {}): pino.Logger {
  const { level = "info", pretty = process.env["NODE_ENV"] !== "production" } = options;

  if (pretty) {
    return pino({
      level,
      transport: {
        target: "pino-pretty",
        options: {
          colorize: true,
          translateTime: "HH:MM:ss",
          ignore: "pid,hostname",
        },
      },
    });
  }

  return pino({ level });
}

export type Logger = pino.Logger;

import { execFileSync } from "node:child_process";

export interface CliCheckResult {
  available: boolean;
  version?: string;
  error?: string;
}

export function checkCli(cliPath: string = "claude"): CliCheckResult {
  try {
    const output = execFileSync(cliPath, ["--version"], {
      timeout: 5000,
      stdio: "pipe",
      encoding: "utf-8",
    });

    return {
      available: true,
      version: output.trim(),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : "Unknown error";
    return {
      available: false,
      error: message,
    };
  }
}

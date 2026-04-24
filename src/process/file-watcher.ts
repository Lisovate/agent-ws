import { watch, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { FileChangeData } from "./claude-runner.js";

const DEBOUNCE_MS = 100;

/** Patterns to skip when watching for file changes. */
const SKIP_PATTERNS = [
  /(^|\/)\./,  // hidden files/dirs at any depth
  /node_modules/,
  /\.git/,
  /__pycache__/,
];

function shouldSkip(relativePath: string): boolean {
  return SKIP_PATTERNS.some((p) => p.test(relativePath));
}

export class FileWatcher {
  private ac: AbortController | null = null;
  private readonly debounceTimers = new Map<string, NodeJS.Timeout>();
  private onChangeHandler: ((change: FileChangeData) => void) | null = null;
  private readonly dir: string;

  constructor(dir: string) {
    this.dir = dir;
  }

  onChange(handler: (change: FileChangeData) => void): void {
    this.onChangeHandler = handler;
  }

  async start(): Promise<void> {
    if (this.ac) return; // already running

    this.ac = new AbortController();

    try {
      const watcher = watch(this.dir, {
        recursive: true,
        signal: this.ac.signal,
      });

      // Process events in background — don't await this
      this.processEvents(watcher).catch((err: unknown) => {
        // AbortError is expected when stop() is called
        if (err instanceof Error && err.name === "AbortError") return;
      });
    } catch {
      // fs.watch may not support recursive on this platform
      this.ac = null;
    }
  }

  private async processEvents(watcher: AsyncIterable<{ eventType: string; filename: string | null }>): Promise<void> {
    for await (const event of watcher) {
      if (!event.filename) continue;

      const relativePath = event.filename;
      if (shouldSkip(relativePath)) continue;

      // Debounce per path
      const existing = this.debounceTimers.get(relativePath);
      if (existing) clearTimeout(existing);

      this.debounceTimers.set(
        relativePath,
        setTimeout(() => {
          this.debounceTimers.delete(relativePath);
          this.emitChange(relativePath).catch(() => {
            // emitChange handles its own errors (emits delete on failure)
          });
        }, DEBOUNCE_MS),
      );
    }
  }

  private async emitChange(relativePath: string): Promise<void> {
    if (!this.onChangeHandler) return;

    try {
      const fullPath = join(this.dir, relativePath);
      const content = await readFile(fullPath, "utf-8");
      this.onChangeHandler({
        path: relativePath,
        changeType: "update", // We detect create vs update by checking if file existed before — simplified to always "update"
        content,
      });
    } catch {
      // File was deleted or unreadable
      this.onChangeHandler({
        path: relativePath,
        changeType: "delete",
      });
    }
  }

  /** Fire all pending debounced events immediately. */
  async flush(): Promise<void> {
    const pendingPaths = [...this.debounceTimers.keys()];
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    await Promise.all(pendingPaths.map((p) => this.emitChange(p)));
  }

  stop(): void {
    if (this.ac) {
      this.ac.abort();
      this.ac = null;
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
  }
}

import { mkdirSync, writeFileSync, unlinkSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FileWatcher } from "../src/process/file-watcher.js";
import type { FileChangeData } from "../src/process/claude-runner.js";

function makeTempDir(): string {
  const dir = join(tmpdir(), `fw-test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

describe("FileWatcher", () => {
  let dir: string;
  let watcher: FileWatcher;

  beforeEach(() => {
    dir = makeTempDir();
    watcher = new FileWatcher(dir);
  });

  afterEach(() => {
    watcher.stop();
    rmSync(dir, { recursive: true, force: true });
  });

  it("emits change when a file is created", async () => {
    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    writeFileSync(join(dir, "hello.txt"), "world");

    // Wait for debounce (100ms) + some buffer
    await new Promise((r) => setTimeout(r, 300));

    expect(changes.length).toBeGreaterThanOrEqual(1);
    const change = changes.find((c) => c.path === "hello.txt");
    expect(change).toBeDefined();
    expect(change!.content).toBe("world");
    expect(change!.changeType).toBe("update");
  });

  it("emits delete when a file is removed", async () => {
    // Create file first
    writeFileSync(join(dir, "temp.txt"), "data");

    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    unlinkSync(join(dir, "temp.txt"));

    await new Promise((r) => setTimeout(r, 300));

    const deleteChange = changes.find((c) => c.path === "temp.txt" && c.changeType === "delete");
    expect(deleteChange).toBeDefined();
  });

  it("skips hidden files", async () => {
    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    writeFileSync(join(dir, ".hidden"), "secret");

    await new Promise((r) => setTimeout(r, 300));

    expect(changes.find((c) => c.path === ".hidden")).toBeUndefined();
  });

  it("skips node_modules", async () => {
    const nmDir = join(dir, "node_modules");
    mkdirSync(nmDir, { recursive: true });

    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    writeFileSync(join(nmDir, "pkg.json"), "{}");

    await new Promise((r) => setTimeout(r, 300));

    expect(changes.find((c) => c.path.includes("node_modules"))).toBeUndefined();
  });

  it("debounces rapid changes to the same file", async () => {
    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    // Rapid writes to the same file
    writeFileSync(join(dir, "rapid.txt"), "v1");
    writeFileSync(join(dir, "rapid.txt"), "v2");
    writeFileSync(join(dir, "rapid.txt"), "v3");

    await new Promise((r) => setTimeout(r, 300));

    const rapidChanges = changes.filter((c) => c.path === "rapid.txt");
    // Should be debounced to 1 (or at most a few) instead of 3
    expect(rapidChanges.length).toBeLessThanOrEqual(2);
    // Final content should be v3
    const last = rapidChanges[rapidChanges.length - 1];
    expect(last?.content).toBe("v3");
  });

  it("flush fires all pending debounced events", async () => {
    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    writeFileSync(join(dir, "flush-test.txt"), "flushed");

    // Don't wait for debounce — flush immediately
    await new Promise((r) => setTimeout(r, 20));
    await watcher.flush();

    const change = changes.find((c) => c.path === "flush-test.txt");
    expect(change).toBeDefined();
    expect(change!.content).toBe("flushed");
  });

  it("stop prevents further events", async () => {
    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();
    watcher.stop();

    writeFileSync(join(dir, "after-stop.txt"), "nope");

    await new Promise((r) => setTimeout(r, 300));

    expect(changes.find((c) => c.path === "after-stop.txt")).toBeUndefined();
  });

  it("start is idempotent", async () => {
    await watcher.start();
    await watcher.start(); // second call should be no-op
    watcher.stop();
  });

  it("emits correct relative path for subdirectory files", async () => {
    const subDir = join(dir, "src", "components");
    mkdirSync(subDir, { recursive: true });

    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    writeFileSync(join(subDir, "Button.tsx"), "export const Button = () => null;");

    await new Promise((r) => setTimeout(r, 300));

    const change = changes.find((c) => c.path.includes("Button.tsx"));
    expect(change).toBeDefined();
    // Path should be relative and include subdirectory
    expect(change!.path).toMatch(/src\/components\/Button\.tsx$|src\\components\\Button\.tsx$/);
  });

  it("skips hidden files in subdirectories", async () => {
    const subDir = join(dir, "src", ".cache");
    mkdirSync(subDir, { recursive: true });

    const changes: FileChangeData[] = [];
    watcher.onChange((c) => changes.push(c));
    await watcher.start();

    writeFileSync(join(subDir, "data.json"), "{}");

    await new Promise((r) => setTimeout(r, 300));

    expect(changes.find((c) => c.path.includes(".cache"))).toBeUndefined();
  });

  it("does not emit when no handler is set", async () => {
    // No onChange registered — should not throw
    await watcher.start();
    writeFileSync(join(dir, "no-handler.txt"), "test");
    await new Promise((r) => setTimeout(r, 300));
    watcher.stop();
  });
});

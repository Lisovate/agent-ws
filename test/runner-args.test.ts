import { buildClaudeArgs } from "../src/process/claude-runner.js";
import { buildCodexArgs } from "../src/process/codex-runner.js";

describe("buildClaudeArgs", () => {
  const base = { hasImages: false };

  it("safe mode produces --max-turns 1 --tools empty string", () => {
    const args = buildClaudeArgs("safe", base);
    expect(args).toContain("--max-turns");
    expect(args[args.indexOf("--max-turns") + 1]).toBe("1");
    expect(args).toContain("--tools");
    expect(args[args.indexOf("--tools") + 1]).toBe("");
    expect(args).not.toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--permission-mode");
  });

  it("agentic mode produces --permission-mode dontAsk with file tools", () => {
    const args = buildClaudeArgs("agentic", base);
    expect(args).toContain("--permission-mode");
    expect(args[args.indexOf("--permission-mode") + 1]).toBe("dontAsk");
    expect(args).toContain("--allowedTools");
    expect(args[args.indexOf("--allowedTools") + 1]).toBe("Read,Write,Edit,Glob,Grep");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--dangerously-skip-permissions");
  });

  it("unrestricted mode produces --dangerously-skip-permissions", () => {
    const args = buildClaudeArgs("unrestricted", base);
    expect(args).toContain("--dangerously-skip-permissions");
    expect(args).not.toContain("--max-turns");
    expect(args).not.toContain("--permission-mode");
  });

  it("always includes --print --verbose --output-format stream-json", () => {
    for (const mode of ["safe", "agentic", "unrestricted"] as const) {
      const args = buildClaudeArgs(mode, base);
      expect(args).toContain("--print");
      expect(args).toContain("--verbose");
      expect(args).toContain("--output-format");
      expect(args[args.indexOf("--output-format") + 1]).toBe("stream-json");
    }
  });

  it("always ends with stdin dash", () => {
    const args = buildClaudeArgs("safe", base);
    expect(args[args.length - 1]).toBe("-");
  });

  it("includes --input-format stream-json when images present", () => {
    const args = buildClaudeArgs("safe", { hasImages: true });
    expect(args).toContain("--input-format");
    expect(args[args.indexOf("--input-format") + 1]).toBe("stream-json");
  });

  it("excludes --input-format when no images", () => {
    const args = buildClaudeArgs("safe", { hasImages: false });
    expect(args).not.toContain("--input-format");
  });

  it("includes --continue when projectId is set", () => {
    const args = buildClaudeArgs("safe", { ...base, projectId: "my-project" });
    expect(args).toContain("--continue");
  });

  it("excludes --continue when no projectId", () => {
    const args = buildClaudeArgs("safe", base);
    expect(args).not.toContain("--continue");
  });

  it("includes --model when model is set", () => {
    const args = buildClaudeArgs("safe", { ...base, model: "opus" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("opus");
  });

  it("includes --system-prompt when systemPrompt is set", () => {
    const args = buildClaudeArgs("safe", { ...base, systemPrompt: "Be helpful" });
    expect(args).toContain("--system-prompt");
    expect(args[args.indexOf("--system-prompt") + 1]).toBe("Be helpful");
  });
});

describe("buildCodexArgs", () => {
  const base = { resuming: false, imagePaths: [] as string[] };

  it("safe mode uses --full-auto", () => {
    const args = buildCodexArgs("safe", base);
    expect(args).toContain("--full-auto");
    expect(args).not.toContain("--sandbox");
  });

  it("agentic mode uses --full-auto", () => {
    const args = buildCodexArgs("agentic", base);
    expect(args).toContain("--full-auto");
    expect(args).not.toContain("--sandbox");
  });

  it("unrestricted mode uses danger-full-access sandbox", () => {
    const args = buildCodexArgs("unrestricted", base);
    expect(args).toContain("--sandbox");
    expect(args[args.indexOf("--sandbox") + 1]).toBe("danger-full-access");
    expect(args).toContain("--ask-for-approval");
    expect(args[args.indexOf("--ask-for-approval") + 1]).toBe("never");
    expect(args).not.toContain("--full-auto");
  });

  it("always includes exec --json --skip-git-repo-check", () => {
    const args = buildCodexArgs("safe", base);
    expect(args[0]).toBe("exec");
    expect(args).toContain("--json");
    expect(args).toContain("--skip-git-repo-check");
  });

  it("always ends with stdin dash", () => {
    const args = buildCodexArgs("safe", base);
    expect(args[args.length - 1]).toBe("-");
  });

  it("includes resume and threadId when resuming", () => {
    const args = buildCodexArgs("safe", { resuming: true, threadId: "thread-123", imagePaths: [] });
    expect(args[1]).toBe("resume");
    expect(args[2]).toBe("thread-123");
  });

  it("includes model when not resuming", () => {
    const args = buildCodexArgs("safe", { ...base, model: "gpt-4" });
    expect(args).toContain("--model");
    expect(args[args.indexOf("--model") + 1]).toBe("gpt-4");
  });

  it("excludes model when resuming", () => {
    const args = buildCodexArgs("safe", { resuming: true, threadId: "t1", model: "gpt-4", imagePaths: [] });
    expect(args).not.toContain("--model");
  });

  it("includes image paths via -i flags", () => {
    const args = buildCodexArgs("safe", { ...base, imagePaths: ["/tmp/a.png", "/tmp/b.jpg"] });
    const iIndexes = args.reduce<number[]>((acc, v, i) => (v === "-i" ? [...acc, i] : acc), []);
    expect(iIndexes).toHaveLength(2);
    expect(args[iIndexes[0]! + 1]).toBe("/tmp/a.png");
    expect(args[iIndexes[1]! + 1]).toBe("/tmp/b.jpg");
  });
});

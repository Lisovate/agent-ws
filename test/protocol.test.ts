import { describe, it, expect } from "vitest";
import {
  parseClientMessage,
  serializeMessage,
  isLegacyPrompt,
  adaptLegacyMessage,
  type AgentMessage,
} from "../src/server/protocol.js";

describe("parseClientMessage", () => {
  it("parses a valid prompt message", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "Hello Claude",
        requestId: "req-1",
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legacy).toBe(false);
    expect(result.message).toEqual({
      type: "prompt",
      prompt: "Hello Claude",
      requestId: "req-1",
      model: undefined,
      systemPrompt: undefined,
      projectId: undefined,
      provider: "claude",
    });
  });

  it("parses a prompt message with model", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "Hello",
        requestId: "req-2",
        model: "opus",
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual({
      type: "prompt",
      prompt: "Hello",
      requestId: "req-2",
      model: "opus",
      systemPrompt: undefined,
      projectId: undefined,
      provider: "claude",
    });
  });

  it("parses a cancel message", () => {
    const result = parseClientMessage(JSON.stringify({ type: "cancel" }));

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual({ type: "cancel", requestId: undefined });
  });

  it("parses a cancel message with requestId", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "cancel", requestId: "req-1" })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message).toEqual({ type: "cancel", requestId: "req-1" });
  });

  it("rejects invalid JSON", () => {
    const result = parseClientMessage("not json");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Invalid JSON");
  });

  it("rejects non-object JSON", () => {
    const result = parseClientMessage('"just a string"');
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Message must be a JSON object");
  });

  it("rejects arrays", () => {
    const result = parseClientMessage("[1, 2, 3]");
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Message must be a JSON object");
  });

  it("rejects missing type field", () => {
    const result = parseClientMessage(JSON.stringify({ prompt: "hello" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Missing or invalid 'type' field");
  });

  it("rejects unknown message type", () => {
    const result = parseClientMessage(JSON.stringify({ type: "unknown" }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Unknown message type: unknown");
  });

  it("rejects prompt with empty prompt field", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "", requestId: "r1" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Missing or empty 'prompt' field");
  });

  it("rejects prompt without requestId", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("Missing or empty 'requestId' field");
  });

  it("rejects oversized prompts", () => {
    const bigPrompt = "x".repeat(512 * 1024 + 1);
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: bigPrompt, requestId: "r1" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/exceeds maximum size/);
  });
});

describe("legacy message detection", () => {
  it("detects legacy prompt with content field", () => {
    const data = { type: "prompt", content: "hello", projectId: "p1" } as Record<string, unknown>;
    expect(isLegacyPrompt(data)).toBe(true);
  });

  it("does not flag new format as legacy", () => {
    const data = { type: "prompt", prompt: "hello", requestId: "r1" } as Record<string, unknown>;
    expect(isLegacyPrompt(data)).toBe(false);
  });

  it("does not flag cancel as legacy", () => {
    const data = { type: "cancel" } as Record<string, unknown>;
    expect(isLegacyPrompt(data)).toBe(false);
  });
});

describe("adaptLegacyMessage", () => {
  it("adapts legacy message to new format", () => {
    const adapted = adaptLegacyMessage({
      type: "prompt",
      content: "hello from old client",
      projectId: "p1",
      files: [],
      images: [],
      model: "opus",
    });

    expect(adapted.type).toBe("prompt");
    expect(adapted.prompt).toBe("hello from old client");
    expect(adapted.model).toBe("opus");
    expect(adapted.requestId).toBeDefined();
    expect(adapted.requestId.length).toBeGreaterThan(0);
  });

  it("handles legacy message without model", () => {
    const adapted = adaptLegacyMessage({
      type: "prompt",
      content: "hello",
    });

    expect(adapted.model).toBeUndefined();
  });
});

describe("parseClientMessage with legacy format", () => {
  it("parses legacy prompt and marks as legacy", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        content: "hello old world",
        projectId: "proj-1",
        files: [{ path: "a.tsx", content: "code" }],
        model: "sonnet",
      })
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.legacy).toBe(true);
    expect(result.message.type).toBe("prompt");
    if (result.message.type !== "prompt") return;
    expect(result.message.prompt).toBe("hello old world");
    expect(result.message.model).toBe("sonnet");
  });
});

describe("serializeMessage", () => {
  it("serializes a connected message", () => {
    const msg: AgentMessage = { type: "connected", version: "1.0", agent: "agent-ws" };
    const serialized = serializeMessage(msg);
    expect(JSON.parse(serialized)).toEqual(msg);
  });

  it("serializes a chunk message", () => {
    const msg: AgentMessage = { type: "chunk", content: "hello", requestId: "r1" };
    expect(JSON.parse(serializeMessage(msg))).toEqual(msg);
  });

  it("serializes a complete message", () => {
    const msg: AgentMessage = { type: "complete", requestId: "r1" };
    expect(JSON.parse(serializeMessage(msg))).toEqual(msg);
  });

  it("serializes an error message", () => {
    const msg: AgentMessage = { type: "error", message: "oops", requestId: "r1" };
    expect(JSON.parse(serializeMessage(msg))).toEqual(msg);
  });
});

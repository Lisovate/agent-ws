import {
  parseClientMessage,
  serializeMessage,
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
    expect(result.message).toEqual({
      type: "prompt",
      prompt: "Hello Claude",
      requestId: "req-1",
      model: undefined,
      systemPrompt: undefined,
      projectId: undefined,
      provider: "claude",
      thinkingTokens: undefined,
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
      thinkingTokens: undefined,
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

  it("rejects oversized systemPrompt", () => {
    const bigSystem = "x".repeat(64 * 1024 + 1);
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", systemPrompt: bigSystem })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/System prompt exceeds maximum size/);
  });

  it("accepts valid systemPrompt within limit", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", systemPrompt: "Be helpful" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.systemPrompt).toBe("Be helpful");
  });

  it("rejects projectId exceeding max length", () => {
    const longId = "a".repeat(129);
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", projectId: longId })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/projectId exceeds maximum length/);
  });

  it("rejects projectId with invalid characters", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", projectId: "../etc" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/projectId contains invalid characters/);
  });

  it("rejects projectId with spaces", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", projectId: "my project" })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/projectId contains invalid characters/);
  });

  it("accepts valid projectId with allowed characters", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", projectId: "my-app_v2.0" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.projectId).toBe("my-app_v2.0");
  });

  it("parses thinkingTokens when valid number", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", thinkingTokens: 2048 })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.thinkingTokens).toBe(2048);
  });

  it("accepts thinkingTokens of zero (disables thinking)", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", thinkingTokens: 0 })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.thinkingTokens).toBe(0);
  });

  it("ignores negative thinkingTokens", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", thinkingTokens: -1 })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.thinkingTokens).toBeUndefined();
  });

  it("ignores non-number thinkingTokens", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", thinkingTokens: "lots" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.thinkingTokens).toBeUndefined();
  });

  it("defaults provider to claude when not specified", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.provider).toBe("claude");
  });

  it("accepts codex as provider", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", provider: "codex" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.provider).toBe("codex");
  });

  it("defaults unknown provider to claude", () => {
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hello", requestId: "r1", provider: "gemini" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.provider).toBe("claude");
  });

  it("truncates long unknown message types in error", () => {
    const longType = "x".repeat(100);
    const result = parseClientMessage(JSON.stringify({ type: longType }));
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe(`Unknown message type: ${"x".repeat(50)}`);
  });

  it("parses valid images", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "describe this",
        requestId: "r1",
        images: [{ media_type: "image/png", data: "iVBOR" }],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.images).toEqual([
      { media_type: "image/png", data: "iVBOR" },
    ]);
  });

  it("accepts all supported image types", () => {
    for (const type of ["image/png", "image/jpeg", "image/gif", "image/webp"]) {
      const result = parseClientMessage(
        JSON.stringify({
          type: "prompt",
          prompt: "hi",
          requestId: "r1",
          images: [{ media_type: type, data: "AAAA" }],
        })
      );
      expect(result.ok).toBe(true);
    }
  });

  it("rejects unsupported image media_type", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        images: [{ media_type: "image/bmp", data: "AAAA" }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unsupported image type/);
  });

  it("rejects path-traversal media_type", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        images: [{ media_type: "image/../../etc/passwd", data: "AAAA" }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Unsupported image type/);
  });

  it("rejects too many images", () => {
    const images = Array.from({ length: 5 }, () => ({
      media_type: "image/png",
      data: "AAAA",
    }));
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hi", requestId: "r1", images })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Too many images/);
  });

  it("rejects oversized image data", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        images: [{ media_type: "image/png", data: "x".repeat(10 * 1024 * 1024 + 1) }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Image exceeds maximum size/);
  });

  it("rejects image with missing fields", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        images: [{ media_type: "image/png" }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/must have string media_type and data/);
  });

  it("rejects non-object image items", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        images: ["not-an-object"],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Each image must be an object/);
  });

  it("ignores empty images array", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        images: [],
      })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.images).toBeUndefined();
  });

  it("rejects more than 100 files", () => {
    const files = Array.from({ length: 101 }, (_, i) => ({
      path: `file-${i}.txt`,
      content: "x",
    }));
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hi", requestId: "r1", files })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Too many files/);
  });

  it("rejects files exceeding 50MB total", () => {
    // Each file ~10MB, 6 files = 60MB > 50MB limit
    const files = Array.from({ length: 6 }, (_, i) => ({
      path: `file-${i}.txt`,
      content: "x".repeat(10 * 1024 * 1024),
    }));
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hi", requestId: "r1", files })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toMatch(/Total file content exceeds maximum size/);
  });

  it("rejects file with empty path", () => {
    const result = parseClientMessage(
      JSON.stringify({
        type: "prompt",
        prompt: "hi",
        requestId: "r1",
        files: [{ path: "", content: "data" }],
      })
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("File path must not be empty");
  });

  it("accepts files within limits", () => {
    const files = [
      { path: "src/App.tsx", content: "export default function App() {}" },
      { path: "src/index.ts", content: "import App from './App';" },
    ];
    const result = parseClientMessage(
      JSON.stringify({ type: "prompt", prompt: "hi", requestId: "r1", files })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.message.type === "prompt" && result.message.files).toEqual(files);
  });
});

describe("serializeMessage", () => {
  it("serializes a connected message", () => {
    const msg: AgentMessage = { type: "connected", version: "1.0", agent: "agent-ws", mode: "safe" };
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

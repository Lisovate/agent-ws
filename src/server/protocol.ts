// Maximum prompt size: 512KB
const MAX_PROMPT_BYTES = 512 * 1024;

// --- Client → Agent messages ---

export interface PromptMessage {
  type: "prompt";
  prompt: string;
  model?: string;
  systemPrompt?: string;
  projectId?: string;
  requestId: string;
  provider?: "claude" | "codex";
}

export interface CancelMessage {
  type: "cancel";
  requestId?: string;
}

export type ClientMessage = PromptMessage | CancelMessage;

// --- Agent → Client messages ---

export interface ConnectedMessage {
  type: "connected";
  version: string;
  agent: string;
}

export interface ChunkMessage {
  type: "chunk";
  content: string;
  requestId: string;
}

export interface CompleteMessage {
  type: "complete";
  requestId: string;
}

export interface ErrorMessage {
  type: "error";
  message: string;
  requestId?: string;
}

export type AgentMessage =
  | ConnectedMessage
  | ChunkMessage
  | CompleteMessage
  | ErrorMessage;

// --- Legacy format detection ---

interface LegacyPromptMessage {
  type: "prompt";
  content: string;
  projectId?: string;
  files?: unknown[];
  images?: unknown[];
  model?: string;
}

export function isLegacyPrompt(data: Record<string, unknown>): boolean {
  return (
    data["type"] === "prompt" &&
    typeof data["content"] === "string" &&
    !("prompt" in data)
  );
}

export function adaptLegacyMessage(data: Record<string, unknown>): PromptMessage {
  return {
    type: "prompt",
    prompt: data["content"] as string,
    model: typeof data["model"] === "string" ? data["model"] : undefined,
    requestId: crypto.randomUUID(),
  };
}

// --- Parsing & validation ---

export type ParseResult =
  | { ok: true; message: ClientMessage; legacy: boolean }
  | { ok: false; error: string };

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;

  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, error: "Invalid JSON" };
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, error: "Message must be a JSON object" };
  }

  const obj = data as Record<string, unknown>;
  const type = obj["type"];

  if (typeof type !== "string") {
    return { ok: false, error: "Missing or invalid 'type' field" };
  }

  switch (type) {
    case "prompt": {
      // Check legacy format first
      if (isLegacyPrompt(obj)) {
        return {
          ok: true,
          message: adaptLegacyMessage(obj),
          legacy: true,
        };
      }

      const prompt = obj["prompt"];
      if (typeof prompt !== "string" || prompt.length === 0) {
        return { ok: false, error: "Missing or empty 'prompt' field" };
      }

      if (new TextEncoder().encode(prompt).byteLength > MAX_PROMPT_BYTES) {
        return { ok: false, error: `Prompt exceeds maximum size of ${MAX_PROMPT_BYTES} bytes` };
      }

      const requestId = obj["requestId"];
      if (typeof requestId !== "string" || requestId.length === 0) {
        return { ok: false, error: "Missing or empty 'requestId' field" };
      }

      const model = obj["model"];
      const systemPrompt = obj["systemPrompt"];
      const projectId = obj["projectId"];
      const provider = obj["provider"];

      return {
        ok: true,
        message: {
          type: "prompt",
          prompt,
          model: typeof model === "string" ? model : undefined,
          systemPrompt: typeof systemPrompt === "string" ? systemPrompt : undefined,
          projectId: typeof projectId === "string" ? projectId : undefined,
          requestId,
          provider: provider === "codex" ? "codex" : "claude",
        },
        legacy: false,
      };
    }

    case "cancel": {
      const requestId = obj["requestId"];
      return {
        ok: true,
        message: {
          type: "cancel",
          requestId: typeof requestId === "string" ? requestId : undefined,
        },
        legacy: false,
      };
    }

    default:
      return { ok: false, error: `Unknown message type: ${type}` };
  }
}

// --- Serialization ---

export function serializeMessage(message: AgentMessage): string {
  return JSON.stringify(message);
}

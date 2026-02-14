// Maximum prompt size: 512KB
const MAX_PROMPT_BYTES = 512 * 1024;
// Maximum system prompt size: 64KB
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
// Maximum images per message
const MAX_IMAGES = 4;
// Maximum single image size: 10MB base64
const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
// Allowed image MIME types
const ALLOWED_IMAGE_TYPES = new Set([
  "image/png", "image/jpeg", "image/gif", "image/webp",
]);
// Maximum projectId length
const MAX_PROJECT_ID_LENGTH = 128;
// Allowed projectId characters: alphanumeric, hyphens, underscores, dots
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;

// --- Client → Agent messages ---

export interface PromptImage {
  media_type: string;
  data: string; // base64-encoded
}

export interface PromptMessage {
  type: "prompt";
  prompt: string;
  model?: string;
  systemPrompt?: string;
  projectId?: string;
  requestId: string;
  provider?: "claude" | "codex";
  thinkingTokens?: number;
  images?: PromptImage[];
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
  thinking?: boolean;
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

// --- Parsing & validation ---

export type ParseResult =
  | { ok: true; message: ClientMessage }
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
      const thinkingTokens = obj["thinkingTokens"];

      if (typeof systemPrompt === "string" && new TextEncoder().encode(systemPrompt).byteLength > MAX_SYSTEM_PROMPT_BYTES) {
        return { ok: false, error: `System prompt exceeds maximum size of ${MAX_SYSTEM_PROMPT_BYTES} bytes` };
      }

      if (typeof projectId === "string") {
        if (projectId.length > MAX_PROJECT_ID_LENGTH) {
          return { ok: false, error: `projectId exceeds maximum length of ${MAX_PROJECT_ID_LENGTH}` };
        }
        if (!PROJECT_ID_PATTERN.test(projectId)) {
          return { ok: false, error: "projectId contains invalid characters (allowed: alphanumeric, hyphens, underscores, dots)" };
        }
      }

      // Parse images (optional array of { media_type, data })
      let parsedImages: PromptImage[] | undefined;
      const rawImages = obj["images"];
      if (Array.isArray(rawImages) && rawImages.length > 0) {
        if (rawImages.length > MAX_IMAGES) {
          return { ok: false, error: `Too many images (max ${MAX_IMAGES})` };
        }
        parsedImages = [];
        for (const img of rawImages) {
          if (typeof img !== "object" || img === null) {
            return { ok: false, error: "Each image must be an object with media_type and data" };
          }
          const imgObj = img as Record<string, unknown>;
          if (typeof imgObj["media_type"] !== "string" || typeof imgObj["data"] !== "string") {
            return { ok: false, error: "Each image must have string media_type and data fields" };
          }
          if (!ALLOWED_IMAGE_TYPES.has(imgObj["media_type"])) {
            return { ok: false, error: `Unsupported image type: ${String(imgObj["media_type"]).slice(0, 50)} (allowed: png, jpeg, gif, webp)` };
          }
          if (imgObj["data"].length > MAX_IMAGE_BASE64_BYTES) {
            return { ok: false, error: `Image exceeds maximum size of ${MAX_IMAGE_BASE64_BYTES} bytes` };
          }
          parsedImages.push({ media_type: imgObj["media_type"], data: imgObj["data"] });
        }
      }

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
          thinkingTokens: typeof thinkingTokens === "number" && thinkingTokens >= 0 ? thinkingTokens : undefined,
          images: parsedImages,
        },
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
      };
    }

    default:
      return { ok: false, error: `Unknown message type: ${String(type).slice(0, 50)}` };
  }
}

// --- Serialization ---

export function serializeMessage(message: AgentMessage): string {
  return JSON.stringify(message);
}

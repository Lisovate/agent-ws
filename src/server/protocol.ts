// Maximum prompt size: 512KB
const MAX_PROMPT_BYTES = 512 * 1024;
// Maximum system prompt size: 64KB
const MAX_SYSTEM_PROMPT_BYTES = 64 * 1024;
// Maximum images per message
const MAX_IMAGES = 4;
// Maximum single image size: 10MB base64
const MAX_IMAGE_BASE64_BYTES = 10 * 1024 * 1024;
const ALLOWED_IMAGE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
// Maximum requestId length
const MAX_REQUEST_ID_LENGTH = 256;
// Maximum projectId length
const MAX_PROJECT_ID_LENGTH = 128;
// Allowed projectId characters: alphanumeric, hyphens, underscores, dots
const PROJECT_ID_PATTERN = /^[a-zA-Z0-9._-]+$/;
// Maximum files per message
export const MAX_FILES = 100;
// Maximum total file content size: 50MB
export const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;

const VALID_PROVIDERS = new Set<string>(["claude", "codex"]);
const encoder = new TextEncoder();

export type PermissionMode = "safe" | "agentic" | "unrestricted";

// --- Client → Agent messages ---

export interface PromptImage {
  media_type: string;
  data: string; // base64-encoded
}

export interface PromptFile {
  path: string;
  content: string;
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
  files?: PromptFile[];
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
  mode: PermissionMode;
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

export interface ToolEventMessage {
  type: "tool_event";
  requestId: string;
  event: "start" | "complete";
  toolName?: string;
  toolId?: string;
  input?: Record<string, unknown>;
}

export interface FileChangeMessage {
  type: "file_change";
  requestId: string;
  path: string;
  changeType: "create" | "update" | "delete";
  content?: string;
}

export type AgentMessage =
  | ConnectedMessage
  | ChunkMessage
  | CompleteMessage
  | ErrorMessage
  | ToolEventMessage
  | FileChangeMessage;

// --- Parsing & validation ---

export type ParseResult =
  | { ok: true; message: ClientMessage }
  | { ok: false; error: string };

const err = (error: string): ParseResult => ({ ok: false, error });
const truncate = (s: string, n = 50) => s.length > n ? s.slice(0, n) : s;
const byteLength = (s: string) => encoder.encode(s).byteLength;

export function parseClientMessage(raw: string): ParseResult {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return err("Invalid JSON");
  }

  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return err("Message must be a JSON object");
  }

  const obj = data as Record<string, unknown>;
  const type = obj["type"];
  if (typeof type !== "string") return err("Missing or invalid 'type' field");

  if (type === "prompt") return parsePromptMessage(obj);
  if (type === "cancel") {
    const requestId = obj["requestId"];
    return {
      ok: true,
      message: { type: "cancel", requestId: typeof requestId === "string" ? requestId : undefined },
    };
  }
  return err(`Unknown message type: ${truncate(type)}`);
}

function parsePromptMessage(obj: Record<string, unknown>): ParseResult {
  const prompt = obj["prompt"];
  if (typeof prompt !== "string" || prompt.length === 0) {
    return err("Missing or empty 'prompt' field");
  }
  if (byteLength(prompt) > MAX_PROMPT_BYTES) {
    return err(`Prompt exceeds maximum size of ${MAX_PROMPT_BYTES} bytes`);
  }

  const requestId = obj["requestId"];
  if (typeof requestId !== "string" || requestId.length === 0) {
    return err("Missing or empty 'requestId' field");
  }
  if (requestId.length > MAX_REQUEST_ID_LENGTH) {
    return err(`requestId exceeds maximum length of ${MAX_REQUEST_ID_LENGTH}`);
  }

  const systemPrompt = obj["systemPrompt"];
  if (typeof systemPrompt === "string" && byteLength(systemPrompt) > MAX_SYSTEM_PROMPT_BYTES) {
    return err(`System prompt exceeds maximum size of ${MAX_SYSTEM_PROMPT_BYTES} bytes`);
  }

  const projectId = obj["projectId"];
  if (typeof projectId === "string") {
    if (projectId.length > MAX_PROJECT_ID_LENGTH) {
      return err(`projectId exceeds maximum length of ${MAX_PROJECT_ID_LENGTH}`);
    }
    if (!PROJECT_ID_PATTERN.test(projectId)) {
      return err("projectId contains invalid characters (allowed: alphanumeric, hyphens, underscores, dots)");
    }
  }

  const imagesResult = parseImages(obj["images"]);
  if (!imagesResult.ok) return err(imagesResult.error);

  const filesResult = parseFiles(obj["files"]);
  if (!filesResult.ok) return err(filesResult.error);

  const provider = obj["provider"];
  let validatedProvider: "claude" | "codex" = "claude";
  if (typeof provider === "string" && provider.length > 0) {
    if (!VALID_PROVIDERS.has(provider)) {
      return err(`Unknown provider: ${truncate(provider)} (allowed: claude, codex)`);
    }
    validatedProvider = provider as "claude" | "codex";
  }

  const model = obj["model"];
  const thinkingTokens = obj["thinkingTokens"];

  return {
    ok: true,
    message: {
      type: "prompt",
      prompt,
      requestId,
      provider: validatedProvider,
      model: typeof model === "string" ? model : undefined,
      systemPrompt: typeof systemPrompt === "string" ? systemPrompt : undefined,
      projectId: typeof projectId === "string" ? projectId : undefined,
      thinkingTokens: typeof thinkingTokens === "number" && thinkingTokens >= 0 ? thinkingTokens : undefined,
      images: imagesResult.value,
      files: filesResult.value,
    },
  };
}

type FieldResult<T> = { ok: true; value: T | undefined } | { ok: false; error: string };

function parseImages(raw: unknown): FieldResult<PromptImage[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: true, value: undefined };
  if (raw.length > MAX_IMAGES) return { ok: false, error: `Too many images (max ${MAX_IMAGES})` };

  const images: PromptImage[] = [];
  for (const img of raw) {
    if (typeof img !== "object" || img === null) {
      return { ok: false, error: "Each image must be an object with media_type and data" };
    }
    const o = img as Record<string, unknown>;
    if (typeof o["media_type"] !== "string" || typeof o["data"] !== "string") {
      return { ok: false, error: "Each image must have string media_type and data fields" };
    }
    if (!ALLOWED_IMAGE_TYPES.has(o["media_type"])) {
      return { ok: false, error: `Unsupported image type: ${truncate(o["media_type"])} (allowed: png, jpeg, gif, webp)` };
    }
    if (byteLength(o["data"]) > MAX_IMAGE_BASE64_BYTES) {
      return { ok: false, error: `Image exceeds maximum size of ${MAX_IMAGE_BASE64_BYTES} bytes` };
    }
    images.push({ media_type: o["media_type"], data: o["data"] });
  }
  return { ok: true, value: images };
}

function parseFiles(raw: unknown): FieldResult<PromptFile[]> {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: true, value: undefined };
  if (raw.length > MAX_FILES) return { ok: false, error: `Too many files (max ${MAX_FILES})` };

  const files: PromptFile[] = [];
  let totalBytes = 0;
  for (const f of raw) {
    if (typeof f !== "object" || f === null) {
      return { ok: false, error: "Each file must be an object with path and content" };
    }
    const o = f as Record<string, unknown>;
    if (typeof o["path"] !== "string" || typeof o["content"] !== "string") {
      return { ok: false, error: "Each file must have string path and content fields" };
    }
    if (o["path"].length === 0) {
      return { ok: false, error: "File path must not be empty" };
    }
    totalBytes += byteLength(o["content"]);
    if (totalBytes > MAX_TOTAL_FILE_BYTES) {
      return { ok: false, error: `Total file content exceeds maximum size of ${MAX_TOTAL_FILE_BYTES} bytes` };
    }
    files.push({ path: o["path"], content: o["content"] });
  }
  return { ok: true, value: files };
}

// --- Serialization ---

export function serializeMessage(message: AgentMessage): string {
  return JSON.stringify(message);
}

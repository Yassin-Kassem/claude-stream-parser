// ─── Shared primitives ────────────────────────────────────────────────────────

export type StopReason = "end_turn" | "max_tokens" | "stop_sequence" | "tool_use";

export interface Usage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
}

export interface OutputUsage {
  output_tokens: number;
}

// ─── Content block shapes (as they appear at block_start) ─────────────────────

export interface TextContentBlock {
  type: "text";
  text: string;
}

export interface ToolUseContentBlock {
  type: "tool_use";
  id: string;
  name: string;
  input: Record<string, unknown>;
}

export interface ThinkingContentBlock {
  type: "thinking";
  thinking: string;
}

export type ContentBlock =
  | TextContentBlock
  | ToolUseContentBlock
  | ThinkingContentBlock;

// ─── Delta shapes (carried by content_block_delta) ───────────────────────────

export interface TextDelta {
  type: "text_delta";
  text: string;
}

export interface InputJsonDelta {
  type: "input_json_delta";
  partial_json: string;
}

export interface ThinkingDelta {
  type: "thinking_delta";
  thinking: string;
}

export interface SignatureDelta {
  type: "signature_delta";
  signature: string;
}

export type Delta = TextDelta | InputJsonDelta | ThinkingDelta | SignatureDelta;

// ─── Message shape (as it appears in message_start) ──────────────────────────

export interface StreamMessage {
  id: string;
  type: "message";
  role: "assistant";
  model: string;
  content: ContentBlock[];
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage;
}

// ─── Individual SSE event types ───────────────────────────────────────────────

export interface MessageStartEvent {
  type: "message_start";
  message: StreamMessage;
}

export interface ContentBlockStartEvent {
  type: "content_block_start";
  index: number;
  content_block: ContentBlock;
}

export interface ContentBlockDeltaEvent {
  type: "content_block_delta";
  index: number;
  delta: Delta;
}

export interface ContentBlockStopEvent {
  type: "content_block_stop";
  index: number;
}

export interface MessageDeltaEvent {
  type: "message_delta";
  delta: {
    stop_reason: StopReason | null;
    stop_sequence: string | null;
  };
  usage: OutputUsage;
}

export interface MessageStopEvent {
  type: "message_stop";
}

export interface PingEvent {
  type: "ping";
}

export type ErrorType =
  | "api_error"
  | "authentication_error"
  | "invalid_request_error"
  | "not_found_error"
  | "overloaded_error"
  | "permission_error"
  | "rate_limit_error"
  | "request_too_large";

export interface StreamErrorEvent {
  type: "error";
  error: {
    type: ErrorType;
    message: string;
  };
}

// ─── Union of all possible events ─────────────────────────────────────────────

export type ClaudeStreamEvent =
  | MessageStartEvent
  | ContentBlockStartEvent
  | ContentBlockDeltaEvent
  | ContentBlockStopEvent
  | MessageDeltaEvent
  | MessageStopEvent
  | PingEvent
  | StreamErrorEvent;

// ─── Accumulated / derived types for higher-level usage ──────────────────────

/** A fully assembled text block after all deltas have been applied. */
export interface AccumulatedTextBlock {
  type: "text";
  index: number;
  text: string;
}

/** A fully assembled tool call once input_json is complete. */
export interface AccumulatedToolUseBlock {
  type: "tool_use";
  index: number;
  id: string;
  name: string;
  /** Parsed JSON input. Only available after the block closes. */
  input: Record<string, unknown>;
}

/** A fully assembled thinking block. */
export interface AccumulatedThinkingBlock {
  type: "thinking";
  index: number;
  thinking: string;
}

export type AccumulatedBlock =
  | AccumulatedTextBlock
  | AccumulatedToolUseBlock
  | AccumulatedThinkingBlock;

/** The final assembled message, identical in shape to a non-streaming response. */
export interface AccumulatedMessage {
  id: string;
  role: "assistant";
  model: string;
  stop_reason: StopReason | null;
  stop_sequence: string | null;
  usage: Usage & OutputUsage;
  content: AccumulatedBlock[];
}

export interface StreamCallbacks {
  onText?: (text: string, blockIndex: number) => void;
  onToolUse?: (id: string, name: string, input: Record<string, unknown>) => void;
  onEvent?: (event: ClaudeStreamEvent) => void;
  onDone?: (message: AccumulatedMessage) => void;
}

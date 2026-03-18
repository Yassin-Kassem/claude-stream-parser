// Types
export type {
  // Events
  ClaudeStreamEvent,
  MessageStartEvent,
  ContentBlockStartEvent,
  ContentBlockDeltaEvent,
  ContentBlockStopEvent,
  MessageDeltaEvent,
  MessageStopEvent,
  PingEvent,
  StreamErrorEvent,
  // Deltas
  Delta,
  TextDelta,
  InputJsonDelta,
  ThinkingDelta,
  SignatureDelta,
  // Content blocks
  ContentBlock,
  TextContentBlock,
  ToolUseContentBlock,
  ThinkingContentBlock,
  // Accumulated
  AccumulatedMessage,
  AccumulatedBlock,
  AccumulatedTextBlock,
  AccumulatedToolUseBlock,
  AccumulatedThinkingBlock,
  // Misc
  Usage,
  StopReason,
  ErrorType,
  StreamCallbacks,
} from "./types/events.js";

// Core parser utilities
export { parseSSEBlock, splitSSEBlocks } from "./parser.js";

// Accumulator
export { MessageAccumulator } from "./accumulator.js";

// High-level stream functions
export {
  parseStream,
  streamText,
  streamToolInput,
  streamToMessage,
  streamWithCallbacks,
  ClaudeStreamError,
} from "./stream.js";

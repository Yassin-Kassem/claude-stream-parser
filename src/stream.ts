import { parseSSEBlock, splitSSEBlocks } from "./parser.js";
import { MessageAccumulator } from "./accumulator.js";
import type {
  ClaudeStreamEvent,
  AccumulatedMessage,
  StreamCallbacks,
  StreamErrorEvent,
} from "./types/events.js";

// ─── Error class ──────────────────────────────────────────────────────────────

export class ClaudeStreamError extends Error {
  readonly errorType: StreamErrorEvent["error"]["type"];

  constructor(event: StreamErrorEvent) {
    super(event.error.message);
    this.name = "ClaudeStreamError";
    this.errorType = event.error.type;
  }
}

// ─── Core: parse a ReadableStream into typed events ───────────────────────────

/**
 * Parses a `ReadableStream<Uint8Array>` (e.g. from a raw `fetch` response body)
 * into an async iterable of typed `ClaudeStreamEvent` objects.
 *
 * Throws `ClaudeStreamError` if an `error` event is encountered in the stream.
 *
 * @example
 * ```ts
 * const response = await fetch("https://api.anthropic.com/v1/messages", { ... });
 * for await (const event of parseStream(response.body!)) {
 *   if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
 *     process.stdout.write(event.delta.text);
 *   }
 * }
 * ```
 */
export async function* parseStream(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<ClaudeStreamEvent> {
  const decoder = new TextDecoder();
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      buffer += decoder.decode(value, { stream: true });

      // Split on double newlines — each block is one SSE event
      const blocks = splitSSEBlocks(buffer);

      // The last element might be an incomplete block, keep it in the buffer
      const endsWithBlankLine =
        buffer.endsWith("\n\n") || buffer.endsWith("\r\n\r\n");

      buffer = endsWithBlankLine ? "" : (blocks.pop() ?? "");

      for (const block of blocks) {
        const event = parseSSEBlock(block);
        if (!event) continue;

        if (event.type === "error") {
          throw new ClaudeStreamError(event);
        }

        yield event;
      }
    }

    // Flush remaining buffer
    if (buffer.trim()) {
      const event = parseSSEBlock(buffer);
      if (event) {
        if (event.type === "error") throw new ClaudeStreamError(event);
        yield event;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

// ─── Convenience: stream only text deltas ────────────────────────────────────

/**
 * Yields only the text string from each `text_delta` event.
 * The simplest possible interface for text streaming.
 *
 * @example
 * ```ts
 * for await (const chunk of streamText(response.body!)) {
 *   process.stdout.write(chunk);
 * }
 * ```
 */
export async function* streamText(
  stream: ReadableStream<Uint8Array>
): AsyncGenerator<string> {
  for await (const event of parseStream(stream)) {
    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      yield event.delta.text;
    }
  }
}

// ─── Convenience: stream tool use input JSON deltas ──────────────────────────

/**
 * Yields partial JSON strings for a specific tool call by block index.
 * Useful for streaming tool input display.
 */
export async function* streamToolInput(
  stream: ReadableStream<Uint8Array>,
  blockIndex: number
): AsyncGenerator<string> {
  for await (const event of parseStream(stream)) {
    if (
      event.type === "content_block_delta" &&
      event.index === blockIndex &&
      event.delta.type === "input_json_delta"
    ) {
      yield event.delta.partial_json;
    }
  }
}

// ─── Convenience: accumulate to final message ─────────────────────────────────

/**
 * Consumes the entire stream and returns the fully assembled message,
 * identical in structure to a non-streaming API response.
 *
 * @example
 * ```ts
 * const message = await streamToMessage(response.body!);
 * console.log(message.content[0]); // { type: 'text', text: '...' }
 * ```
 */
export async function streamToMessage(
  stream: ReadableStream<Uint8Array>
): Promise<AccumulatedMessage> {
  const acc = new MessageAccumulator();
  for await (const event of parseStream(stream)) {
    acc.add(event);
  }
  return acc.message();
}

// ─── Convenience: accumulate with live callbacks ──────────────────────────────

/**
 * Streams a response body, calling the provided callbacks as events arrive,
 * and returns the final accumulated message.
 *
 * @example
 * ```ts
 * const message = await streamWithCallbacks(response.body!, {
 *   onText: (t) => process.stdout.write(t),
 *   onToolUse: (id, name, input) => console.log("Tool:", name, input),
 * });
 * ```
 */
export async function streamWithCallbacks(
  stream: ReadableStream<Uint8Array>,
  callbacks: StreamCallbacks
): Promise<AccumulatedMessage> {
  const acc = new MessageAccumulator();

  for await (const event of parseStream(stream)) {
    acc.add(event);
    callbacks.onEvent?.(event);

    if (
      event.type === "content_block_delta" &&
      event.delta.type === "text_delta"
    ) {
      callbacks.onText?.(event.delta.text, event.index);
    }

    if (event.type === "message_stop") {
      const msg = acc.message();
      // fire onToolUse for each tool_use block
      for (const block of msg.content) {
        if (block.type === "tool_use") {
          callbacks.onToolUse?.(block.id, block.name, block.input);
        }
      }
      callbacks.onDone?.(msg);
    }
  }

  return acc.message();
}

import { describe, it, expect } from "vitest";
import { parseSSEBlock, splitSSEBlocks } from "../parser";
import { MessageAccumulator } from "../accumulator";
import {
  parseStream,
  streamText,
  streamToolInput,
  streamToMessage,
  streamWithCallbacks,
  ClaudeStreamError,
} from "../stream";
import type { ClaudeStreamEvent } from "../types/events";

// ─── Helpers ──────────────────────────────────────────────────────────────────

function makeStream(events: ClaudeStreamEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const lines = events
    .map((e) => `event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
    .join("");
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(lines));
      controller.close();
    },
  });
}

const TEXT_STREAM_EVENTS: ClaudeStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_test01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 10, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  { type: "ping" },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Hello" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: ", world" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 12 },
  },
  { type: "message_stop" },
];

const TOOL_USE_EVENTS: ClaudeStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_tool01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_01", name: "get_weather", input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"city":' },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '"Cairo"}' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 25 },
  },
  { type: "message_stop" },
];

// A response with text block at index 0 + tool_use block at index 1
const MIXED_STREAM_EVENTS: ClaudeStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_mixed01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 15, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "text_delta", text: "Let me check the weather." },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_mixed", name: "get_weather", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"loc' },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: 'ation":"Paris"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 40 },
  },
  { type: "message_stop" },
];

// A response with an extended thinking block
const THINKING_STREAM_EVENTS: ClaudeStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_think01",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 5, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "thinking", thinking: "" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: "Let me think" },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "thinking_delta", thinking: " about this..." },
  },
  // signature_delta should be silently ignored, not crash
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "signature_delta", signature: "abc123sig" },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "text", text: "" },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "text_delta", text: "The answer is 42." },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "end_turn", stop_sequence: null },
    usage: { output_tokens: 30 },
  },
  { type: "message_stop" },
];

// A response with two tool calls
const MULTI_TOOL_EVENTS: ClaudeStreamEvent[] = [
  {
    type: "message_start",
    message: {
      id: "msg_multi_tool",
      type: "message",
      role: "assistant",
      model: "claude-sonnet-4-6",
      content: [],
      stop_reason: null,
      stop_sequence: null,
      usage: { input_tokens: 30, output_tokens: 1 },
    },
  },
  {
    type: "content_block_start",
    index: 0,
    content_block: { type: "tool_use", id: "toolu_a", name: "search", input: {} },
  },
  {
    type: "content_block_delta",
    index: 0,
    delta: { type: "input_json_delta", partial_json: '{"q":"cats"}' },
  },
  { type: "content_block_stop", index: 0 },
  {
    type: "content_block_start",
    index: 1,
    content_block: { type: "tool_use", id: "toolu_b", name: "search", input: {} },
  },
  {
    type: "content_block_delta",
    index: 1,
    delta: { type: "input_json_delta", partial_json: '{"q":"dogs"}' },
  },
  { type: "content_block_stop", index: 1 },
  {
    type: "message_delta",
    delta: { stop_reason: "tool_use", stop_sequence: null },
    usage: { output_tokens: 50 },
  },
  { type: "message_stop" },
];

/**
 * Creates a ReadableStream that delivers each SSE event as a separate chunk,
 * simulating realistic network delivery.
 */
function makeChunkedStream(events: ClaudeStreamEvent[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const chunks = events.map((e) =>
    encoder.encode(`event: ${e.type}\ndata: ${JSON.stringify(e)}\n\n`)
  );
  let i = 0;
  return new ReadableStream({
    pull(controller) {
      if (i < chunks.length) controller.enqueue(chunks[i++]!);
      else controller.close();
    },
  });
}

// ─── parseSSEBlock ────────────────────────────────────────────────────────────

describe("parseSSEBlock", () => {
  it("parses a simple ping event", () => {
    const block = 'event: ping\ndata: {"type":"ping"}';
    expect(parseSSEBlock(block)).toEqual({ type: "ping" });
  });

  it("returns null for comment-only lines", () => {
    expect(parseSSEBlock(": ping heartbeat")).toBeNull();
  });

  it("returns null for [DONE] data", () => {
    expect(parseSSEBlock("event: done\ndata: [DONE]")).toBeNull();
  });

  it("parses a text delta event", () => {
    const block =
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}';
    const result = parseSSEBlock(block);
    expect(result?.type).toBe("content_block_delta");
    if (result?.type === "content_block_delta") {
      expect(result.delta.type).toBe("text_delta");
      if (result.delta.type === "text_delta") {
        expect(result.delta.text).toBe("Hi");
      }
    }
  });

  it("returns null for malformed JSON", () => {
    expect(parseSSEBlock("event: test\ndata: {broken")).toBeNull();
  });

  it("parses a block with only a data line (no event: header)", () => {
    const block = 'data: {"type":"ping"}';
    expect(parseSSEBlock(block)).toEqual({ type: "ping" });
  });

  it("falls back to event header when data has no type field", () => {
    const block = 'event: ping\ndata: {"extra":"value"}';
    const result = parseSSEBlock(block);
    expect(result).toEqual({ type: "ping", extra: "value" });
  });

  it("returns null for a block with no data line", () => {
    expect(parseSSEBlock("event: ping")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(parseSSEBlock("")).toBeNull();
  });

  it("handles data line with extra whitespace after colon", () => {
    const block = 'event: ping\ndata:    {"type":"ping"}';
    expect(parseSSEBlock(block)).toEqual({ type: "ping" });
  });

  it("handles CRLF within a single block", () => {
    const block = 'event: ping\r\ndata: {"type":"ping"}';
    // split("\n") will leave \r on the event line, but trim() handles it
    expect(parseSSEBlock(block)).toEqual({ type: "ping" });
  });
});

// ─── splitSSEBlocks ───────────────────────────────────────────────────────────

describe("splitSSEBlocks", () => {
  it("splits blocks on double newline", () => {
    const raw = "event: ping\ndata: {}\n\nevent: ping\ndata: {}\n\n";
    expect(splitSSEBlocks(raw)).toHaveLength(2);
  });

  it("handles CRLF line endings", () => {
    const raw = "event: ping\r\ndata: {}\r\n\r\nevent: ping\r\ndata: {}\r\n\r\n";
    expect(splitSSEBlocks(raw)).toHaveLength(2);
  });

  it("ignores empty input", () => {
    expect(splitSSEBlocks("")).toHaveLength(0);
  });

  it("handles triple newlines (consecutive separators)", () => {
    const raw = "event: ping\ndata: {}\n\n\nevent: ping\ndata: {}\n\n";
    // The middle empty string gets filtered out by .filter(Boolean)
    expect(splitSSEBlocks(raw)).toHaveLength(2);
  });

  it("handles whitespace-only input", () => {
    expect(splitSSEBlocks("   \n\n   ")).toHaveLength(0);
  });
});

// ─── MessageAccumulator ───────────────────────────────────────────────────────

describe("MessageAccumulator", () => {
  it("accumulates a simple text stream", () => {
    const acc = new MessageAccumulator();
    for (const e of TEXT_STREAM_EVENTS) acc.add(e);

    const msg = acc.message();
    expect(msg.id).toBe("msg_test01");
    expect(msg.content).toHaveLength(1);
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type === "text") {
      expect(msg.content[0].text).toBe("Hello, world");
    }
    expect(msg.stop_reason).toBe("end_turn");
    expect(msg.usage.output_tokens).toBe(12);
  });

  it("accumulates tool use with parsed JSON input", () => {
    const acc = new MessageAccumulator();
    for (const e of TOOL_USE_EVENTS) acc.add(e);

    const msg = acc.message();
    expect(msg.content[0]?.type).toBe("tool_use");
    if (msg.content[0]?.type === "tool_use") {
      expect(msg.content[0].name).toBe("get_weather");
      expect(msg.content[0].input).toEqual({ city: "Cairo" });
    }
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("isDone() returns true after message_stop", () => {
    const acc = new MessageAccumulator();
    expect(acc.isDone()).toBe(false);
    for (const e of TEXT_STREAM_EVENTS) acc.add(e);
    expect(acc.isDone()).toBe(true);
  });

  it("returns partial content mid-stream", () => {
    const acc = new MessageAccumulator();
    // Feed only up through the first delta
    for (const e of TEXT_STREAM_EVENTS.slice(0, 4)) acc.add(e);
    const msg = acc.message();
    expect(msg.content[0]?.type).toBe("text");
    if (msg.content[0]?.type === "text") {
      expect(msg.content[0].text).toBe("Hello");
    }
  });

  it("returns safe defaults when called before any events", () => {
    const acc = new MessageAccumulator();
    const msg = acc.message();
    expect(msg.id).toBe("");
    expect(msg.model).toBe("");
    expect(msg.role).toBe("assistant");
    expect(msg.stop_reason).toBeNull();
    expect(msg.content).toHaveLength(0);
    expect(msg.usage.input_tokens).toBe(0);
    expect(msg.usage.output_tokens).toBe(0);
    expect(acc.isDone()).toBe(false);
  });

  it("accumulates a mixed text + tool_use response", () => {
    const acc = new MessageAccumulator();
    for (const e of MIXED_STREAM_EVENTS) acc.add(e);

    const msg = acc.message();
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]?.type).toBe("text");
    expect(msg.content[1]?.type).toBe("tool_use");
    if (msg.content[0]?.type === "text") {
      expect(msg.content[0].text).toBe("Let me check the weather.");
    }
    if (msg.content[1]?.type === "tool_use") {
      expect(msg.content[1].name).toBe("get_weather");
      expect(msg.content[1].input).toEqual({ location: "Paris" });
    }
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("accumulates thinking blocks", () => {
    const acc = new MessageAccumulator();
    for (const e of THINKING_STREAM_EVENTS) acc.add(e);

    const msg = acc.message();
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]?.type).toBe("thinking");
    if (msg.content[0]?.type === "thinking") {
      expect(msg.content[0].thinking).toBe("Let me think about this...");
    }
    expect(msg.content[1]?.type).toBe("text");
    if (msg.content[1]?.type === "text") {
      expect(msg.content[1].text).toBe("The answer is 42.");
    }
  });

  it("silently ignores signature_delta without crashing", () => {
    const acc = new MessageAccumulator();
    // THINKING_STREAM_EVENTS contains a signature_delta
    expect(() => {
      for (const e of THINKING_STREAM_EVENTS) acc.add(e);
    }).not.toThrow();
  });

  it("silently ignores content_block_delta for unknown block index", () => {
    const acc = new MessageAccumulator();
    const orphanDelta: ClaudeStreamEvent = {
      type: "content_block_delta",
      index: 99,
      delta: { type: "text_delta", text: "orphan" },
    };
    // Should not throw — just silently drop it
    expect(() => acc.add(orphanDelta)).not.toThrow();
    expect(acc.message().content).toHaveLength(0);
  });

  it("handles tool_use with malformed JSON gracefully", () => {
    const acc = new MessageAccumulator();
    const events: ClaudeStreamEvent[] = [
      {
        type: "message_start",
        message: {
          id: "msg_bad_json",
          type: "message",
          role: "assistant",
          model: "claude-sonnet-4-6",
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 5, output_tokens: 1 },
        },
      },
      {
        type: "content_block_start",
        index: 0,
        content_block: { type: "tool_use", id: "toolu_bad", name: "test", input: {} },
      },
      {
        type: "content_block_delta",
        index: 0,
        delta: { type: "input_json_delta", partial_json: '{"broken' },
      },
      { type: "content_block_stop", index: 0 },
      {
        type: "message_delta",
        delta: { stop_reason: "tool_use", stop_sequence: null },
        usage: { output_tokens: 10 },
      },
      { type: "message_stop" },
    ];
    for (const e of events) acc.add(e);

    const msg = acc.message();
    // Should return empty input object, not throw
    if (msg.content[0]?.type === "tool_use") {
      expect(msg.content[0].input).toEqual({});
    }
  });

  it("preserves cache token usage fields", () => {
    const acc = new MessageAccumulator();
    const startEvent: ClaudeStreamEvent = {
      type: "message_start",
      message: {
        id: "msg_cache",
        type: "message",
        role: "assistant",
        model: "claude-sonnet-4-6",
        content: [],
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 1,
          cache_creation_input_tokens: 50,
          cache_read_input_tokens: 25,
        },
      },
    };
    acc.add(startEvent);
    const msg = acc.message();
    expect(msg.usage.input_tokens).toBe(100);
    expect(msg.usage.cache_creation_input_tokens).toBe(50);
    expect(msg.usage.cache_read_input_tokens).toBe(25);
  });

  it("returns independent snapshots from successive message() calls", () => {
    const acc = new MessageAccumulator();
    for (const e of TEXT_STREAM_EVENTS.slice(0, 4)) acc.add(e);
    const snap1 = acc.message();

    // Feed remaining events
    for (const e of TEXT_STREAM_EVENTS.slice(4)) acc.add(e);
    const snap2 = acc.message();

    // snap1 should still reflect partial state (usage object was spread-copied)
    expect(snap1.usage.output_tokens).toBe(1);
    expect(snap2.usage.output_tokens).toBe(12);
    expect(snap1.stop_reason).toBeNull();
    expect(snap2.stop_reason).toBe("end_turn");
  });

  it("handles multiple tool calls in one response", () => {
    const acc = new MessageAccumulator();
    for (const e of MULTI_TOOL_EVENTS) acc.add(e);

    const msg = acc.message();
    expect(msg.content).toHaveLength(2);
    if (msg.content[0]?.type === "tool_use") {
      expect(msg.content[0].id).toBe("toolu_a");
      expect(msg.content[0].input).toEqual({ q: "cats" });
    }
    if (msg.content[1]?.type === "tool_use") {
      expect(msg.content[1].id).toBe("toolu_b");
      expect(msg.content[1].input).toEqual({ q: "dogs" });
    }
  });
});

// ─── parseStream ──────────────────────────────────────────────────────────────

describe("parseStream", () => {
  it("yields all events in order", async () => {
    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(makeStream(TEXT_STREAM_EVENTS))) {
      events.push(e);
    }
    // ping should be in there
    expect(events.some((e) => e.type === "ping")).toBe(true);
    expect(events.some((e) => e.type === "message_stop")).toBe(true);
    expect(events.filter((e) => e.type === "content_block_delta")).toHaveLength(2);
  });

  it("throws ClaudeStreamError on error event", async () => {
    const errorEvents: ClaudeStreamEvent[] = [
      {
        type: "error",
        error: { type: "overloaded_error", message: "Service overloaded" },
      },
    ];
    await expect(async () => {
      for await (const _ of parseStream(makeStream(errorEvents))) {
        // should throw before yielding
      }
    }).rejects.toThrow(ClaudeStreamError);
  });

  it("handles chunks split mid-event (chunk boundary inside data line)", async () => {
    // Simulate the network splitting one SSE event across two chunks
    const encoder = new TextEncoder();
    const line = 'event: ping\ndata: {"type":"ping"}\n\n';
    const half = Math.floor(line.length / 2);
    const chunk1 = encoder.encode(line.slice(0, half));
    const chunk2 = encoder.encode(line.slice(half));

    let chunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex === 0) controller.enqueue(chunk1);
        else if (chunkIndex === 1) controller.enqueue(chunk2);
        else controller.close();
        chunkIndex++;
      },
    });

    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(stream)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ping");
  });

  it("handles mixed line endings (\\n\\r\\n separator)", async () => {
    // \n\r\n is matched by the split regex but was missed by the old endsWith check
    const encoder = new TextEncoder();
    const raw = 'event: ping\ndata: {"type":"ping"}\n\r\nevent: ping\ndata: {"type":"ping"}\n\r\n';
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(encoder.encode(raw));
        controller.close();
      },
    });

    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(stream)) events.push(e);
    expect(events).toHaveLength(2);
  });

  it("handles an empty stream (no events)", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.close();
      },
    });
    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(stream)) events.push(e);
    expect(events).toHaveLength(0);
  });

  it("handles byte-at-a-time delivery (worst-case chunking)", async () => {
    const encoder = new TextEncoder();
    const raw = 'event: ping\ndata: {"type":"ping"}\n\n';
    const bytes = encoder.encode(raw);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < bytes.length) {
          controller.enqueue(bytes.slice(i, i + 1));
          i++;
        } else {
          controller.close();
        }
      },
    });

    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(stream)) events.push(e);
    expect(events).toHaveLength(1);
    expect(events[0]?.type).toBe("ping");
  });

  it("preserves ClaudeStreamError properties", async () => {
    const errorEvents: ClaudeStreamEvent[] = [
      {
        type: "error",
        error: { type: "rate_limit_error", message: "Too many requests" },
      },
    ];
    try {
      for await (const _ of parseStream(makeStream(errorEvents))) {
        // should throw
      }
      throw new Error("Should not reach here");
    } catch (err) {
      expect(err).toBeInstanceOf(ClaudeStreamError);
      const e = err as ClaudeStreamError;
      expect(e.errorType).toBe("rate_limit_error");
      expect(e.message).toBe("Too many requests");
      expect(e.name).toBe("ClaudeStreamError");
    }
  });

  it("works with per-event chunked delivery", async () => {
    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(makeChunkedStream(TEXT_STREAM_EVENTS))) {
      events.push(e);
    }
    expect(events).toHaveLength(TEXT_STREAM_EVENTS.length);
    expect(events[0]?.type).toBe("message_start");
    expect(events[events.length - 1]?.type).toBe("message_stop");
  });

  it("handles multi-byte UTF-8 characters (emoji) split across chunk boundaries", async () => {
    // 😀 is U+1F600 → 4 bytes: F0 9F 98 80
    const emoji = "😀";
    const payload = JSON.stringify({
      type: "content_block_delta",
      index: 0,
      delta: { type: "text_delta", text: emoji },
    });
    const full = `event: content_block_delta\ndata: ${payload}\n\n`;
    const bytes = new TextEncoder().encode(full);

    // Split in the middle of the emoji bytes
    const splitAt = full.indexOf(emoji);
    const chunk1 = bytes.slice(0, splitAt + 2); // cuts emoji mid-sequence
    const chunk2 = bytes.slice(splitAt + 2);

    let chunkIndex = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (chunkIndex === 0) controller.enqueue(chunk1);
        else if (chunkIndex === 1) controller.enqueue(chunk2);
        else controller.close();
        chunkIndex++;
      },
    });

    const events: ClaudeStreamEvent[] = [];
    for await (const e of parseStream(stream)) events.push(e);
    expect(events).toHaveLength(1);
    const e = events[0];
    if (e?.type === "content_block_delta" && e.delta.type === "text_delta") {
      expect(e.delta.text).toBe(emoji);
    } else {
      throw new Error("Expected a text_delta event");
    }
  });
});

// ─── streamText ───────────────────────────────────────────────────────────────

describe("streamText", () => {
  it("yields only text strings", async () => {
    const chunks: string[] = [];
    for await (const t of streamText(makeStream(TEXT_STREAM_EVENTS))) {
      chunks.push(t);
    }
    expect(chunks).toEqual(["Hello", ", world"]);
  });

  it("ignores tool_use deltas — yields nothing for tool-only streams", async () => {
    const chunks: string[] = [];
    for await (const t of streamText(makeStream(TOOL_USE_EVENTS))) {
      chunks.push(t);
    }
    expect(chunks).toHaveLength(0);
  });

  it("yields only text from a mixed text+tool response", async () => {
    const chunks: string[] = [];
    for await (const t of streamText(makeStream(MIXED_STREAM_EVENTS))) {
      chunks.push(t);
    }
    expect(chunks).toEqual(["Let me check the weather."]);
  });

  it("yields nothing for an empty stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const chunks: string[] = [];
    for await (const t of streamText(stream)) chunks.push(t);
    expect(chunks).toHaveLength(0);
  });
});

// ─── streamToolInput ─────────────────────────────────────────────────────────

describe("streamToolInput", () => {
  it("yields partial JSON for a tool_use block at the given index", async () => {
    const parts: string[] = [];
    for await (const p of streamToolInput(makeStream(TOOL_USE_EVENTS), 0)) {
      parts.push(p);
    }
    expect(parts).toEqual(['{"city":', '"Cairo"}']);
    expect(JSON.parse(parts.join(""))).toEqual({ city: "Cairo" });
  });

  it("yields nothing when blockIndex does not match any tool block", async () => {
    const parts: string[] = [];
    for await (const p of streamToolInput(makeStream(TOOL_USE_EVENTS), 99)) {
      parts.push(p);
    }
    expect(parts).toHaveLength(0);
  });

  it("picks the correct tool from a multi-tool response", async () => {
    const partsA: string[] = [];
    for await (const p of streamToolInput(makeStream(MULTI_TOOL_EVENTS), 0)) {
      partsA.push(p);
    }
    expect(JSON.parse(partsA.join(""))).toEqual({ q: "cats" });

    const partsB: string[] = [];
    for await (const p of streamToolInput(makeStream(MULTI_TOOL_EVENTS), 1)) {
      partsB.push(p);
    }
    expect(JSON.parse(partsB.join(""))).toEqual({ q: "dogs" });
  });
});

// ─── streamToMessage ──────────────────────────────────────────────────────────

describe("streamToMessage", () => {
  it("returns the final accumulated message", async () => {
    const msg = await streamToMessage(makeStream(TEXT_STREAM_EVENTS));
    expect(msg.id).toBe("msg_test01");
    expect(msg.stop_reason).toBe("end_turn");
    if (msg.content[0]?.type === "text") {
      expect(msg.content[0].text).toBe("Hello, world");
    }
  });

  it("assembles a multi-block response correctly", async () => {
    const msg = await streamToMessage(makeStream(MIXED_STREAM_EVENTS));
    expect(msg.id).toBe("msg_mixed01");
    expect(msg.content).toHaveLength(2);
    expect(msg.content[0]?.type).toBe("text");
    expect(msg.content[1]?.type).toBe("tool_use");
    expect(msg.stop_reason).toBe("tool_use");
  });

  it("returns empty message for empty stream", async () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) { controller.close(); },
    });
    const msg = await streamToMessage(stream);
    expect(msg.id).toBe("");
    expect(msg.content).toHaveLength(0);
  });

  it("assembles thinking + text response", async () => {
    const msg = await streamToMessage(makeStream(THINKING_STREAM_EVENTS));
    expect(msg.content).toHaveLength(2);
    if (msg.content[0]?.type === "thinking") {
      expect(msg.content[0].thinking).toBe("Let me think about this...");
    }
    if (msg.content[1]?.type === "text") {
      expect(msg.content[1].text).toBe("The answer is 42.");
    }
  });
});

// ─── streamWithCallbacks ──────────────────────────────────────────────────────

describe("streamWithCallbacks", () => {
  it("fires onText for each delta", async () => {
    const texts: string[] = [];
    await streamWithCallbacks(makeStream(TEXT_STREAM_EVENTS), {
      onText: (t) => texts.push(t),
    });
    expect(texts).toEqual(["Hello", ", world"]);
  });

  it("fires onToolUse with parsed input after stream ends", async () => {
    let toolName = "";
    let toolInput: Record<string, unknown> = {};
    await streamWithCallbacks(makeStream(TOOL_USE_EVENTS), {
      onToolUse: (_, name, input) => {
        toolName = name;
        toolInput = input;
      },
    });
    expect(toolName).toBe("get_weather");
    expect(toolInput).toEqual({ city: "Cairo" });
  });

  it("fires onDone with the final message", async () => {
    let done = false;
    await streamWithCallbacks(makeStream(TEXT_STREAM_EVENTS), {
      onDone: (msg) => {
        done = true;
        expect(msg.stop_reason).toBe("end_turn");
      },
    });
    expect(done).toBe(true);
  });

  it("fires onEvent for every event", async () => {
    const types: string[] = [];
    await streamWithCallbacks(makeStream(TEXT_STREAM_EVENTS), {
      onEvent: (e) => types.push(e.type),
    });
    expect(types).toContain("ping");
    expect(types).toContain("message_stop");
  });

  it("works with an empty callbacks object (no crash)", async () => {
    const msg = await streamWithCallbacks(makeStream(TEXT_STREAM_EVENTS), {});
    expect(msg.id).toBe("msg_test01");
    expect(msg.stop_reason).toBe("end_turn");
  });

  it("fires onToolUse for each tool in a multi-tool response", async () => {
    const tools: Array<{ id: string; name: string; input: Record<string, unknown> }> = [];
    await streamWithCallbacks(makeStream(MULTI_TOOL_EVENTS), {
      onToolUse: (id, name, input) => tools.push({ id, name, input }),
    });
    expect(tools).toHaveLength(2);
    expect(tools[0]).toEqual({ id: "toolu_a", name: "search", input: { q: "cats" } });
    expect(tools[1]).toEqual({ id: "toolu_b", name: "search", input: { q: "dogs" } });
  });

  it("passes correct blockIndex to onText", async () => {
    const indices: number[] = [];
    await streamWithCallbacks(makeStream(MIXED_STREAM_EVENTS), {
      onText: (_, blockIndex) => indices.push(blockIndex),
    });
    // Text delta was at index 0
    expect(indices).toEqual([0]);
  });

  it("fires onText but not onToolUse for text-only stream", async () => {
    let toolUseCalled = false;
    const texts: string[] = [];
    await streamWithCallbacks(makeStream(TEXT_STREAM_EVENTS), {
      onText: (t) => texts.push(t),
      onToolUse: () => { toolUseCalled = true; },
    });
    expect(texts).toEqual(["Hello", ", world"]);
    expect(toolUseCalled).toBe(false);
  });

  it("onDone message contains thinking blocks", async () => {
    let doneMsg: Awaited<ReturnType<typeof streamToMessage>> | null = null;
    await streamWithCallbacks(makeStream(THINKING_STREAM_EVENTS), {
      onDone: (msg) => { doneMsg = msg; },
    });
    expect(doneMsg).not.toBeNull();
    expect(doneMsg!.content).toHaveLength(2);
    expect(doneMsg!.content[0]?.type).toBe("thinking");
  });
});

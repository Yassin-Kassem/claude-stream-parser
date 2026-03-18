import { describe, it, expect } from "vitest";
import { parseSSEBlock, splitSSEBlocks } from "../parser";
import { MessageAccumulator } from "../accumulator";
import {
  parseStream,
  streamText,
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
});

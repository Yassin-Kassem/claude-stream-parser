# claude-stream-parser

A tiny, **zero-dependency** TypeScript library for parsing Claude's streaming SSE responses into fully typed events.

Works with any raw `ReadableStream<Uint8Array>` — no Anthropic SDK required.

```
npm install claude-stream-parser
```

---

## Why

The official `@anthropic-ai/sdk` handles streaming, but it's tightly coupled to its own HTTP client. If you're using a raw `fetch`, a custom proxy, an edge runtime, or you just want typed access to every individual SSE event — this library gives you that cleanly.

---

## API

### `parseStream(stream)` — async generator of typed events

The lowest-level API. Yields every `ClaudeStreamEvent` as it arrives, in order.
Throws `ClaudeStreamError` if the stream contains an `error` event.

```ts
import { parseStream } from "claude-stream-parser";

const response = await fetch("https://api.anthropic.com/v1/messages", {
  method: "POST",
  headers: {
    "x-api-key": process.env.ANTHROPIC_API_KEY!,
    "anthropic-version": "2023-06-01",
    "content-type": "application/json",
  },
  body: JSON.stringify({
    model: "claude-sonnet-4-6",
    max_tokens: 1024,
    stream: true,
    messages: [{ role: "user", content: "Hello!" }],
  }),
});

for await (const event of parseStream(response.body!)) {
  switch (event.type) {
    case "content_block_delta":
      if (event.delta.type === "text_delta") {
        process.stdout.write(event.delta.text);
      }
      if (event.delta.type === "input_json_delta") {
        // streaming tool input JSON
        process.stdout.write(event.delta.partial_json);
      }
      break;
    case "message_stop":
      console.log("\nDone.");
      break;
  }
}
```

---

### `streamText(stream)` — async generator of text strings

The simplest interface for text-only responses.

```ts
import { streamText } from "claude-stream-parser";

for await (const chunk of streamText(response.body!)) {
  process.stdout.write(chunk); // "Hello", ", world", "!"
}
```

---

### `streamToMessage(stream)` — accumulate to a final message

Consumes the stream and returns a fully assembled message object — same shape as a non-streaming response.

```ts
import { streamToMessage } from "claude-stream-parser";

const message = await streamToMessage(response.body!);

console.log(message.stop_reason);   // "end_turn"
console.log(message.usage);         // { input_tokens: 12, output_tokens: 48 }

for (const block of message.content) {
  if (block.type === "text") {
    console.log(block.text);
  }
  if (block.type === "tool_use") {
    console.log(block.name, block.input); // fully parsed JSON input
  }
}
```

---

### `streamWithCallbacks(stream, callbacks)` — event-driven interface

Fires typed callbacks as events arrive and returns the final message.

```ts
import { streamWithCallbacks } from "claude-stream-parser";

const message = await streamWithCallbacks(response.body!, {
  onText: (text, blockIndex) => {
    process.stdout.write(text);
  },
  onToolUse: (id, name, input) => {
    console.log(`Tool call: ${name}`, input);
  },
  onEvent: (event) => {
    // every raw event if you need it
  },
  onDone: (message) => {
    console.log("Finished:", message.stop_reason);
  },
});
```

---

### `MessageAccumulator` — stateful accumulator class

For when you need to inspect the partial message state mid-stream.

```ts
import { parseStream, MessageAccumulator } from "claude-stream-parser";

const acc = new MessageAccumulator();

for await (const event of parseStream(response.body!)) {
  acc.add(event);

  // peek at partial state at any point
  const partial = acc.message();
  if (partial.content[0]?.type === "text") {
    updateUI(partial.content[0].text);
  }
}

const final = acc.message();
console.log(final);
```

---

### `parseSSEBlock(block)` — low-level block parser

Parse a single raw SSE block string into a typed event. Useful for testing or custom transports.

```ts
import { parseSSEBlock } from "claude-stream-parser";

const event = parseSSEBlock(
  'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hi"}}'
);
// → { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hi" } }
```

---

## Event types

Every event Claude can emit is fully typed:

| Event type | Description |
|---|---|
| `message_start` | Stream opened, contains the initial `Message` object |
| `content_block_start` | A new content block started (text, tool_use, or thinking) |
| `content_block_delta` | Incremental delta — `text_delta`, `input_json_delta`, `thinking_delta`, or `signature_delta` |
| `content_block_stop` | Content block finished |
| `message_delta` | Top-level message update — `stop_reason`, `stop_sequence`, output token count |
| `message_stop` | Stream complete |
| `ping` | Heartbeat from the server |
| `error` | Stream-level error (throws `ClaudeStreamError`) |

---

## Accumulated types

`streamToMessage` and `MessageAccumulator.message()` return an `AccumulatedMessage`:

```ts
interface AccumulatedMessage {
  id: string;
  role: "assistant";
  model: string;
  stop_reason: StopReason | null;   // "end_turn" | "max_tokens" | "stop_sequence" | "tool_use"
  stop_sequence: string | null;
  usage: { input_tokens: number; output_tokens: number };
  content: AccumulatedBlock[];      // text | tool_use | thinking
}
```

Tool use blocks have their `input_json_delta` fragments assembled and parsed for you:

```ts
// block.type === "tool_use"
{
  type: "tool_use",
  index: 0,
  id: "toolu_01abc",
  name: "get_weather",
  input: { city: "Cairo", unit: "celsius" }  // fully parsed ✓
}
```

---

## Error handling

```ts
import { parseStream, ClaudeStreamError } from "claude-stream-parser";

try {
  for await (const event of parseStream(response.body!)) {
    // ...
  }
} catch (err) {
  if (err instanceof ClaudeStreamError) {
    console.error(err.errorType);  // "overloaded_error" | "rate_limit_error" | ...
    console.error(err.message);
  }
}
```

---

## License

MIT

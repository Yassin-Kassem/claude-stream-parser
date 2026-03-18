import type {
  AccumulatedBlock,
  AccumulatedMessage,
  AccumulatedToolUseBlock,
  ClaudeStreamEvent,
  ContentBlock,
  Usage,
} from "./types/events.js";

interface MutableTextBlock {
  type: "text";
  index: number;
  text: string;
}

interface MutableToolUseBlock {
  type: "tool_use";
  index: number;
  id: string;
  name: string;
  _rawJson: string; // accumulates partial_json deltas
  input: Record<string, unknown>;
}

interface MutableThinkingBlock {
  type: "thinking";
  index: number;
  thinking: string;
}

type MutableBlock = MutableTextBlock | MutableToolUseBlock | MutableThinkingBlock;

function contentBlockToMutable(index: number, block: ContentBlock): MutableBlock {
  switch (block.type) {
    case "text":
      return { type: "text", index, text: block.text };
    case "tool_use":
      return {
        type: "tool_use",
        index,
        id: block.id,
        name: block.name,
        _rawJson: "",
        input: {},
      };
    case "thinking":
      return { type: "thinking", index, thinking: block.thinking };
  }
}

function mutableToAccumulated(b: MutableBlock): AccumulatedBlock {
  if (b.type === "tool_use") {
    let input: Record<string, unknown> = {};
    try {
      if (b._rawJson) input = JSON.parse(b._rawJson) as Record<string, unknown>;
    } catch {
      // malformed partial JSON — return empty input
    }
    const out: AccumulatedToolUseBlock = {
      type: "tool_use",
      index: b.index,
      id: b.id,
      name: b.name,
      input,
    };
    return out;
  }
  return b;
}

/**
 * Stateful accumulator. Feed it events one-by-one with `.add(event)`.
 * At any point call `.message()` to get the current accumulated state.
 * Call `.isDone()` to check whether a `message_stop` has been received.
 */
export class MessageAccumulator {
  private _id = "";
  private _model = "";
  private _stopReason: AccumulatedMessage["stop_reason"] = null;
  private _stopSequence: AccumulatedMessage["stop_sequence"] = null;
  private _usage: Usage & { output_tokens: number } = {
    input_tokens: 0,
    output_tokens: 0,
  };
  private _blocks = new Map<number, MutableBlock>();
  private _done = false;

  add(event: ClaudeStreamEvent): void {
    switch (event.type) {
      case "message_start": {
        const m = event.message;
        this._id = m.id;
        this._model = m.model;
        this._stopReason = m.stop_reason;
        this._stopSequence = m.stop_sequence;
        this._usage = { ...m.usage, output_tokens: m.usage.output_tokens };
        break;
      }

      case "content_block_start": {
        this._blocks.set(
          event.index,
          contentBlockToMutable(event.index, event.content_block)
        );
        break;
      }

      case "content_block_delta": {
        const block = this._blocks.get(event.index);
        if (!block) break;

        const delta = event.delta;

        if (delta.type === "text_delta" && block.type === "text") {
          block.text += delta.text;
        } else if (delta.type === "input_json_delta" && block.type === "tool_use") {
          block._rawJson += delta.partial_json;
        } else if (delta.type === "thinking_delta" && block.type === "thinking") {
          block.thinking += delta.thinking;
        }
        break;
      }

      case "content_block_stop": {
        // block is finalised — no state change needed, it's already in the map
        break;
      }

      case "message_delta": {
        this._stopReason = event.delta.stop_reason;
        this._stopSequence = event.delta.stop_sequence;
        this._usage.output_tokens = event.usage.output_tokens;
        break;
      }

      case "message_stop": {
        this._done = true;
        break;
      }

      case "ping":
      case "error":
        break;
    }
  }

  isDone(): boolean {
    return this._done;
  }

  /**
   * Returns the current accumulated state. Safe to call at any point during
   * streaming — blocks that aren't finished yet will have partial content.
   */
  message(): AccumulatedMessage {
    const content: AccumulatedBlock[] = Array.from(this._blocks.entries())
      .sort(([a], [b]) => a - b)
      .map(([, block]) => mutableToAccumulated(block));

    return {
      id: this._id,
      role: "assistant",
      model: this._model,
      stop_reason: this._stopReason,
      stop_sequence: this._stopSequence,
      usage: { ...this._usage },
      content,
    };
  }
}

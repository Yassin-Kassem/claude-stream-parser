import type { ClaudeStreamEvent } from "./types/events.js";

/**
 * Parses a single SSE "event block" (the `event:` + `data:` pair) into a
 * typed ClaudeStreamEvent, or null if the block is incomplete / a comment.
 */
export function parseSSEBlock(block: string): ClaudeStreamEvent | null {
  const lines = block.split("\n");

  let eventName: string | undefined;
  let dataLine: string | undefined;

  for (const line of lines) {
    if (line.startsWith("event:")) {
      eventName = line.slice(6).trim();
    } else if (line.startsWith("data:")) {
      dataLine = line.slice(5).trim();
    }
    // ignore `:` comment lines (ping heartbeats come as comment lines too)
  }

  if (!dataLine || dataLine === "[DONE]") return null;

  try {
    const parsed = JSON.parse(dataLine) as ClaudeStreamEvent;
    // Trust the `type` field inside data over the `event:` header, but
    // fall back to the header name if the data is missing `type`.
    if (!("type" in parsed) && eventName) {
      (parsed as Record<string, unknown>)["type"] = eventName;
    }
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Low-level: splits a raw SSE chunk string into individual event blocks.
 * SSE blocks are separated by one or more blank lines.
 */
export function splitSSEBlocks(chunk: string): string[] {
  return chunk
    .split(/\r?\n\r?\n/)
    .map((b) => b.trim())
    .filter(Boolean);
}

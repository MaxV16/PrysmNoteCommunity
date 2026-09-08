import { describe, it, expect } from "vitest";
import { createSSEParser } from "./sse";
import type { SSEEvent } from "./sse";

function collect(events: SSEEvent[]) {
  return (ev: SSEEvent) => events.push(ev);
}

describe("createSSEParser", () => {
  it("parses a single event with one data line", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("event: token\ndata: hello\n\n");
    parser.flush();
    expect(events).toEqual([{ event: "token", data: "hello" }]);
  });

  it("joins multi-line data payloads with a single newline", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed('event: token\n');
    parser.feed("data: I\n");
    parser.feed("data: 'm\n");
    parser.feed("\n");
    parser.flush();
    expect(events).toEqual([{ event: "token", data: "I\n'm" }]);
  });

  it("parses the CRLF wire form and starts the next event clean", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("event: token\r\ndata: I\r\ndata: 'm\r\n\r\n");
    parser.feed('event: usage\r\ndata: {"estimated_tokens": 42}\r\n\r\n');
    parser.flush();
    expect(events).toEqual([
      { event: "token", data: "I\n'm" },
      { event: "usage", data: '{"estimated_tokens": 42}' },
    ]);
  });

  it("dispatches events on blank-line boundaries", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("data: a\n\ndata: b\n\n");
    parser.flush();
    expect(events).toEqual([
      { event: "message", data: "a" },
      { event: "message", data: "b" },
    ]);
  });

  it("skips comment / keepalive lines", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed(": ping\n: keepalive\nevent: token\ndata: x\n\n");
    parser.flush();
    expect(events).toEqual([{ event: "token", data: "x" }]);
  });

  it("buffers partial lines split across feed calls, then flush dispatches", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("event: to");
    parser.feed("ken\ndata: hel");
    parser.feed("lo\n\n");
    parser.flush();
    expect(events).toEqual([{ event: "token", data: "hello" }]);
  });

  it("handles a CRLF pair split across feed calls", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("event: token\r");
    parser.feed("\ndata: I\r");
    parser.feed("\n\r\n");
    parser.flush();
    expect(events).toEqual([{ event: "token", data: "I" }]);
  });

  it("strips a single optional space after the field colon", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("data:  hello\n\n");
    parser.feed("data:world\n\n");
    parser.flush();
    expect(events).toEqual([
      { event: "message", data: " hello" },
      { event: "message", data: "world" },
    ]);
  });

  it("emits empty data for an empty data value", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("event: done\ndata:\n\n");
    parser.flush();
    expect(events).toEqual([{ event: "done", data: "" }]);
  });

  it("dispatches a pending event on flush without a trailing blank line", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("event: token\ndata: last");
    parser.flush();
    expect(events).toEqual([{ event: "token", data: "last" }]);
  });

  it("does not dispatch when nothing was fed", () => {
    const events: SSEEvent[] = [];
    const parser = createSSEParser(collect(events));
    parser.feed("");
    parser.flush();
    expect(events).toEqual([]);
  });
});
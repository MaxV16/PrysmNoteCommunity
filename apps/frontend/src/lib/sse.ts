// A tiny, spec-compliant Server-Sent Events parser (WHATWG / MDN).
//
// sse-starlette terminates its lines with "\r\n" and splits any "\n" inside a
// data payload into consecutive "data:" lines. The SSE spec requires a client
// to treat "\r\n", "\r" and "\n" all as line endings, and to rejoin the
// consecutive "data:" lines of one event with a single "\n". This parser does
// exactly that, so the live AI stream accumulates the same raw token text the
// backend persists - the reply normalizer then produces byte-identical output
// for the live bubble and the refreshed history.

export interface SSEEvent {
  event: string;
  data: string;
}

export interface SSEParser {
  feed(text: string): void;
  flush(): void;
}

export function createSSEParser(onEvent: (ev: SSEEvent) => void): SSEParser {
  let buffer = "";
  let eventName = "";
  let dataLines: string[] = [];
  let pending = false;

  const dispatch = () => {
    if (!pending) return;
    onEvent({ event: eventName || "message", data: dataLines.join("\n") });
    eventName = "";
    dataLines = [];
    pending = false;
  };

  const processLine = (line: string) => {
    if (line === "") {
      // A blank line terminates the current event (if any).
      dispatch();
      return;
    }
    if (line.startsWith(":")) {
      // Comment / keepalive line: ignored, never dispatches, does not reset
      // an in-flight event.
      return;
    }
    const colon = line.indexOf(":");
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") {
      eventName = value;
      pending = true;
    } else if (field === "data") {
      dataLines.push(value);
      pending = true;
    }
    // "id" and "retry" are irrelevant to this consumer; unknown fields ignored.
  };

  return {
    feed(text: string) {
      buffer += text;
      while (buffer.length > 0) {
        let endIndex = -1;
        let endLength = 0;
        for (let i = 0; i < buffer.length; i++) {
          const ch = buffer.charCodeAt(i);
          if (ch === 10) {
            endIndex = i;
            endLength = 1;
            break;
          }
          if (ch === 13) {
            endIndex = i;
            endLength = buffer.charCodeAt(i + 1) === 10 ? 2 : 1;
            break;
          }
        }
        if (endIndex === -1) break;
        // A lone "\r" at the very end of the buffer may be the first half of
        // a "\r\n" pair that the next chunk finishes - wait instead of firing
        // a spurious blank line.
        if (
          endLength === 1 &&
          buffer.charCodeAt(endIndex) === 13 &&
          endIndex === buffer.length - 1
        ) {
          break;
        }
        processLine(buffer.slice(0, endIndex));
        buffer = buffer.slice(endIndex + endLength);
      }
    },
    flush() {
      if (buffer.length > 0) {
        // Any final bytes without a trailing line ending still form one last
        // line; a lone trailing "\r" is a CR-only line ending at EOF.
        processLine(buffer.replace(/\r$/, ""));
        buffer = "";
      }
      dispatch();
    },
  };
}
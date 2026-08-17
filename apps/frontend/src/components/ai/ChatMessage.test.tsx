import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { ChatMessage } from "./ChatMessage";
import type { ChatMessage as ChatMessageType } from "@/types/ai";

function makeMessage(content: string, role: ChatMessageType["role"] = "assistant"): ChatMessageType {
  return {
    id: crypto.randomUUID(),
    role,
    content,
    created_at: new Date().toISOString(),
  };
}

describe("ChatMessage rendering regression (the 'big circle' fix)", () => {
  it("renders assistant markdown (bold) as formatted text, not a tool pill", () => {
    render(<ChatMessage message={makeMessage("Done! **Here's the summary:** all good.")} />);
    // Bold text must render as an actual <strong> element (markdown applied),
    // not as literal "**" text or inside a round tool pill.
    const strong = screen.getByText("Here's the summary:");
    expect(strong.tagName).toBe("STRONG");
  });

  it("never renders a final assistant message as a round tool-activity pill", () => {
    const content = "Done! Here's the summary.";
    // Simulates a message that would only ever be produced if the old buggy
    // "⚙ " prefix leaked into an assistant bubble: it must NOT become a pill.
    render(<ChatMessage message={makeMessage(`⚙ ${content}`)} />);
    expect(screen.queryByText(content, { selector: ".rounded-full" })).toBeFalsy();
    expect(screen.queryByText(/Removing task|Creating task/)).toBeFalsy();
  });

  it("renders a distinct transient tool-activity card for role 'tool'", () => {
    render(<ChatMessage message={makeMessage("Creating task", "tool")} />);
    expect(screen.getByText("Creating task")).toBeTruthy();
  });
});

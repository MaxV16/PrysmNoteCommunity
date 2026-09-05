import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import { AIPanel } from "./AIPanel";

const { apiGet } = vi.hoisted(() => ({
  apiGet: vi.fn(),
}));

vi.mock("@/lib/api", () => ({
  api: {
    get: apiGet,
  },
}));

vi.mock("@/hooks/useAIChat", () => ({
  useAIChat: () => ({
    chatMessages: [],
    sendMessage: vi.fn(),
    isLoading: false,
    abort: vi.fn(),
    undoLastAction: vi.fn(),
    hasUndo: false,
    loadSession: vi.fn(),
    newChat: vi.fn(),
    clearActiveSession: vi.fn(),
    fetchSessions: vi.fn().mockResolvedValue([]),
    usageTokens: null,
  }),
}));

vi.mock("@/hooks/useApiKeys", () => ({
  useApiKeys: () => ({
    keys: [],
    loading: false,
    fetchKeys: vi.fn().mockResolvedValue([]),
  }),
}));

vi.mock("@/lib/ui-module-registry", () => ({
  useUiModule: () => false,
}));

vi.mock("@/lib/use-local-bool", () => ({
  useLocalBool: () => false,
}));

describe("AIPanel EU AI Act Art. 50(1) disclosure", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    localStorage.clear();
    apiGet.mockResolvedValue({
      mode: "prysmai",
      allowance: 100000,
      used: 0,
      remaining: null,
      blocked: false,
    });
  });

  it("shows the first-interaction AI notice on an empty chat", async () => {
    render(<AIPanel onClose={() => {}} />);
    expect(
      await screen.findByText(/You are chatting with PrysmAI, an AI assistant/)
    ).toBeInTheDocument();
    // Both the first-interaction notice and the composer footnote disclose
    // zero data retention, so the phrase legitimately appears twice.
    expect(screen.getAllByText(/zero data retention/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText(/Do not enter sensitive personal data/)).toBeInTheDocument();
  });

  it("always shows the persistent composer footnote", async () => {
    render(<AIPanel onClose={() => {}} />);
    expect(
      await screen.findByText(/PrysmAI is an AI assistant; check important details/)
    ).toBeInTheDocument();
    expect(screen.getByText(/Hosted models vary by region/)).toBeInTheDocument();
  });
});

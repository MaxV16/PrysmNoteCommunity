import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { ErrorBoundary } from "./ErrorBoundary";

function Boom(): JSX.Element {
  throw new Error("boom");
}

afterEach(cleanup);

describe("ErrorBoundary", () => {
  it("renders children when nothing throws", () => {
    render(
      <ErrorBoundary>
        <span>safe content</span>
      </ErrorBoundary>
    );
    expect(screen.getByText("safe content")).toBeTruthy();
  });

  it("contains a thrown error and shows the labelled fallback", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary label="GitHub">
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText("GitHub is unavailable right now.")).toBeTruthy();
    spy.mockRestore();
  });

  it("uses a custom fallback when one is provided", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    render(
      <ErrorBoundary fallback={<span>custom fallback</span>}>
        <Boom />
      </ErrorBoundary>
    );
    expect(screen.getByText("custom fallback")).toBeTruthy();
    spy.mockRestore();
  });
});

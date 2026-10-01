import { describe, it, expect } from "vitest";
import { render, screen } from "@testing-library/react";
import { CharLimitHint } from "./CharLimitHint";

describe("CharLimitHint", () => {
  it("renders nothing when the value is comfortably under the limit", () => {
    const { container } = render(<CharLimitHint value="hello" max={5000} />);
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the remaining count when the value is near the limit", () => {
    render(<CharLimitHint value={"x".repeat(4950)} max={5000} />);
    const hint = screen.getByTestId("char-limit-hint");
    expect(hint).toHaveTextContent("50 characters left");
    expect(hint.className).toContain("text-warning");
  });

  it("shows the over-limit count and danger tone when the limit is breached", () => {
    render(<CharLimitHint value={"x".repeat(5025)} max={5000} />);
    const hint = screen.getByTestId("char-limit-hint");
    expect(hint).toHaveTextContent("25 characters over the limit");
    expect(hint.className).toContain("text-danger");
  });

  it("uses the singular form for a single remaining character", () => {
    render(<CharLimitHint value={"x".repeat(4999)} max={5000} />);
    expect(screen.getByTestId("char-limit-hint")).toHaveTextContent("1 character left");
  });

  it("renders while far under the limit when alwaysVisible is set", () => {
    render(<CharLimitHint value="hi" max={5000} alwaysVisible />);
    const hint = screen.getByTestId("char-limit-hint");
    expect(hint).toHaveTextContent("4,998 characters left");
    expect(hint).toHaveTextContent("(max 5,000)");
  });

  it("drops the max annotation in alwaysVisible mode when over the limit", () => {
    render(<CharLimitHint value={"x".repeat(5003)} max={5000} alwaysVisible />);
    const hint = screen.getByTestId("char-limit-hint");
    expect(hint).toHaveTextContent("3 characters over the limit");
    expect(hint).not.toHaveTextContent("(max");
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import {
  UiScaleProvider,
  useUiScale,
  UI_SCALE_KEY,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
} from "./ui-scale-context";

function Probe() {
  const { scale, setScale, resetScale } = useUiScale();
  return (
    <div>
      <span data-testid="scale">{scale}</span>
      <button onClick={() => setScale(UI_SCALE_MAX + 1)}>big</button>
      <button onClick={() => setScale(UI_SCALE_MIN - 1)}>small</button>
      <button onClick={resetScale}>reset</button>
    </div>
  );
}

describe("ui-scale-context", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--ui-scale");
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--ui-scale");
  });

  it("defaults to 1 outside a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("scale").textContent).toBe("1");
  });

  it("publishes the scale to --ui-scale and persists it", () => {
    render(
      <UiScaleProvider>
        <Probe />
      </UiScaleProvider>
    );
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe("1");

    act(() => {
      screen.getByText("big").click();
    });
    // Clamped to the maximum, applied live and stored for the next visit.
    expect(screen.getByTestId("scale").textContent).toBe(String(UI_SCALE_MAX));
    expect(document.documentElement.style.getPropertyValue("--ui-scale")).toBe(
      String(UI_SCALE_MAX)
    );
    expect(localStorage.getItem(UI_SCALE_KEY)).toBe(String(UI_SCALE_MAX));
  });

  it("clamps below the minimum and restores a stored value", () => {
    localStorage.setItem(UI_SCALE_KEY, "0.85");
    render(
      <UiScaleProvider>
        <Probe />
      </UiScaleProvider>
    );
    expect(screen.getByTestId("scale").textContent).toBe("0.85");

    act(() => {
      screen.getByText("small").click();
    });
    expect(screen.getByTestId("scale").textContent).toBe(String(UI_SCALE_MIN));
  });
});

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { render, act, screen } from "@testing-library/react";
import {
  UiScaleProvider,
  useUiScale,
  UI_SCALE_KEY,
  UI_SCALE_MIN,
  UI_SCALE_MAX,
  FONT_SCALE_KEY,
  FONT_SCALE_MIN,
  FONT_SCALE_MAX,
} from "./ui-scale-context";

function Probe() {
  const { scale, setScale, resetScale, fontScale, setFontScale, resetFontScale } = useUiScale();
  return (
    <div>
      <span data-testid="scale">{scale}</span>
      <span data-testid="font">{fontScale}</span>
      <button onClick={() => setScale(UI_SCALE_MAX + 1)}>big</button>
      <button onClick={() => setScale(UI_SCALE_MIN - 1)}>small</button>
      <button onClick={resetScale}>reset</button>
      <button onClick={() => setFontScale(FONT_SCALE_MAX + 1)}>font-big</button>
      <button onClick={() => setFontScale(FONT_SCALE_MIN - 1)}>font-small</button>
      <button onClick={resetFontScale}>font-reset</button>
    </div>
  );
}

describe("ui-scale-context", () => {
  beforeEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--ui-scale");
    document.documentElement.style.removeProperty("--font-scale");
  });

  afterEach(() => {
    localStorage.clear();
    document.documentElement.style.removeProperty("--ui-scale");
    document.documentElement.style.removeProperty("--font-scale");
  });

  it("defaults to 1 outside a provider", () => {
    render(<Probe />);
    expect(screen.getByTestId("scale").textContent).toBe("1");
    expect(screen.getByTestId("font").textContent).toBe("1");
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

  it("scales the font independently and persists it", () => {
    render(
      <UiScaleProvider>
        <Probe />
      </UiScaleProvider>
    );
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe("1");

    act(() => {
      screen.getByText("font-big").click();
    });
    expect(screen.getByTestId("font").textContent).toBe(String(FONT_SCALE_MAX));
    expect(document.documentElement.style.getPropertyValue("--font-scale")).toBe(
      String(FONT_SCALE_MAX)
    );
    expect(localStorage.getItem(FONT_SCALE_KEY)).toBe(String(FONT_SCALE_MAX));
    // The interface size is untouched by the font control.
    expect(screen.getByTestId("scale").textContent).toBe("1");
  });

  it("clamps the font below the minimum and resets both back to 100%", () => {
    localStorage.setItem(FONT_SCALE_KEY, "1.5");
    render(
      <UiScaleProvider>
        <Probe />
      </UiScaleProvider>
    );
    expect(screen.getByTestId("font").textContent).toBe("1.5");

    act(() => {
      screen.getByText("font-small").click();
    });
    expect(screen.getByTestId("font").textContent).toBe(String(FONT_SCALE_MIN));

    act(() => {
      screen.getByText("font-reset").click();
    });
    expect(screen.getByTestId("font").textContent).toBe("1");
  });
});

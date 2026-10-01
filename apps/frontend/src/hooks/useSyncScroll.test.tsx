import { describe, it, expect } from "vitest";
import { render } from "@testing-library/react";
import { useRef } from "react";
import { useSyncScroll } from "./useSyncScroll";

function nextFrame() {
  return new Promise((resolve) => requestAnimationFrame(() => resolve(null)));
}

/**
 * Mirrors TimelineView: the labels column (b) mounts only after its data loads,
 * so the sync effect must re-attach when the dep changes, not only on mount.
 */
function Harness({ show }: { show: boolean }) {
  const a = useRef<HTMLDivElement>(null);
  const b = useRef<HTMLDivElement>(null);
  useSyncScroll(a, b, [show]);
  return (
    <div>
      <div ref={a} data-testid="a" style={{ height: 50, overflow: "auto" }}>
        <div style={{ height: 500 }} />
      </div>
      {show && (
        <div ref={b} data-testid="b" style={{ height: 50, overflow: "auto" }}>
          <div style={{ height: 500 }} />
        </div>
      )}
    </div>
  );
}

describe("useSyncScroll", () => {
  it("re-attaches when the second scrollable mounts later", async () => {
    const { rerender, getByTestId } = render(<Harness show={false} />);
    rerender(<Harness show={true} />);

    const a = getByTestId("a");
    const b = getByTestId("b");
    b.scrollTop = 120;
    b.dispatchEvent(new Event("scroll"));
    await nextFrame();
    await nextFrame();

    expect(a.scrollTop).toBe(120);
  });

  it("syncs both directions", async () => {
    const { getByTestId } = render(<Harness show={true} />);
    const a = getByTestId("a");
    const b = getByTestId("b");

    a.scrollTop = 80;
    a.dispatchEvent(new Event("scroll"));
    await nextFrame();
    await nextFrame();
    expect(b.scrollTop).toBe(80);

    b.scrollTop = 40;
    b.dispatchEvent(new Event("scroll"));
    await nextFrame();
    await nextFrame();
    expect(a.scrollTop).toBe(40);
  });
});

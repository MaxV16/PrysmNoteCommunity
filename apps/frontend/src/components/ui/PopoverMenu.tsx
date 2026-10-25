"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import { createPortal } from "react-dom";
import { minOverlayTop } from "@/lib/desktop-bridge";

interface PopoverMenuProps {
  open: boolean;
  triggerRef: RefObject<HTMLElement | null>;
  align?: "left" | "right";
  preferred?: "below" | "above";
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Portal-based menu that renders on the top-most layer (fixed + z-[70]) so it is
 * never clipped by an overflow container and always clearly visible in
 * screenshots / above adjacent panels. Positions itself from the trigger's
 * bounding rect and stays within the viewport.
 */
export function PopoverMenu({
  open,
  triggerRef,
  align = "left",
  preferred = "below",
  onClose,
  children,
  className = "",
}: PopoverMenuProps) {
  const [pos, setPos] = useState<{ top: number; left: number; width: number; maxH: number } | null>(
    null
  );
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const compute = () => {
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) return null;
      const menu = menuRef.current;
      const measuredW = menu ? menu.getBoundingClientRect().width : 240;
      const measuredH = menu ? menu.getBoundingClientRect().height : 200;
      const minTop = minOverlayTop(8);
      const edge = 8;
      const maxW = Math.max(160, window.innerWidth - edge * 2);
      const menuW = Math.min(measuredW, maxW);
      let left = align === "right" ? rect.right - menuW : rect.left;
      left = Math.max(edge, Math.min(left, window.innerWidth - menuW - edge));

      // Pick the side with more room so a tall menu (the view switcher) keeps
      // as many items visible as possible, then clamp inside the viewport.
      const spaceBelow = window.innerHeight - rect.bottom - edge;
      const spaceAbove = rect.top - minTop - edge;
      const openBelow =
        preferred === "below"
          ? spaceBelow >= Math.min(measuredH, 160) || spaceBelow >= spaceAbove
          : spaceAbove < Math.min(measuredH, 160) && spaceBelow > spaceAbove;
      const menuH = Math.min(measuredH, Math.max(120, window.innerHeight - minTop - edge * 2));
      let top = openBelow ? rect.bottom + 4 : rect.top - menuH - 4;
      top = Math.max(minTop, Math.min(top, window.innerHeight - edge - Math.min(menuH, window.innerHeight - minTop - edge)));
      // Cap the height to the space actually available so a tall menu scrolls
      // instead of being clipped, keeping its last items reachable.
      const maxH = Math.max(120, window.innerHeight - top - edge);
      return { top, left, width: menuW, maxH };
    };
    setPos(compute());
    // Re-measure after layout settles, and re-anchor while open so the menu
    // can never float detached from its trigger (window resize / scroll).
    const raf = requestAnimationFrame(() => setPos(compute()));
    const onReflow = () => setPos(compute());
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, align, preferred, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const getItems = () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>(
          '[role="menuitem"], button:not([disabled]), a[href]'
        ) ?? []
      ).filter((el) => !el.hasAttribute("disabled") && el.tabIndex !== -1);

    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
        return;
      }
      const items = getItems();
      if (items.length === 0) return;
      const active = document.activeElement as HTMLElement | null;
      const idx = active ? items.indexOf(active) : -1;
      if (e.key === "ArrowDown") {
        e.preventDefault();
        items[(idx + 1 + items.length) % items.length]?.focus();
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        items[(idx - 1 + items.length) % items.length]?.focus();
      } else if (e.key === "Home") {
        e.preventDefault();
        items[0]?.focus();
      } else if (e.key === "End") {
        e.preventDefault();
        items[items.length - 1]?.focus();
      }
    };
    const onDown = (e: MouseEvent | PointerEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    // pointerdown covers touch (some Android WebViews skip synthesized mousedown);
    // mousedown is kept so older desktop browsers dismiss identically.
    document.addEventListener("pointerdown", onDown);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("pointerdown", onDown);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label="Menu"
      className={`fixed z-[70] overflow-y-auto overscroll-contain rounded-lg border border-border bg-surface py-1 shadow-md ${className}`}
      style={{ top: pos.top, left: pos.left, minWidth: pos.width, maxHeight: pos.maxH }}
    >
      {children}
    </div>,
    document.body
  );
}

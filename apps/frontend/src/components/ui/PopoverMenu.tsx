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
  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const compute = () => {
      const menu = menuRef.current;
      const menuW = menu ? menu.getBoundingClientRect().width : 240;
      const menuH = menu ? menu.getBoundingClientRect().height : 200;
      let left = align === "right" ? rect.right - menuW : Math.min(rect.left, window.innerWidth - menuW - 8);
      left = Math.max(8, left);
      let top = preferred === "below" ? rect.bottom + 4 : rect.top - menuH - 4;
      if (preferred === "below" && top + menuH > window.innerHeight - 8) {
        top = rect.top - menuH - 4;
      } else if (top < 8) {
        top = 8;
      }
      return { top, left, width: menuW };
    };
    setPos(compute());
    const raf = requestAnimationFrame(() => setPos(compute()));
    return () => cancelAnimationFrame(raf);
  }, [open, align, preferred, triggerRef]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const onDown = (e: MouseEvent) => {
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
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, triggerRef]);

  if (!open || !pos) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={`fixed z-[70] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl ${className}`}
      style={{ top: pos.top, left: pos.left, minWidth: pos.width }}
    >
      {children}
    </div>,
    document.body
  );
}

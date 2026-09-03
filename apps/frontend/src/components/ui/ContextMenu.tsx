"use client";

import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";

interface ContextMenuProps {
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  children: ReactNode;
  className?: string;
}

/**
 * Portal-based right-click menu rendered at the pointer position on the top
 * layer (fixed + z-[70]) so it is never clipped by an overflow container.
 * Supports pointer dismissal (outside mousedown, scroll, resize, blur),
 * Escape, and full roving-focus keyboard navigation over `role="menuitem"`
 * children.
 */
export function ContextMenu({ open, x, y, onClose, children, className = "" }: ContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);

  // Keep the latest onClose in a ref so the keyboard/dismissal effect only
  // depends on `open`. The views pass inline closures (new identity per render);
  // depending on them directly would re-run the effect on every parent render
  // while the menu is open, resetting keyboard focus to the first item.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  // The menu renders immediately at the pointer so the layout effect can
  // measure it and clamp it inside the viewport before paint.
  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const compute = () => {
      const menu = menuRef.current;
      const w = menu?.getBoundingClientRect().width ?? 240;
      const h = menu?.getBoundingClientRect().height ?? 200;
      return {
        top: Math.max(8, Math.min(y, window.innerHeight - h - 8)),
        left: Math.max(8, Math.min(x, window.innerWidth - w - 8)),
      };
    };
    setPos(compute());
    const raf = requestAnimationFrame(() => setPos(compute()));
    return () => cancelAnimationFrame(raf);
  }, [open, x, y]);

  useEffect(() => {
    if (!open) return;

    const items = () =>
      Array.from(
        menuRef.current?.querySelectorAll<HTMLElement>('[role="menuitem"]:not([disabled])') ?? []
      );

    const moveFocus = (dir: 1 | -1) => {
      const list = items();
      if (list.length === 0) return;
      const current = list.indexOf(document.activeElement as HTMLElement);
      const next = (current + dir + list.length) % list.length;
      list[next].focus();
    };

    const onKey = (e: KeyboardEvent) => {
      switch (e.key) {
        case "ArrowDown":
          e.preventDefault();
          moveFocus(1);
          break;
        case "ArrowUp":
          e.preventDefault();
          moveFocus(-1);
          break;
        case "Home":
          e.preventDefault();
          items()[0]?.focus();
          break;
        case "End":
          e.preventDefault();
          const list = items();
          list[list.length - 1]?.focus();
          break;
        case "Enter":
        case " ":
          e.preventDefault();
          (document.activeElement as HTMLElement | null)?.click();
          break;
        case "Escape":
          e.preventDefault();
          onCloseRef.current();
          break;
      }
    };

    const onMouseDown = (e: MouseEvent) => {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) onCloseRef.current();
    };
    const onScroll = () => onCloseRef.current();
    const onResize = () => onCloseRef.current();
    const onWindowBlur = () => onCloseRef.current();

    // Focus the first item on open so keyboard navigation works immediately.
    items()[0]?.focus();

    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onMouseDown);
    document.addEventListener("scroll", onScroll, true);
    window.addEventListener("resize", onResize);
    window.addEventListener("blur", onWindowBlur);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onMouseDown);
      document.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("resize", onResize);
      window.removeEventListener("blur", onWindowBlur);
    };
  }, [open]);

  if (!open) return null;

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className={`fixed z-[70] overflow-hidden rounded-xl border border-border bg-surface py-1 shadow-2xl ${className}`}
      style={pos ? { top: pos.top, left: pos.left } : { top: y, left: x }}
    >
      {children}
    </div>,
    document.body
  );
}

interface ContextMenuItemProps {
  children: ReactNode;
  onClick: () => void;
  danger?: boolean;
  disabled?: boolean;
}

export function ContextMenuItem({ children, onClick, danger, disabled }: ContextMenuItemProps) {
  return (
    <button
      role="menuitem"
      tabIndex={-1}
      onClick={() => !disabled && onClick()}
      disabled={disabled}
      className={`block w-full px-4 py-2 text-left text-xs transition-colors ${
        danger ? "text-danger hover:bg-hover" : "text-secondary hover:bg-hover hover:text-primary"
      } ${disabled ? "cursor-not-allowed opacity-40" : ""}`}
    >
      <span className="block min-w-0 truncate whitespace-nowrap">{children}</span>
    </button>
  );
}

export function ContextMenuDivider() {
  return <div className="my-1 h-px bg-border/60" />;
}

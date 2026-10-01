"use client";

import { useEffect, useRef, type CSSProperties, type ReactNode } from "react";
import { registerBackHandler } from "@/lib/back-nav";

interface ModalProps {
  isOpen: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
}

const FOCUSABLE_SELECTOR =
  'a[href], button:not([disabled]), textarea, input, select, [tabindex]:not([tabindex="-1"])';

export function Modal({ isOpen, onClose, title, children }: ModalProps) {
  const panelRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    if (isOpen) document.addEventListener("keydown", handleEsc);
    return () => document.removeEventListener("keydown", handleEsc);
  }, [isOpen, onClose]);

  // Android/hardware back closes the modal instead of leaving the app.
  useEffect(() => {
    if (!isOpen) return;
    return registerBackHandler(onClose, 100);
  }, [isOpen, onClose]);

  // Lock background scroll, move focus into the dialog, keep Tab inside it, and
  // restore focus to the triggering element when the dialog closes.
  useEffect(() => {
    if (!isOpen) return;
    const previouslyFocused = document.activeElement as HTMLElement | null;
    const body = document.body;
    const prevOverflow = body.style.overflow;
    body.style.overflow = "hidden";

    const focusables = () =>
      Array.from(panelRef.current?.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR) ?? []);

    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Tab") return;
      const list = focusables();
      if (list.length === 0) {
        e.preventDefault();
        panelRef.current?.focus();
        return;
      }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && document.activeElement === first) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener("keydown", onKeyDown);
    // Move focus into the dialog only when it is not already inside (an input
    // with autoFocus may have taken it), and do it synchronously so a late
    // animation frame can never steal focus from a user who is already typing.
    if (!panelRef.current?.contains(document.activeElement)) {
      (focusables()[0] ?? panelRef.current)?.focus();
    }

    return () => {
      document.removeEventListener("keydown", onKeyDown);
      body.style.overflow = prevOverflow;
      previouslyFocused?.focus?.();
    };
  }, [isOpen]);

  if (!isOpen) return null;

  return (
    // Backdrop: clicking outside the panel closes. On small screens the panel
    // becomes a safe-area-aware bottom sheet instead of a centered card.
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-black/50 sm:items-center"
      // Overlays must not be part of the Electron window drag region, or their
      // controls are unclickable on macOS (the OS drag wins in the top strip).
      // They also start below the reserved window-control strip so the OS
      // buttons are never dimmed or covered.
      style={{ top: "var(--desktop-titlebar, 0px)", WebkitAppRegion: "no-drag" } as CSSProperties}
      onClick={onClose}
    >
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="modal-title"
        tabIndex={-1}
        className="max-h-[85dvh] w-full max-w-md overflow-y-auto overscroll-contain rounded-t-2xl border border-border bg-surface p-6 pb-safe shadow-lg outline-none sm:rounded-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 id="modal-title" className="text-lg font-semibold text-primary">
            {title}
          </h2>
          <button
            onClick={onClose}
            aria-label="Close"
            className="pointer-coarse:h-11 pointer-coarse:w-11 flex h-8 w-8 items-center justify-center rounded-full text-sm text-secondary transition-colors hover:bg-hover hover:text-primary"
          >
            ✕
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

"use client";

import { useState, useRef, useEffect, type ReactNode } from "react";

interface DropdownProps {
  trigger: ReactNode;
  children: ReactNode;
}

export function Dropdown({ trigger, children }: DropdownProps) {
  const [isOpen, setIsOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const handleClick = (e: MouseEvent | PointerEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setIsOpen(false);
      }
    };
    // pointerdown covers touch (some Android WebViews skip synthesized mousedown)
    document.addEventListener("pointerdown", handleClick);
    document.addEventListener("mousedown", handleClick);
    return () => {
      document.removeEventListener("pointerdown", handleClick);
      document.removeEventListener("mousedown", handleClick);
    };
  }, []);

  return (
    <div ref={ref} className="relative inline-block">
      <div
        role="button"
        tabIndex={0}
        aria-haspopup="menu"
        aria-expanded={isOpen}
        onClick={() => setIsOpen(!isOpen)}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setIsOpen((prev) => !prev);
          } else if (e.key === "Escape") {
            setIsOpen(false);
          }
        }}
        className="cursor-pointer outline-none focus-visible:ring-2 focus-visible:ring-accent/50 rounded"
      >
        {trigger}
      </div>
      {isOpen && (
        <div
          role="menu"
          className="absolute right-0 z-40 mt-1 min-w-[180px] rounded border border-border bg-surface py-1 shadow-lg"
        >
          {children}
        </div>
      )}
    </div>
  );
}

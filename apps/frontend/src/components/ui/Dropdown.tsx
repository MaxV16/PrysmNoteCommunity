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
      <div onClick={() => setIsOpen(!isOpen)}>{trigger}</div>
      {isOpen && (
        <div className="absolute right-0 z-40 mt-1 min-w-[180px] rounded border border-border bg-surface py-1 shadow-lg">
          {children}
        </div>
      )}
    </div>
  );
}

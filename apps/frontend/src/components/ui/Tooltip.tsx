"use client";

import { useState, useRef } from "react";

interface TooltipProps {
  content: string;
  children: React.ReactNode;
  position?: "top" | "bottom" | "left" | "right";
  delay?: number;
}

export function Tooltip({ content, children, position = "top", delay = 400 }: TooltipProps) {
  const [visible, setVisible] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout>>();

  const show = () => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  };
  const hide = () => {
    clearTimeout(timerRef.current);
    setVisible(false);
  };

  const positionClasses: Record<string, string> = {
    top: "bottom-full left-1/2 -translate-x-1/2 mb-1.5",
    bottom: "top-full left-1/2 -translate-x-1/2 mt-1.5",
    left: "right-full top-1/2 -translate-y-1/2 mr-1.5",
    right: "left-full top-1/2 -translate-y-1/2 ml-1.5",
  };

  const arrowClasses: Record<string, string> = {
    top: "top-full left-1/2 -translate-x-1/2 border-t-elevated border-x-transparent border-b-transparent",
    bottom: "bottom-full left-1/2 -translate-x-1/2 border-b-elevated border-x-transparent border-t-transparent",
    left: "left-full top-1/2 -translate-y-1/2 border-l-elevated border-y-transparent border-r-transparent",
    right: "right-full top-1/2 -translate-y-1/2 border-r-elevated border-y-transparent border-l-transparent",
  };

  return (
    <div className="relative inline-flex" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && (
        <div className={`absolute z-50 ${positionClasses[position]}`}>
          <div className="whitespace-nowrap rounded-md bg-elevated px-2.5 py-1.5 text-xs text-primary shadow-lg border border-border">
            {content}
          </div>
          <div className={`absolute h-0 w-0 border-4 ${arrowClasses[position]}`} />
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";

interface CodeBlockProps {
  code: string;
  compact?: boolean;
}

export function CodeBlock({ code, compact }: CodeBlockProps) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    void navigator.clipboard.writeText(code);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className="relative mt-3 overflow-hidden rounded-xl border border-border bg-base">
      <pre
        className={`overflow-x-auto p-3.5 text-xs leading-relaxed text-secondary${
          compact ? " max-h-40" : ""
        }`}
      >
        {code}
      </pre>
      <button
        type="button"
        onClick={handleCopy}
        className="absolute right-2 top-2 rounded-lg bg-elevated border border-border px-2 py-1 text-[10px] font-medium text-secondary hover:text-primary"
      >
        {copied ? "Copied" : "Copy"}
      </button>
    </div>
  );
}

export default CodeBlock;

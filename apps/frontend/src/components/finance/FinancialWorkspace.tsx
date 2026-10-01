"use client";

import { FinanceDashboard } from "@/components/finance/FinanceDashboard";

interface FinancialWorkspaceProps {
  onOpenAi?: () => void;
}

export function FinancialWorkspace({ onOpenAi }: FinancialWorkspaceProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <FinanceDashboard onOpenAi={onOpenAi} />
    </div>
  );
}

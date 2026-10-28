"use client";

import dynamic from "next/dynamic";

import { VaultExplorer } from "@/components/vault/VaultExplorer";


interface VaultWorkspaceProps {
  onOpenAi?: () => void;
}

/**
 * Vault workspace shell. The engine and the explorer are core, so every build
 * renders the same free notebook; the private build wraps the explorer with its
 * hosted entitlement check.
 */
export function VaultWorkspace({ onOpenAi }: VaultWorkspaceProps) {
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-base">
      <VaultExplorer onOpenAi={onOpenAi} />
    </div>
  );
}

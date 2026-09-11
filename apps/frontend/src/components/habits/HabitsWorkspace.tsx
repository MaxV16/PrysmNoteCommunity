"use client";

import { useState } from "react";
import { HabitTracker } from "@/components/habits/HabitTracker";
import { HabitForm } from "@/components/habits/HabitForm";
import { useHabits } from "@/hooks/useHabits";
import { AiPanelButton } from "@/components/ui/AiPanelButton";

interface HabitsWorkspaceProps {
  onOpenAi?: () => void;
}

export function HabitsWorkspace({ onOpenAi }: HabitsWorkspaceProps) {
  const [showForm, setShowForm] = useState(false);
  const { habits, loading, createHabit, toggleLog, deleteHabit } = useHabits();

  return (
    <div className="flex flex-col bg-base" style={{ flex: 1, minWidth: 0, minHeight: 0, overflow: "hidden" }}>
      <div className="flex items-center gap-3 border-b border-border bg-surface px-4 py-2 shrink-0">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
          <path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/>
          <polyline points="22 4 12 14.01 9 11.01"/>
        </svg>
        <span className="text-lg font-bold text-primary">Habits</span>
        <div className="flex-1" />
        {onOpenAi && <AiPanelButton onClick={onOpenAi} />}
        <button
          onClick={() => setShowForm((v) => !v)}
          className="btn btn-primary px-4 py-1.5 text-xs"
        >
          {showForm ? "Cancel" : "+ New Habit"}
        </button>
      </div>
      <div className="flex-1 overflow-y-auto p-4">
        {showForm && (
          <div className="mb-4 max-w-md">
            <HabitForm createHabit={createHabit} onCreated={() => setShowForm(false)} />
          </div>
        )}
        <HabitTracker habits={habits} loading={loading} toggleLog={toggleLog} deleteHabit={deleteHabit} />
      </div>
    </div>
  );
}
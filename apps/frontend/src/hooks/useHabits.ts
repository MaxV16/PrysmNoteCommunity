"use client";

import { useState, useCallback, useEffect } from "react";
import { api } from "@/lib/api";
import type { Habit, HabitLog } from "@/types/habit";

export function useHabits() {
  const [habits, setHabits] = useState<Habit[]>([]);
  const [loading, setLoading] = useState(true);

  const fetchHabits = useCallback(async () => {
    try {
      const data = await api.get<Habit[]>("/habits");
      setHabits(data);
    } catch {
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchHabits();
  }, [fetchHabits]);

  const createHabit = useCallback(
    async (input: { title: string; frequency: string; target_count?: number; color?: string }) => {
      const h = await api.post<Habit>("/habits", input);
      setHabits((prev) => [...prev, h]);
      return h;
    },
    [],
  );

  const toggleLog = useCallback(async (habitId: string) => {
    const result = await api.post<{ streak: number }>(`/habits/${habitId}/log`);
    setHabits((prev) =>
      prev.map((h) => (h.id === habitId ? { ...h, streak: result.streak } : h)),
    );
  }, []);

  const deleteHabit = useCallback(async (habitId: string) => {
    await api.delete(`/habits/${habitId}`);
    setHabits((prev) => prev.filter((h) => h.id !== habitId));
  }, []);

  const getLogs = useCallback(async (habitId: string, from: string, to: string) => {
    return api.get<HabitLog[]>(`/habits/${habitId}/logs?from=${from}&to=${to}`);
  }, []);

  return { habits, loading, fetchHabits, createHabit, toggleLog, deleteHabit, getLogs };
}

"use client";

import { useCallback, useEffect, useState } from "react";
import {
  createTimelineSection,
  deleteTimelineSection,
  fetchTimelineSections,
  updateTimelineSection,
} from "@/lib/timeline-sections";
import type { TimelineRuleKind, TimelineSection, TimelineSectionInput } from "@/lib/timeline-sections";

export type { TimelineRuleKind, TimelineSection, TimelineSectionInput };

/**
 * CRUD store for timeline sections (the sidebar section manager + the
 * horizontal pill-row panel). Loads once on mount and exposes optimistic
 * update/delete helpers so renames/rule picks feel instant.
 */
export function useSections() {
  const [sections, setSections] = useState<TimelineSection[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      setSections(await fetchTimelineSections());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const addSection = useCallback(async (input: TimelineSectionInput): Promise<TimelineSection> => {
    const created = await createTimelineSection(input);
    setSections((prev) => [...prev, created].sort((a, b) => a.position - b.position));
    return created;
  }, []);

  const renameSection = useCallback(
    async (id: string, patch: Partial<TimelineSectionInput>) => {
      const previous = sections;
      const optimistic = previous.map((s) => (s.id === id ? { ...s, ...patch } : s));
      setSections(optimistic);
      try {
        const updated = await updateTimelineSection(id, patch);
        setSections((prev) => prev.map((s) => (s.id === id ? updated : s)));
      } catch {
        setSections(previous);
      }
    },
    [sections]
  );

  const removeSection = useCallback(
    async (id: string) => {
      const previous = sections;
      setSections(previous.filter((s) => s.id !== id));
      try {
        await deleteTimelineSection(id);
      } catch {
        setSections(previous);
      }
    },
    [sections]
  );

  return { sections, loading, addSection, renameSection, removeSection };
}
"use client";

import { api } from "@/lib/api";

export type TimelineRuleKind = "list" | "tag" | "priority" | "status" | "all" | null;

export interface TimelineSection {
  id: string;
  name: string;
  color: string | null;
  start_pct: number;
  end_pct: number;
  rule_kind: TimelineRuleKind;
  rule_value: string | null;
  position: number;
}

export interface TimelineSectionInput {
  name: string;
  color?: string | null;
  start_pct?: number;
  end_pct?: number;
  rule_kind?: TimelineRuleKind;
  rule_value?: string | null;
  position?: number;
}

export const TIMELINE_SECTION_ENDPOINT = "/timeline-sections/";

export async function fetchTimelineSections(): Promise<TimelineSection[]> {
  const data = await api.get<TimelineSection[]>(TIMELINE_SECTION_ENDPOINT);
  return data ?? [];
}

export async function createTimelineSection(input: TimelineSectionInput): Promise<TimelineSection> {
  const data = await api.post<TimelineSection>(TIMELINE_SECTION_ENDPOINT, input);
  return data;
}

export async function updateTimelineSection(id: string, patch: Partial<TimelineSectionInput>): Promise<TimelineSection> {
  const data = await api.patch<TimelineSection>(`${TIMELINE_SECTION_ENDPOINT}${id}`, patch);
  return data;
}

export async function deleteTimelineSection(id: string): Promise<void> {
  await api.delete(`${TIMELINE_SECTION_ENDPOINT}${id}`);
}
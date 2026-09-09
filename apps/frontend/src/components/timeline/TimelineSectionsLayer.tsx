"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useDroppable } from "@dnd-kit/core";
import { DAY_HEADER_HEIGHT } from "./constants";
import { parseLocalDate } from "@/lib/utils";
import { Dropdown } from "@/components/ui/Dropdown";
import type { Task, TaskList } from "@/types/task";
import type { TimelineSection, TimelineRuleKind } from "@/hooks/useTimelineSections";

export const SECTION_DROPPABLE_PREFIX = "section:";

const SECTION_PALETTE = ["#4FC3F7", "#FFA726", "#66BB6A", "#BA68C8", "#EF5350", "#FFCA28"];

interface TimelineSectionsLayerProps {
  sections: TimelineSection[];
  tasks: Task[];
  days: Date[];
  dayWidth: number;
  bodyRef: React.RefObject<HTMLDivElement | null>;
  lists: TaskList[];
  tags: { id: string; name: string; color: string | null }[];
  onSplit: () => void;
  onRename: (id: string, name: string) => void;
  onSetRule: (id: string, kind: TimelineRuleKind, value: string | null) => void;
  onDelete: (id: string) => void;
}

interface TaskSpan {
  task: Task;
  index: number;
  endIndex: number;
}

function taskSpan(task: Task, days: Date[]): TaskSpan | null {
  const taskStart = task.start_date ? parseLocalDate(task.start_date) : null;
  const taskEnd = task.due_date ? parseLocalDate(task.due_date) : null;
  if (!taskStart && !taskEnd) return null;

  const startOfFirstDay = new Date(days[0]);
  startOfFirstDay.setHours(0, 0, 0, 0);
  const endOfLastDay = new Date(days[days.length - 1]);
  endOfLastDay.setHours(23, 59, 59, 999);

  const refDate = taskStart || taskEnd!;
  if (refDate < startOfFirstDay || refDate > endOfLastDay) return null;

  let dayIndex = -1;
  for (let i = 0; i < days.length; i++) {
    const d = new Date(days[i]);
    d.setHours(0, 0, 0, 0);
    const next = new Date(d);
    next.setDate(next.getDate() + 1);
    if (refDate >= d && refDate < next) {
      dayIndex = i;
      break;
    }
  }
  if (dayIndex === -1) return null;

  let endIndex = dayIndex;
  if (taskStart && taskEnd) {
    const diffMs = taskEnd.getTime() - taskStart.getTime();
    const spanDays = Math.max(1, Math.ceil(diffMs / (1000 * 60 * 60 * 24)) + 1);
    endIndex = dayIndex + spanDays - 1;
  }
  return { task, index: dayIndex, endIndex };
}

function matchesRule(task: Task, section: TimelineSection, lists: TaskList[], tags: { id: string; name: string; color: string | null }[]): boolean {
  const kind = section.rule_kind;
  const value = section.rule_value;
  if (!kind || kind === "all" || !value) return false;
  switch (kind) {
    case "priority":
      return value.split(",").map((p) => parseInt(p, 10)).includes(task.priority);
    case "status":
      return task.status === value;
    case "list":
      return task.list_id === value;
    case "tag":
      return (task.tags ?? []).some((t) => t.id === value);
    default:
      return false;
  }
}

function ruleSummary(section: TimelineSection, lists: TaskList[], tags: { id: string; name: string; color: string | null }[]): string | null {
  const kind = section.rule_kind;
  const value = section.rule_value;
  if (!kind || kind === "all" || !value) return null;
  switch (kind) {
    case "priority":
      return `Priority ${value}`;
    case "status":
      return `Status: ${value.replace(/_/g, " ")}`;
    case "list":
      return lists.find((l) => l.id === value)?.name ?? "List";
    case "tag":
      return `#${tags.find((t) => t.id === value)?.name ?? "tag"}`;
    default:
      return null;
  }
}

export function TimelineSectionsLayer({
  sections,
  tasks,
  days,
  dayWidth,
  bodyRef,
  lists,
  tags,
  onSplit,
  onRename,
  onSetRule,
  onDelete,
}: TimelineSectionsLayerProps) {
  const [scrollX, setScrollX] = useState(0);
  const [viewW, setViewW] = useState(1000);
  const initializedRef = useRef(false);

  useEffect(() => {
    const el = bodyRef.current;
    if (!el) return;
    const update = () => {
      setScrollX(el.scrollLeft);
      setViewW(el.clientWidth);
    };
    update();
    initializedRef.current = true;
    el.addEventListener("scroll", update, { passive: true });
    const ro = new ResizeObserver(update);
    ro.observe(el);
    return () => {
      el.removeEventListener("scroll", update);
      ro.disconnect();
    };
  }, [bodyRef]);

  const bandDayRange = useMemo(() => {
    // Map each section's viewport-percentage band onto the day index range
    // currently visible beneath it, so matching tasks can be shown inside.
    if (viewW === 0) return new Map<string, { i0: number; i1: number }>();
    const map = new Map<string, { i0: number; i1: number }>();
    for (const s of sections) {
      const x0 = scrollX + (s.start_pct / 100) * viewW;
      const x1 = scrollX + (s.end_pct / 100) * viewW;
      let i0 = Math.floor(x0 / dayWidth);
      let i1 = Math.floor((x1 - 1) / dayWidth);
      i0 = Math.max(0, Math.min(days.length - 1, i0));
      i1 = Math.max(0, Math.min(days.length - 1, i1));
      map.set(s.id, { i0, i1 });
    }
    return map;
  }, [sections, scrollX, viewW, dayWidth, days.length]);

  const spans = useMemo(() => {
    const list: TaskSpan[] = [];
    for (const t of tasks) {
      const span = taskSpan(t, days);
      if (span) list.push(span);
    }
    return list;
  }, [tasks, days]);

  const splitCovered = sections.some((s) => s.start_pct === 50 && s.end_pct === 100);

  return (
    <div className="pointer-events-none absolute inset-0 z-10" data-testid="timeline-sections-layer">
      {/* Split handle: sits at 50% of the current viewport when sections are on
          and nothing already occupies that band. Splitting parts the band
          rightward (50%..100%) into a new nameable segment. */}
      {sections.length < 5 && !splitCovered && (
        <button
          data-testid="timeline-section-split"
          onClick={(e) => {
            e.stopPropagation();
            onSplit();
          }}
          className="pointer-events-auto absolute z-30 flex h-7 w-7 -translate-x-1/2 items-center justify-center rounded-full border border-border bg-elevated text-secondary shadow-sm transition-colors hover:bg-hover hover:text-primary"
          style={{ left: "50%", top: DAY_HEADER_HEIGHT + 6 }}
          title="Split the timeline band at 50%"
          aria-label="Split timeline band"
        >
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round">
            <path d="M12 5v14M5 12h14" />
          </svg>
        </button>
      )}

      {sections.map((section, idx) => {
        const range = bandDayRange.get(section.id);
        const bandTasks = range
          ? spans.filter((s) => s.index <= range.i1 && s.endIndex >= range.i0 && matchesRule(s.task, section, lists, tags))
          : [];
        const summary = ruleSummary(section, lists, tags);
        const color = section.color ?? SECTION_PALETTE[idx % SECTION_PALETTE.length];
        return (
          <SectionBand
            key={section.id}
            section={section}
            color={color}
            summary={summary}
            bandTasks={bandTasks.map((s) => s.task).slice(0, 12)}
            onRename={onRename}
            onSetRule={onSetRule}
            onDelete={onDelete}
            lists={lists}
            tags={tags}
          />
        );
      })}
    </div>
  );
}

interface SectionBandProps {
  section: TimelineSection;
  color: string;
  summary: string | null;
  bandTasks: Task[];
  lists: TaskList[];
  tags: { id: string; name: string; color: string | null }[];
  onRename: (id: string, name: string) => void;
  onSetRule: (id: string, kind: TimelineRuleKind, value: string | null) => void;
  onDelete: (id: string) => void;
}

function SectionBand({
  section,
  color,
  summary,
  bandTasks,
  lists,
  tags,
  onRename,
  onSetRule,
  onDelete,
}: SectionBandProps) {
  const { setNodeRef } = useDroppable({
    id: `${SECTION_DROPPABLE_PREFIX}${section.id}`,
    data: { sectionId: section.id },
  });
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(section.name);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (editing) inputRef.current?.select();
  }, [editing]);

  const commit = () => {
    setEditing(false);
    const name = draft.trim();
    if (name && name !== section.name) onRename(section.id, name);
    else setDraft(section.name);
  };

  return (
    <div
      ref={setNodeRef}
      data-testid={`timeline-section-${section.id}`}
      data-section-band
      className="pointer-events-none absolute rounded-xl border border-border bg-surface/70 shadow-sm backdrop-blur-[1px]"
      style={{
        left: `${section.start_pct}%`,
        width: `calc(${section.end_pct - section.start_pct}% - 12px)`,
        top: DAY_HEADER_HEIGHT + 4,
        bottom: 8,
        borderTop: `3px solid ${color}`,
      }}
    >
      <div className="pointer-events-auto flex flex-wrap items-center gap-1.5 px-2 py-1.5 sm:px-2.5">
        <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
        {editing ? (
          <input
            ref={inputRef}
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => {
              if (e.key === "Enter") commit();
              if (e.key === "Escape") {
                setDraft(section.name);
                setEditing(false);
              }
            }}
            className="input-field h-6 min-w-0 flex-1 px-1.5 py-0 text-xs"
            aria-label={`Rename section ${section.name}`}
          />
        ) : (
          <button
            onClick={() => {
              setDraft(section.name);
              setEditing(true);
            }}
            className="max-w-[140px] truncate rounded px-1 py-0.5 text-xs font-semibold text-primary transition-colors hover:bg-hover"
            title="Click to rename"
          >
            {section.name}
          </button>
        )}

        {summary && (
          <span className="hidden rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent sm:inline">
            {summary}
          </span>
        )}

        <Dropdown
          trigger={
            <button
              className="flex h-6 w-6 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary"
              title="Section rule"
              aria-label="Section rule"
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M3 6h18M6 12h12M10 18h4" /></svg>
            </button>
          }
        >
          <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Filter tasks by</div>
          <button
            onClick={() => onSetRule(section.id, "all", null)}
            className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${!section.rule_kind || section.rule_kind === "all" ? "text-accent font-semibold" : "text-secondary"}`}
          >
            All tasks
          </button>
          <button
            onClick={() => onSetRule(section.id, "priority", "4,5")}
            className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "priority" ? "text-accent font-semibold" : "text-secondary"}`}
          >
            Priority 4-5
          </button>
          <button
            onClick={() => onSetRule(section.id, "priority", "1,2")}
            className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "priority" && section.rule_value === "1,2" ? "text-accent font-semibold" : "text-secondary"}`}
          >
            Priority 1-2
          </button>
          <button
            onClick={() => onSetRule(section.id, "status", "done")}
            className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "status" ? "text-accent font-semibold" : "text-secondary"}`}
          >
            Status: done
          </button>
          {lists.length > 0 && (
            <div className="mt-1 border-t border-border/60 pt-1">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">List</div>
              {lists.map((l) => (
                <button
                  key={l.id}
                  onClick={() => onSetRule(section.id, "list", l.id)}
                  className={`block w-full truncate px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "list" && section.rule_value === l.id ? "text-accent font-semibold" : "text-secondary"}`}
                >
                  {l.name}
                </button>
              ))}
            </div>
          )}
          {tags.length > 0 && (
            <div className="mt-1 border-t border-border/60 pt-1">
              <div className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wide text-muted">Tag</div>
              {tags.map((t) => (
                <button
                  key={t.id}
                  onClick={() => onSetRule(section.id, "tag", t.id)}
                  className={`block w-full truncate px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "tag" && section.rule_value === t.id ? "text-accent font-semibold" : "text-secondary"}`}
                >
                  #{t.name}
                </button>
              ))}
            </div>
          )}
        </Dropdown>

        <button
          onClick={() => onDelete(section.id)}
          className="flex h-6 w-6 items-center justify-center rounded-full text-muted transition-colors hover:bg-danger/10 hover:text-danger"
          title="Delete section"
          aria-label={`Delete section ${section.name}`}
        >
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
        </button>
      </div>

      {bandTasks.length > 0 && (
        <div className="max-h-[calc(100%-40px)] overflow-hidden px-1.5 pb-1.5">
          {bandTasks.map((t) => (
            <div
              key={t.id}
              className="truncate rounded-md border border-border/60 bg-elevated/70 px-1.5 py-0.5 text-[10px] text-secondary"
              title={`${t.title} - dropped here applies the section rule`}
            >
              {t.title}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
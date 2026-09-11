"use client";

import { useMemo } from "react";
import { Dropdown } from "@/components/ui/Dropdown";
import type { Task, TaskList } from "@/types/task";
import type { TimelineSection, TimelineRuleKind } from "@/hooks/useSections";
import { matchesRule, ruleSummary, sectionColor } from "@/lib/timeline-section-utils";

interface SectionsPanelProps {
  sections: TimelineSection[];
  tasks: Task[];
  days: Date[];
  lists: TaskList[];
  tags: { id: string; name: string; color: string | null }[];
  onOpenTask: (id: string) => void;
  onRename: (id: string, name: string) => void;
  onSetRule: (id: string, kind: TimelineRuleKind, value: string | null) => void;
  onDelete: (id: string) => void;
}

function inVisibleRange(task: Task, days: Date[]): boolean {
  if (days.length === 0) return false;
  const start = new Date(days[0]);
  start.setHours(0, 0, 0, 0);
  const end = new Date(days[days.length - 1]);
  end.setHours(23, 59, 59, 999);
  const ds = task.start_date ? new Date(`${task.start_date}T00:00:00`) : null;
  const de = task.due_date ? new Date(`${task.due_date}T00:00:00`) : null;
  const ref = ds || de;
  if (!ref || Number.isNaN(ref.getTime())) return false;
  return ref >= start && ref <= end;
}

/** Horizontal pill-row section manager: one non-overlay row per section with
 * the matching tasks as clickable chips. Replaces the old band overlay. */
export function SectionsPanel({
  sections,
  tasks,
  days,
  lists,
  tags,
  onOpenTask,
  onRename,
  onSetRule,
  onDelete,
}: SectionsPanelProps) {
  const rows = useMemo(() => {
    return sections.map((section, idx) => {
      const summary = ruleSummary(section, lists, tags);
      const matching = tasks.filter((t) => inVisibleRange(t, days) && matchesRule(t, section, lists, tags));
      return { section, idx, summary, matching };
    });
  }, [sections, tasks, days, lists, tags]);

  if (sections.length === 0) return null;

  return (
    <div className="flex shrink-0 flex-col gap-1.5 border-b border-border bg-surface/60 px-3 py-2" data-testid="sections-panel">
      {rows.map(({ section, idx, summary, matching }) => {
        const color = sectionColor(section, idx);
        return (
          <div key={section.id} className="flex items-center gap-2" data-testid={`sections-row-${section.id}`}>
            <span className="h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
            <button
              onClick={() => {
                const name = window.prompt("Rename section", section.name);
                const trimmed = name?.trim();
                if (trimmed && trimmed !== section.name) onRename(section.id, trimmed);
              }}
              className="max-w-[160px] truncate rounded px-1 py-0.5 text-xs font-semibold text-primary transition-colors hover:bg-hover"
              title="Click to rename"
            >
              {section.name}
            </button>
            {summary && (
              <span className="hidden shrink-0 rounded-full bg-accent/10 px-1.5 py-0.5 text-[10px] font-medium text-accent sm:inline">
                {summary}
              </span>
            )}
            <span className="shrink-0 rounded-full bg-elevated px-1.5 py-0.5 text-[10px] font-medium text-muted">
              {matching.length}
            </span>
            <Dropdown
              trigger={
                <button
                  className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-secondary transition-colors hover:bg-hover hover:text-primary"
                  title="Section rule"
                  aria-label={`Rule for ${section.name}`}
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
                onClick={() => onSetRule(section.id, "priority", "1")}
                className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "priority" && section.rule_value === "1" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Priority: High
              </button>
              <button
                onClick={() => onSetRule(section.id, "priority", "3")}
                className={`block w-full px-3 py-1.5 text-left text-xs transition-colors hover:bg-hover ${section.rule_kind === "priority" && section.rule_value === "3" ? "text-accent font-semibold" : "text-secondary"}`}
              >
                Priority: Low
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
              onClick={() => {
                if (window.confirm(`Delete section "${section.name}"?`)) onDelete(section.id);
              }}
              className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted transition-colors hover:bg-danger/10 hover:text-danger"
              title="Delete section"
              aria-label={`Delete section ${section.name}`}
            >
              <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M18 6 6 18M6 6l12 12" /></svg>
            </button>
            <div className="flex min-w-0 flex-1 flex-wrap gap-1">
              {matching.slice(0, 12).map((t) => (
                <button
                  key={t.id}
                  onClick={() => onOpenTask(t.id)}
                  className="max-w-[220px] truncate rounded-full border border-border/60 bg-elevated px-2 py-0.5 text-[10px] text-secondary transition-colors hover:border-accent/40 hover:text-primary"
                  title={t.title}
                >
                  {t.title}
                </button>
              ))}
              {matching.length > 12 && (
                <span className="rounded-full px-1.5 py-0.5 text-[10px] text-muted">+{matching.length - 12}</span>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}
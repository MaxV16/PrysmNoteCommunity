"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { minOverlayTop } from "@/lib/desktop-bridge";
import { MonthCalendar } from "./MonthCalendar";
import {
  applyEnd,
  describeRule,
  parseEnd,
  recurrencePresetLabel,
  toRRule,
  type RecurrenceEnd,
  type RecurrenceFrequency,
} from "@/lib/recurrence";

interface DateRecurrencePopoverProps {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  startDate: string | null;
  dueDate: string | null;
  recurrenceRule: string | null;
  recurrenceEndDate: string | null;
  onChange: (startDate: string | null, dueDate: string | null, recurrenceRule: string | null, recurrenceEndDate: string | null) => void;
  isAllDay?: boolean;
}

type View = "main" | "recurrence" | "custom";

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function weekdayFromIso(iso: string): string {
  const codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  return codes[(new Date(iso).getDay() + 6) % 7];
}

interface RecurrencePreset {
  labelKey: "daily" | "weekly" | "monthly" | "yearly" | "weekday";
  build: (d: string) => string;
}

const RECURRENCE_PRESETS: RecurrencePreset[] = [
  { labelKey: "daily", build: () => "FREQ=DAILY" },
  { labelKey: "weekly", build: (d: string) => `FREQ=WEEKLY;BYDAY=${weekdayFromIso(d)}` },
  { labelKey: "monthly", build: (d: string) => `FREQ=MONTHLY;BYMONTHDAY=${new Date(d).getDate()}` },
  { labelKey: "yearly", build: (d: string) => `FREQ=YEARLY;BYMONTHDAY=${new Date(d).getDate()}` },
  { labelKey: "weekday", build: () => "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
];

export function DateRecurrencePopover({
  open,
  triggerRef,
  onClose,
  startDate,
  dueDate,
  recurrenceRule,
  recurrenceEndDate,
  onChange,
}: DateRecurrencePopoverProps) {
  const [view, setView] = useState<View>("main");
  const [start, setStart] = useState<string | null>(startDate);
  const [due, setDue] = useState<string | null>(dueDate);
  const [rule, setRule] = useState<string | null>(recurrenceRule);
  const [end, setEnd] = useState<RecurrenceEnd>(() =>
    parseEnd(recurrenceRule, recurrenceEndDate)
  );

  // Synchronize with the task values whenever reopened.
  useEffect(() => {
    if (open) {
      setStart(startDate);
      setDue(dueDate);
      setRule(recurrenceRule);
      setEnd(parseEnd(recurrenceRule, recurrenceEndDate));
      setView("main");
    }
  }, [open, startDate, dueDate, recurrenceRule, recurrenceEndDate]);

  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  // Phones get a bottom sheet instead of a 320px floating card: on a full-width
  // mobile drawer the anchored card covers the title and description.
  const [sheet, setSheet] = useState(
    () => typeof window !== "undefined" && window.innerWidth < 640
  );
  useEffect(() => {
    const onResize = () => setSheet(window.innerWidth < 640);
    window.addEventListener("resize", onResize);
    return () => window.removeEventListener("resize", onResize);
  }, []);

  useLayoutEffect(() => {
    if (!open || sheet) {
      setPos(null);
      return;
    }
    const menuW = 320;
    const compute = () => {
      const menu = menuRef.current;
      const menuH = menu ? menu.getBoundingClientRect().height : 480;
      const minTop = minOverlayTop(12);
      // The anchor button can be missing or not laid out yet (drawer just
      // opened, window resizing). Fall back to the top-left but never onto the
      // desktop window controls, and let the retry loop re-anchor.
      const rect = triggerRef.current?.getBoundingClientRect();
      if (!rect || (rect.width === 0 && rect.height === 0)) {
        return { top: minTop, left: 12, width: menuW };
      }
      let left = Math.min(rect.left, window.innerWidth - menuW - 12);
      left = Math.max(12, left);
      let top = rect.bottom + 6;
      if (top + menuH > window.innerHeight - 12) {
        top = Math.max(minTop, rect.top - menuH - 6);
      }
      return { top: Math.max(minTop, top), left, width: menuW };
    };
    setPos(compute());
    // Re-measure after layout settles, and keep the popover glued to its
    // trigger when the window is resized or the page scrolls underneath it.
    const raf = requestAnimationFrame(() => setPos(compute()));
    const onReflow = () => setPos(compute());
    window.addEventListener("resize", onReflow);
    window.addEventListener("scroll", onReflow, true);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("resize", onReflow);
      window.removeEventListener("scroll", onReflow, true);
    };
  }, [open, triggerRef, view, sheet]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        if (view !== "main") {
          setView("main");
        } else {
          onClose();
        }
      }
    };
    const onDown = (e: MouseEvent) => {
      if (
        menuRef.current &&
        !menuRef.current.contains(e.target as Node) &&
        triggerRef.current &&
        !triggerRef.current.contains(e.target as Node)
      ) {
        onClose();
      }
    };
    document.addEventListener("keydown", onKey);
    document.addEventListener("mousedown", onDown);
    return () => {
      document.removeEventListener("keydown", onKey);
      document.removeEventListener("mousedown", onDown);
    };
  }, [open, onClose, triggerRef, view]);

  const anchorDate = due || start || new Date().toISOString().split("T")[0];

  // Custom recurrence draft state.
  const [custom, setCustom] = useState<{
    freq: RecurrenceFrequency;
    interval: number;
    byDay: string;
    anchor: "due" | "completion";
    skipWeekends: boolean;
  }>({ freq: "monthly", interval: 1, byDay: weekdayFromIso(anchorDate), anchor: "due", skipWeekends: false });

  // Single source of truth for end-condition encoding: both the recurrence and
  // custom views commit through here so COUNT/date rules are built by applyEnd
  // in exactly one place.
  const commit = (ruleValue: string | null) => {
    const { recurrence_rule, recurrence_end_date } = applyEnd(ruleValue || "", end);
    // A repeat needs a date to anchor the series: when a rule is applied with no
    // date picked, default it to today so the template is visible and expandable.
    const todayIso = new Date().toISOString().split("T")[0];
    const committedStart = ruleValue ? (start || todayIso) : start;
    const committedDue = ruleValue ? (due || start || todayIso) : due;
    onChange(committedStart, committedDue, recurrence_rule || null, recurrence_end_date);
    onClose();
  };

  const clear = () => {
    setStart(null);
    setDue(null);
    setRule(null);
    setEnd({ kind: "never" });
  };

  const quickActions: { label: string; build: () => string }[] = [
    { label: "Today", build: () => new Date().toISOString().split("T")[0] },
    { label: "Tomorrow", build: () => addDays(new Date().toISOString().split("T")[0], 1) },
    { label: "+7 Days", build: () => addDays(new Date().toISOString().split("T")[0], 7) },
    {
      label: "Next Week",
      build: () => {
        const today = new Date();
        const day = today.getDay(); // 0=Sun..6=Sat
        const daysUntilNextMon = day === 0 ? 1 : 8 - day;
        return addDays(today.toISOString().split("T")[0], daysUntilNextMon);
      },
    },
  ];

  if (!open) return null;

  const body = (
    <>
        {view === "main" && (
          <MainView
            startDate={start}
            dueDate={due}
            setStart={setStart}
            setDue={setDue}
            rule={rule ?? recurrenceRule}
            onOpenRecurrence={() => setView("recurrence")}
            quickActions={quickActions}
          />
        )}
        {view === "recurrence" && (
          <RecurrenceView
            date={due || start || new Date().toISOString().split("T")[0]}
            rule={rule}
            setRule={setRule}
            end={end}
            setEnd={setEnd}
            onCustom={() => setView("custom")}
            onBack={() => setView("main")}
            onCommit={() => commit(rule)}
          />
        )}
        {view === "custom" && (
          <CustomView
            onCommit={() => {
              const r = toRRule({
                type: "custom",
                freq: custom.freq,
                interval: custom.interval,
                byDay: custom.byDay,
                dayOfMonth: due ? new Date(due).getDate() : start ? new Date(start).getDate() : undefined,
                skipWeekends: custom.skipWeekends,
              });
              commit(r);
            }}
            onCancel={() => setView("recurrence")}
            custom={custom}
            setCustom={setCustom}
          />
        )}
      {view === "main" && <Footer onCommit={() => commit(rule)} onClear={clear} />}
    </>
  );

  if (sheet) {
    return createPortal(
      <div
        className="fixed inset-0 z-[70]"
        style={{ top: "var(--desktop-titlebar, 0px)" }}
      >
        <div className="absolute inset-0 bg-black/50" aria-hidden onClick={onClose} />
        <div
          ref={menuRef}
          role="dialog"
          aria-modal="true"
          aria-label="Set reminder"
          className="absolute inset-x-0 bottom-0 flex max-h-[85dvh] flex-col overflow-hidden rounded-t-2xl border border-border bg-surface pb-safe shadow-2xl"
          onClick={(e) => e.stopPropagation()}
        >
          {body}
        </div>
      </div>,
      document.body
    );
  }

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      className="fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      style={{ top: pos?.top ?? minOverlayTop(12), left: pos?.left ?? 12, width: "min(320px, calc(100vw - 24px))", maxHeight: "min(32rem, 90dvh)" }}
    >
      {body}
    </div>,
    document.body
  );
}

function Header({ title, onBack }: { title: string; onBack?: () => void }) {
  return (
    <div className="flex items-center gap-2 border-b border-border px-3 py-2">
      {onBack && (
        <button onClick={onBack} className="text-xs text-muted hover:text-primary">
          ‹
        </button>
      )}
      <span className="text-xs font-semibold text-primary">{title}</span>
    </div>
  );
}

function Segmented({ options, value, onChange }: { options: string[]; value: string; onChange: (v: string) => void }) {
  return (
    <div className="flex rounded-lg border border-border bg-elevated p-0.5">
      {options.map((o) => (
        <button
          key={o}
          onClick={() => onChange(o)}
          className="flex-1 rounded-md px-2 py-1 text-[11px] font-medium transition-colors"
          style={value === o ? { backgroundColor: "var(--accent)", color: "var(--on-gradient)" } : { color: "var(--text-secondary)" }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function MainView({
  startDate,
  dueDate,
  setStart,
  setDue,
  rule,
  onOpenRecurrence,
  quickActions,
}: {
  startDate: string | null;
  dueDate: string | null;
  setStart: (d: string) => void;
  setDue: (d: string) => void;
  rule: string | null;
  onOpenRecurrence: () => void;
  quickActions: { label: string; build: () => string }[];
}) {
  const startStr = startDate || new Date().toISOString().split("T")[0];
  const dueStr = dueDate || startDate || new Date().toISOString().split("T")[0];
  const summary = describeRule(rule);

  const handleQuickAction = (iso: string) => {
    // Quick actions set both dates to the same value
    setStart(iso);
    setDue(iso);
  };

  return (
    <div className="flex flex-col overflow-y-auto">
      <Header title="Set dates" />
      <div className="px-3 pt-2">
        <div className="flex flex-wrap gap-1.5">
          {quickActions.map((a) => (
            <button
              key={a.label}
              onClick={() => handleQuickAction(a.build())}
              className="rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-secondary hover:text-primary hover:border-accent/40 transition-colors"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="px-3 py-2 space-y-3">
        <div>
          <label className="block text-[10px] font-medium text-muted mb-1">Start date</label>
          <MonthCalendar value={startStr} onChange={setStart} />
        </div>
        <div>
          <label className="block text-[10px] font-medium text-muted mb-1">Due date</label>
          <MonthCalendar value={dueStr} onChange={setDue} />
        </div>
      </div>
      <div className="mx-3 border-t border-border/60 py-1">
        <Row
          icon={
            <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden>
              <path d="M4 12a8 8 0 0 1 13.7-5.6L20 8" />
              <path d="M20 4v4h-4" />
              <path d="M20 12a8 8 0 0 1-13.7 5.6L4 16" />
              <path d="M4 20v-4h4" />
            </svg>
          }
          label={summary ? `Every ${summary.toLowerCase()}` : "Repeat"}
          onClick={onOpenRecurrence}
          arrow
        />
      </div>
    </div>
  );
}

function Row({ icon, label, onClick, arrow }: { icon: ReactNode; label: string; onClick: () => void; arrow?: boolean }) {
  return (
    <button
      onClick={onClick}
      className="flex w-full items-center gap-2 px-1 py-2 text-left text-xs text-secondary hover:bg-hover hover:text-primary rounded-md transition-colors"
    >
      <span className="w-4 text-center text-muted">{icon}</span>
      <span className="flex-1">{label}</span>
      {arrow && <span className="text-muted">›</span>}
    </button>
  );
}

function Footer({ onCommit, onClear }: { onCommit: () => void; onClear: () => void }) {
  return (
    <div className="flex items-center justify-between border-t border-border px-3 py-2">
      <button onClick={onClear} className="rounded-lg px-3 py-1.5 text-xs text-secondary hover:text-danger border border-border/60">
        Clear
      </button>
      <button onClick={onCommit} className="rounded-lg bg-accent px-5 py-1.5 text-xs font-semibold text-[var(--on-gradient)] hover:opacity-90">
        OK
      </button>
    </div>
  );
}

function RecurrenceView({
  date,
  rule,
  setRule,
  end,
  setEnd,
  onCustom,
  onBack,
  onCommit,
}: {
  date: string;
  rule: string | null;
  setRule: (r: string) => void;
  end: RecurrenceEnd;
  setEnd: (e: RecurrenceEnd) => void;
  onCustom: () => void;
  onBack: () => void;
  onCommit: () => void;
}) {
  const endLabel = end.kind === "never" ? "Never" : end.kind === "date" ? "On a date" : "After N";

  return (
    <div className="flex flex-col overflow-y-auto">
      <Header title="Repeat" onBack={onBack} />
      <div className="flex flex-col p-1">
        {RECURRENCE_PRESETS.map((p) => {
          const active = rule === p.build(date);
          return (
            <button
              key={p.labelKey}
              onClick={() => setRule(p.build(date))}
              className={`flex items-center justify-between rounded-md px-3 py-2 text-left text-xs transition-colors ${active ? "bg-accent/15 text-accent" : "text-secondary hover:bg-hover hover:text-primary"}`}
            >
              <span>{recurrencePresetLabel(p.labelKey, date)}</span>
              {active && <span className="text-accent">✓</span>}
            </button>
          );
        })}
        <div className="my-1 h-px bg-border/60" />
        <button
          onClick={onCustom}
          className="flex items-center justify-between rounded-md px-3 py-2 text-left text-xs text-secondary hover:bg-hover hover:text-primary"
        >
          <span>Custom</span>
          <span className="text-muted">›</span>
        </button>
      </div>
      <div className="border-t border-border px-3 py-2">
        <div className="mb-1.5 text-[11px] font-semibold text-secondary">Ends</div>
        <Segmented
          options={["Never", "On a date", "After N"]}
          value={endLabel}
          onChange={(v) => {
            if (v === "Never") setEnd({ kind: "never" });
            else if (v === "On a date") setEnd({ kind: "date", date: date });
            else setEnd({ kind: "count", count: 10 });
          }}
        />
        {end.kind === "date" && (
          <input
            type="date"
            value={end.date}
            onChange={(e) => setEnd({ kind: "date", date: e.target.value })}
            className="input-field mt-2 h-8 w-full text-xs"
          />
        )}
        {end.kind === "count" && (
          <div className="mt-2 flex items-center gap-2 text-xs text-secondary">
            <span>After</span>
            <input
              type="number"
              min={1}
              value={end.count}
              onChange={(e) => setEnd({ kind: "count", count: Math.max(1, Number(e.target.value) || 1) })}
              className="input-field h-8 w-16 text-center text-xs"
            />
            <span>occurrences</span>
          </div>
        )}
      </div>
      <div className="border-t border-border px-3 py-2">
        <button onClick={onCommit} className="w-full rounded-lg bg-accent px-5 py-1.5 text-xs font-semibold text-[var(--on-gradient)] hover:opacity-90">
          OK
        </button>
      </div>
    </div>
  );
}

function CustomView({
  onCommit,
  onCancel,
  custom,
  setCustom,
}: {
  onCommit: () => void;
  onCancel: () => void;
  custom: { freq: RecurrenceFrequency; interval: number; byDay: string; anchor: "due" | "completion"; skipWeekends: boolean };
  setCustom: (c: typeof custom) => void;
}) {
  return (
    <div className="flex flex-col overflow-y-auto">
      <Header title="Custom repeat" onBack={onCancel} />
      <div className="flex flex-col gap-3 p-3">
        <Segmented
          options={["By due dates", "By completion date"]}
          value={custom.anchor === "due" ? "By due dates" : "By completion date"}
          onChange={(v) => setCustom({ ...custom, anchor: v === "By due dates" ? "due" : "completion" })}
        />
        <div className="flex items-center gap-2 text-xs text-secondary">
          <span>Every</span>
          <input
            type="number"
            min={1}
            value={custom.interval}
            onChange={(e) => setCustom({ ...custom, interval: Math.max(1, Number(e.target.value) || 1) })}
            className="input-field h-8 w-12 text-center text-xs"
          />
          <select
            value={custom.freq}
            onChange={(e) => setCustom({ ...custom, freq: e.target.value as RecurrenceFrequency })}
            className="input-field h-8 text-xs"
          >
            <option value="daily">Day</option>
            <option value="weekly">Week</option>
            <option value="monthly">Month</option>
            <option value="yearly">Year</option>
          </select>
        </div>
        <Segmented
          options={["Each", "On the", "Workday"]}
          value={custom.skipWeekends ? "Workday" : custom.freq === "weekly" ? "On the" : "Each"}
          onChange={(v) => setCustom({ ...custom, skipWeekends: v === "Workday" })}
        />
        <label className="flex items-center gap-2 text-xs text-secondary">
          <input
            type="checkbox"
            checked={custom.skipWeekends}
            onChange={(e) => setCustom({ ...custom, skipWeekends: e.target.checked })}
            className="accent-[var(--accent)]"
          />
          Skip weekends
        </label>
      </div>
      <div className="mt-auto flex items-center justify-between border-t border-border px-3 py-2">
        <button onClick={onCancel} className="rounded-lg px-3 py-1.5 text-xs text-secondary hover:text-primary border border-border/60">
          Cancel
        </button>
        <button onClick={onCommit} className="rounded-lg bg-accent px-5 py-1.5 text-xs font-semibold text-[var(--on-gradient)] hover:opacity-90">
          OK
        </button>
      </div>
    </div>
  );
}

"use client";

import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { MonthCalendar } from "./MonthCalendar";
import {
  describeRule,
  toRRule,
  type RecurrenceFrequency,
} from "@/lib/recurrence";

interface DateRecurrencePopoverProps {
  open: boolean;
  triggerRef: React.RefObject<HTMLElement | null>;
  onClose: () => void;
  value: string | null; // ISO date
  recurrenceRule: string | null;
  onChange: (value: string | null, recurrenceRule: string | null) => void;
  isAllDay?: boolean;
}

type View = "main" | "recurrence" | "custom";

function addDays(iso: string, days: number): string {
  const d = new Date(iso);
  d.setDate(d.getDate() + days);
  return d.toISOString().split("T")[0];
}

function isWeekend(iso: string): boolean {
  const d = new Date(iso);
  const day = d.getDay();
  return day === 0 || day === 6;
}

function weekdayFromIso(iso: string): string {
  const codes = ["MO", "TU", "WE", "TH", "FR", "SA", "SU"];
  return codes[(new Date(iso).getDay() + 6) % 7];
}

const RECURRENCE_PRESETS = [
  { labelKey: "daily", label: "Daily", build: (d: string) => "FREQ=DAILY" },
  { labelKey: "weekly", label: (d: string) => "", build: (d: string) => `FREQ=WEEKLY;BYDAY=${weekdayFromIso(d)}` },
  { labelKey: "monthly", label: (d: string) => "", build: (d: string) => `FREQ=MONTHLY;BYMONTHDAY=${new Date(d).getDate()}` },
  { labelKey: "yearly", label: (d: string) => "", build: (d: string) => `FREQ=YEARLY;BYMONTHDAY=${new Date(d).getDate()}` },
  { labelKey: "weekday", label: "Every Weekday (Mon–Fri)", build: () => "FREQ=WEEKLY;BYDAY=MO,TU,WE,TH,FR" },
];

function presetLabel(p: { labelKey: string; label: string | ((d: string) => string) }, d: string): string {
  return typeof p.label === "function" ? p.label(d) : p.label;
}

export function DateRecurrencePopover({
  open,
  triggerRef,
  onClose,
  value,
  recurrenceRule,
  onChange,
}: DateRecurrencePopoverProps) {
  const [view, setView] = useState<View>("main");
  const [date, setDate] = useState<string | null>(value);
  const [rule, setRule] = useState<string | null>(recurrenceRule);

  // Synchronize with the task values whenever reopened.
  useEffect(() => {
    if (open) {
      setDate(value);
      setRule(recurrenceRule);
      setView("main");
    }
  }, [open, value, recurrenceRule]);

  const [pos, setPos] = useState<{ top: number; left: number; width: number } | null>(null);
  const menuRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    if (!open) {
      setPos(null);
      return;
    }
    const trigger = triggerRef.current;
    if (!trigger) return;
    const rect = trigger.getBoundingClientRect();
    const compute = () => {
      const menu = menuRef.current;
      const menuW = 320;
      const menuH = menu ? menu.getBoundingClientRect().height : 480;
      let left = Math.min(rect.left, window.innerWidth - menuW - 12);
      left = Math.max(12, left);
      let top = rect.bottom + 6;
      if (top + menuH > window.innerHeight - 12) {
        top = Math.max(12, rect.top - menuH - 6);
      }
      return { top, left, width: menuW };
    };
    setPos(compute());
    const raf = requestAnimationFrame(() => setPos(compute()));
    return () => cancelAnimationFrame(raf);
  }, [open, triggerRef, view]);

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

  const dateStr = date || new Date().toISOString().split("T")[0];
  const recurrenceSummary = describeRule(open ? (view === "recurrence" || view === "custom" ? rule : recurrenceRule) : recurrenceRule);

  // Custom recurrence draft state.
  const [custom, setCustom] = useState<{
    freq: RecurrenceFrequency;
    interval: number;
    byDay: string;
    anchor: "due" | "completion";
    skipWeekends: boolean;
  }>({ freq: "monthly", interval: 1, byDay: weekdayFromIso(dateStr), anchor: "due", skipWeekends: false });

  const commit = () => {
    onChange(date, rule && rule.trim() ? rule : null);
    onClose();
  };

  const clear = () => {
    setDate(null);
    setRule(null);
  };

  const quickActions: { label: string; build: () => string }[] = [
    { label: "Today", build: () => new Date().toISOString().split("T")[0] },
    { label: "Tomorrow", build: () => addDays(new Date().toISOString().split("T")[0], 1) },
    { label: "+7 Days", build: () => addDays(new Date().toISOString().split("T")[0], 7) },
    { label: "Next Week", build: () => addDays(new Date().toISOString().split("T")[0], 7) },
  ];

  return createPortal(
    <div
      ref={menuRef}
      role="dialog"
      className="fixed z-[70] flex flex-col overflow-hidden rounded-xl border border-border bg-surface shadow-2xl"
      style={{ top: pos?.top, left: pos?.left, width: 320, maxHeight: "min(32rem, 90vh)" }}
    >
      {view === "main" && (
        <MainView
          date={date}
          setDate={setDate}
          rule={rule ?? recurrenceRule}
          onOpenRecurrence={() => setView("recurrence")}
          quickActions={quickActions}
        />
      )}
      {view === "recurrence" && (
        <RecurrenceView
          date={dateStr}
          rule={rule}
          setRule={setRule}
          onCustom={() => setView("custom")}
          onBack={() => setView("main")}
          onCommit={commit}
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
              dayOfMonth: date ? new Date(date).getDate() : undefined,
              skipWeekends: custom.skipWeekends,
            });
            setRule(r);
            onChange(date, r || null);
            onClose();
          }}
          onCancel={() => setView("recurrence")}
          custom={custom}
          setCustom={setCustom}
        />
      )}
      {view === "main" && <Footer onCommit={commit} onClear={clear} />}
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
          style={value === o ? { backgroundColor: "var(--accent)", color: "#fff" } : { color: "var(--text-secondary)" }}
        >
          {o}
        </button>
      ))}
    </div>
  );
}

function MainView({
  date,
  setDate,
  rule,
  onOpenRecurrence,
  quickActions,
}: {
  date: string | null;
  setDate: (d: string) => void;
  rule: string | null;
  onOpenRecurrence: () => void;
  quickActions: { label: string; build: () => string }[];
}) {
  const [seg, setSeg] = useState("Date");
  const dateStr = date || new Date().toISOString().split("T")[0];
  const summary = describeRule(rule);

  return (
    <div className="flex flex-col overflow-y-auto">
      <Header title="Set reminder" />
      <div className="px-3 pt-2">
        <Segmented options={["Date", "Duration"]} value={seg} onChange={setSeg} />
      </div>
      <div className="px-3 pt-2">
        <div className="flex flex-wrap gap-1.5">
          {quickActions.map((a) => (
            <button
              key={a.label}
              onClick={() => setDate(a.build())}
              className="rounded-md border border-border bg-elevated px-2 py-1 text-[11px] text-secondary hover:text-primary hover:border-accent/40 transition-colors"
            >
              {a.label}
            </button>
          ))}
        </div>
      </div>
      <div className="px-3 py-2">
        <MonthCalendar value={dateStr} onChange={setDate} />
      </div>
      <div className="mx-3 border-t border-border/60 py-1">
        <Row icon="🕒" label="Time" onClick={() => {}} />
        <Row icon="🔔" label="Reminder" onClick={() => {}} />
        <Row icon="🔄" label={summary ? `Every ${summary.toLowerCase()}` : "Repeat"} onClick={onOpenRecurrence} arrow />
        <Row icon="♾️" label="Endlessly" onClick={() => {}} />
      </div>
    </div>
  );
}

function Row({ icon, label, onClick, arrow }: { icon: string; label: string; onClick: () => void; arrow?: boolean }) {
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
      <button onClick={onCommit} className="rounded-lg bg-accent px-5 py-1.5 text-xs font-semibold text-white hover:opacity-90">
        OK
      </button>
    </div>
  );
}

function RecurrenceView({
  date,
  rule,
  setRule,
  onCustom,
  onBack,
  onCommit,
}: {
  date: string;
  rule: string | null;
  setRule: (r: string) => void;
  onCustom: () => void;
  onBack: () => void;
  onCommit: () => void;
}) {
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
              <span>{presetLabel(p, date)}</span>
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
        <button onClick={onCommit} className="w-full rounded-lg bg-accent px-5 py-1.5 text-xs font-semibold text-white hover:opacity-90">
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
        <button onClick={onCommit} className="rounded-lg bg-accent px-5 py-1.5 text-xs font-semibold text-white hover:opacity-90">
          OK
        </button>
      </div>
    </div>
  );
}

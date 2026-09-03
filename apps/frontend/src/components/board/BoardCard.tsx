"use client";

import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { Task } from "@/types/task";
import { formatDate } from "@/lib/dates";
import { MUTED_PALETTE, type BoardDecoration } from "./board-utils";

const MAX_CHECKLIST_ROWS = 6;

interface BoardCardProps {
  task: Task;
  subtasks: Task[];
  color: string;
  width?: number;
  topOffset?: number;
  spanClass?: string;
  decoration: BoardDecoration;
  onOpen: (id: string) => void;
  onToggleSubtask: (sub: Task) => void;
  onToggleTask: (task: Task) => void;
  onSetColor: (taskId: string, color: string) => void;
  onContextMenu?: (e: React.MouseEvent, task: Task) => void;
}

function DecorativeLayer({ kind, color }: { kind: BoardDecoration; color: string }) {
  if (kind === "none") return null;
  const props = {
    className: "pointer-events-none absolute inset-0 h-full w-full opacity-15",
    viewBox: "0 0 200 200",
    fill: "none",
    preserveAspectRatio: "xMidYMid slice",
  } as const;
  switch (kind) {
    case "blob":
      return (
        <svg {...props}>
          <path
            d="M40 150C10 120 20 60 70 45c50-15 90 10 95 55 5 45-35 65-75 50S45 165 40 150z"
            fill={color}
          />
        </svg>
      );
    case "dots":
      return (
        <svg {...props}>
          <circle cx="42" cy="46" r="6" fill={color} />
          <circle cx="160" cy="64" r="9" fill={color} />
          <circle cx="118" cy="172" r="5" fill={color} />
          <circle cx="180" cy="150" r="7" fill={color} />
          <circle cx="30" cy="162" r="4" fill={color} />
        </svg>
      );
    case "arc":
      return (
        <svg {...props}>
          <path d="M30 172a70 70 0 0 1 140 0" stroke={color} strokeWidth="3" strokeLinecap="round" />
        </svg>
      );
    case "waves":
      return (
        <svg {...props}>
          <path
            d="M20 130c20-25 40 25 60 0s40 25 60 0 40 25 60 0"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
          />
          <path
            d="M20 160c20-25 40 25 60 0s40 25 60 0 40 25 60 0"
            stroke={color}
            strokeWidth="3"
            strokeLinecap="round"
            opacity="0.6"
          />
        </svg>
      );
    default:
      return null;
  }
}

function RoundCheckbox({
  checked,
  label,
  onToggle,
}: {
  checked: boolean;
  label: string;
  onToggle: () => void;
}) {
  return (
    <button
      onClick={(e) => {
        e.stopPropagation();
        onToggle();
      }}
      role="checkbox"
      aria-checked={checked}
      aria-label={label}
      className={`flex h-[18px] w-[18px] shrink-0 cursor-pointer items-center justify-center rounded-full border-2 transition-all ${
        checked ? "check-gradient border-transparent" : "border-[#5a5a72] hover:border-accent"
      }`}
    >
      {checked && (
        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
          <polyline points="20 6 9 17 4 12" />
        </svg>
      )}
    </button>
  );
}

export function BoardCard({
  task,
  subtasks,
  color,
  width,
  topOffset = 0,
  spanClass,
  decoration,
  onOpen,
  onToggleSubtask,
  onToggleTask,
  onSetColor,
  onContextMenu,
}: BoardCardProps) {
  const {
    attributes,
    listeners,
    setNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({
    id: task.id,
    data: { task },
  });

  const isDone = task.status === "done";
  const doneCount = subtasks.filter((s) => s.status === "done").length;
  const shownSubtasks = subtasks.slice(0, MAX_CHECKLIST_ROWS);

  return (
    <div
      ref={setNodeRef}
      data-testid="board-card"
      onClick={() => onOpen(task.id)}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu?.(e, task);
      }}
      className={`group relative flex ${
        width ? "" : "w-full"
      } shrink-0 cursor-pointer flex-col rounded-2xl border border-white/10 transition-colors duration-200 ${spanClass ?? ""}`}
      style={{
        width: width ?? undefined,
        marginTop: topOffset,
        backgroundColor: "#101016",
        backgroundImage: `linear-gradient(160deg, ${color}45, #101016 70%)`,
        boxShadow: `0 0 0 1px ${color}22, 0 2px 10px rgba(0, 0, 0, 0.35)`,
        transform: CSS.Transform.toString(transform),
        transition,
        opacity: isDragging ? 0.5 : 1,
      }}
    >
      <div
        className="pointer-events-none absolute inset-0 rounded-2xl opacity-0 transition-opacity duration-200 group-hover:opacity-100"
        style={{ boxShadow: `0 0 18px ${color}26` }}
      />
      <DecorativeLayer kind={decoration} color={color} />

      <div className="relative z-10 flex flex-col gap-2.5 p-4" {...attributes} {...listeners}>
        <div className="flex items-start gap-2">
          <span className="mt-1.5 h-2.5 w-2.5 shrink-0 rounded-full" style={{ backgroundColor: color }} />
          <h3 className={`min-w-0 flex-1 text-sm font-semibold leading-snug line-clamp-2 ${isDone ? "line-through text-muted" : "text-primary"}`}>
            {task.title}
          </h3>
          <RoundCheckbox
            checked={isDone}
            label={isDone ? `Mark ${task.title} not done` : `Mark ${task.title} done`}
            onToggle={() => onToggleTask(task)}
          />
        </div>

        {shownSubtasks.length > 0 && (
          <ul className="flex flex-col gap-1">
            {shownSubtasks.map((sub) => {
              const subDone = sub.status === "done";
              return (
                <li key={sub.id} onClick={(e) => e.stopPropagation()} className="flex items-center gap-2">
                  <RoundCheckbox
                    checked={subDone}
                    label={subDone ? `Mark ${sub.title} not done` : `Mark ${sub.title} done`}
                    onToggle={() => onToggleSubtask(sub)}
                  />
                  <span className={`min-w-0 flex-1 truncate text-xs ${subDone ? "line-through text-muted" : "text-secondary"}`}>
                    {sub.title}
                  </span>
                </li>
              );
            })}
            {subtasks.length > MAX_CHECKLIST_ROWS && (
              <li className="px-1 text-[10px] text-muted">+{subtasks.length - MAX_CHECKLIST_ROWS} more</li>
            )}
          </ul>
        )}

        {subtasks.length === 0 && task.description && (
          <p className="whitespace-pre-wrap text-xs leading-relaxed text-secondary line-clamp-3">
            {task.description}
          </p>
        )}

        <div className="flex items-center gap-1.5 pt-0.5">
          {subtasks.length > 0 && (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] font-medium text-secondary">
              {doneCount} of {subtasks.length} done
            </span>
          )}
          {task.due_date && (
            <span className="rounded-full bg-white/5 px-2 py-0.5 text-[10px] text-muted">
              {formatDate(new Date(task.due_date + "T00:00:00"), { includeYear: false })}
            </span>
          )}
          {task.tags && task.tags.length > 0 && (
            <span className="ml-auto flex shrink-0 gap-1">
              {task.tags.slice(0, 3).map((tag) => (
                <span
                  key={tag.id}
                  className="h-1.5 w-1.5 rounded-full"
                  style={{ backgroundColor: tag.color || "var(--text-muted)" }}
                  title={tag.name}
                />
              ))}
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5 opacity-100 transition-opacity focus-within:opacity-100 md:opacity-0 md:group-hover:opacity-100">
          {MUTED_PALETTE.map((c) => (
            <button
              key={c}
              onClick={(e) => {
                e.stopPropagation();
                onSetColor(task.id, c);
              }}
              aria-label={`Set card color ${c}`}
              className={`h-3 w-3 rounded-full transition-transform hover:scale-125 ${c === color ? "ring-1 ring-white/70" : ""}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
    </div>
  );
}

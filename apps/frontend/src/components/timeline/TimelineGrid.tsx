"use client";

interface TimelineGridProps {
  days: Date[];
}

export function TimelineGrid({ days }: TimelineGridProps) {
  const dayWidth = `${100 / days.length}%`;

  return (
    <div className="absolute inset-0 pointer-events-none flex min-h-full">
      {days.map((day) => (
        <div
          key={day.toISOString()}
          className="border-r border-border/30"
          style={{ width: dayWidth }}
        />
      ))}
    </div>
  );
}
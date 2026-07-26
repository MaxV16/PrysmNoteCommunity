"use client";

import { useState } from "react";
import { useHabits } from "@/hooks/useHabits";

const COLORS = ["#4C7EFF", "#22C55E", "#FF9500", "#EF4444", "#EC4899", "#A855F7"];

export function HabitForm({
  onCreated,
}: {
  onCreated: () => void;
}) {
  const { createHabit } = useHabits();
  const [title, setTitle] = useState("");
  const [frequency, setFrequency] = useState("daily");
  const [color, setColor] = useState(COLORS[0]);
  const [loading, setLoading] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!title.trim()) return;
    setLoading(true);
    try {
      await createHabit({ title: title.trim(), frequency, color });
      setTitle("");
      onCreated();
    } catch {
    } finally {
      setLoading(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="space-y-3">
      <h4 className="text-xs font-semibold text-secondary uppercase tracking-wider">New Habit</h4>
      <input
        className="input-field"
        placeholder="Habit name..."
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        maxLength={500}
      />
      <div className="flex gap-2">
        <select className="input-field flex-1" value={frequency} onChange={(e) => setFrequency(e.target.value)}>
          <option value="daily">Daily</option>
          <option value="weekly">Weekly</option>
          <option value="monthly">Monthly</option>
        </select>
        <div className="flex gap-1 items-center">
          {COLORS.map((c) => (
            <button
              key={c}
              type="button"
              onClick={() => setColor(c)}
              className={`w-6 h-6 rounded-full transition-all hover:scale-110 ${color === c ? "ring-2 ring-white scale-110" : ""}`}
              style={{ backgroundColor: c }}
            />
          ))}
        </div>
      </div>
      <button
        type="submit"
        disabled={loading || !title.trim()}
        className="w-full btn bg-accent text-white px-4 py-2 text-sm rounded-xl disabled:opacity-50"
      >
        {loading ? "Creating..." : "Add Habit"}
      </button>
    </form>
  );
}

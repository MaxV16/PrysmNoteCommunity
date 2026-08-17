export interface Habit {
  id: string;
  title: string;
  frequency: "daily" | "weekly" | "monthly";
  target_count: number;
  color: string | null;
  streak: number;
  created_at: string;
}

export interface HabitLog {
  id: string;
  habit_id: string;
  completed_at: string;
  created_at: string;
}

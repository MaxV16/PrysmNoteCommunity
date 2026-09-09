export type TaskStatus = "backlog" | "todo" | "in_progress" | "done" | "cancelled";

export interface TaskTag {
  id: string;
  name: string;
  color: string | null;
}

export interface TaskLink {
  id: string;
  source_task_id: string;
  target_task_id: string;
  link_type: string;
}

export interface Task {
  id: string;
  user_id: string;
  parent_task_id: string | null;
  board_section_id: string | null;
  board_order: number | null;
  title: string;
  description: string | null;
  status: TaskStatus;
  priority: number;
  start_date: string | null;
  due_date: string | null;
  start_time: string | null;
  end_time: string | null;
  is_all_day: boolean;
  estimated_minutes: number | null;
  recurrence_rule: string | null;
  recurrence_end_date: string | null;
  sort_order: number;
  is_archived: boolean;
  list_id: string | null;
  deleted_at: string | null;
  completed_at: string | null;
  created_at: string;
  updated_at: string;
  tags?: TaskTag[];
  links?: TaskLink[];
  subtasks?: Task[];
}

export interface TaskList {
  id: string;
  name: string;
  position: number;
  created_at: string | null;
  updated_at: string | null;
}

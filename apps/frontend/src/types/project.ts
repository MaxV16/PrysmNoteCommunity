export interface Project {
  id: string;
  user_id: string;
  parent_id: string | null;
  name: string;
  color: string | null;
  icon: string | null;
  sort_order: number;
  is_archived: boolean;
  created_at: string;
  updated_at: string;
}

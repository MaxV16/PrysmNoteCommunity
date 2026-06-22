export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "system" | "tool";
  content: string;
  tool_calls?: Record<string, unknown>[];
  created_at: string;
}

export interface AiSuggestion {
  id: string;
  type: "conflict" | "duplicate" | "subtask" | "reschedule";
  title: string;
  description: string;
  task_id?: string;
}

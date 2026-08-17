"use client";

import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useTags } from "@/hooks/useTags";

export function TagList() {
  const tags = useAppStore((s) => s.tags);
  const selectedTagId = useAppStore((s) => s.selectedTagId);
  const setSelectedTagId = useAppStore((s) => s.setSelectedTagId);
  const { createTag, deleteTag } = useTags();
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const colors = ["#4fc3f7", "#66bb6a", "#ffa726", "#ef5350", "#ab47bc", "#42a5f5", "#ef5350", "#78909c"];
    const color = colors[tags.length % colors.length];
    await createTag({ name: newName.trim(), color });
    setNewName("");
    setIsAdding(false);
  };

  const handleTagClick = (tagId: string) => {
    setSelectedTagId(selectedTagId === tagId ? null : tagId);
  };

  return (
    <div>
      <div className="mb-2 flex items-center justify-between px-1 pt-1">
        <h3 className="text-xs font-semibold uppercase tracking-wider text-muted">Tags</h3>
        <button
          onClick={() => setIsAdding(!isAdding)}
          className="text-xs text-accent hover:text-accent-hover font-medium"
        >
          + Add
        </button>
      </div>
      {isAdding && (
        <div className="mb-2 px-1">
          <input
            type="text"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === "Enter") handleCreate();
              if (e.key === "Escape") { setIsAdding(false); setNewName(""); }
            }}
            placeholder="Tag name"
            className="input-field text-xs"
            autoFocus
          />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => {
          const isActive = selectedTagId === tag.id;
          return (
            <span
              key={tag.id}
              onClick={() => handleTagClick(tag.id)}
              className={`badge gap-1.5 cursor-pointer group transition-all ${
                isActive ? "ring-2 ring-accent/50 scale-105" : ""
              }`}
              style={{
                backgroundColor: (tag.color || "#333") + (isActive ? "50" : "30"),
                color: tag.color || "var(--text-secondary)",
              }}
            >
              <span
                className="h-2 w-2 rounded-full shrink-0"
                style={{ backgroundColor: tag.color || "var(--text-muted)" }}
              />
              {tag.name}
              <button
                onClick={async (e) => {
                  e.stopPropagation();
                  try {
                    await deleteTag(tag.id);
                    if (isActive) setSelectedTagId(null);
                  } catch {
                    // tag delete failed silently
                  }
                }}
                className="ml-1 opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity text-xs font-bold"
              >
                ✕
              </button>
            </span>
          );
        })}
        {tags.length === 0 && !isAdding && (
          <p className="px-1 text-xs text-muted">No tags yet</p>
        )}
      </div>
    </div>
  );
}
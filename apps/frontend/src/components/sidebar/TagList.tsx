"use client";

import { useState } from "react";
import { useAppStore } from "@/stores/app-store";
import { useTags } from "@/hooks/useTags";
import { TAG_COLORS } from "@/lib/palette";
import { TAG_NAME_MAX } from "@/lib/char-limits";
import { CharLimitHint } from "@/components/ui/CharLimitHint";

export function TagList() {
  const tags = useAppStore((s) => s.tags);
  const selectedTagId = useAppStore((s) => s.selectedTagId);
  const setSelectedTagId = useAppStore((s) => s.setSelectedTagId);
  const { createTag, deleteTag } = useTags();
  const [isAdding, setIsAdding] = useState(false);
  const [newName, setNewName] = useState("");

  const handleCreate = async () => {
    if (!newName.trim()) return;
    const color = TAG_COLORS[tags.length % TAG_COLORS.length];
    if (newName.trim().length > TAG_NAME_MAX) return;
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
          <CharLimitHint value={newName} max={TAG_NAME_MAX} className="mt-1" />
        </div>
      )}
      <div className="flex flex-wrap gap-1.5">
        {tags.map((tag) => {
          const isActive = selectedTagId === tag.id;
          return (
            <div
              key={tag.id}
              role="button"
              tabIndex={0}
              aria-pressed={isActive}
              onClick={() => handleTagClick(tag.id)}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  handleTagClick(tag.id);
                }
              }}
              className={`badge gap-1.5 cursor-pointer group transition-all text-left outline-none focus-visible:ring-2 focus-visible:ring-accent/50 ${
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
                className="pointer-coarse:opacity-100 ml-1 opacity-0 group-hover:opacity-100 hover:text-danger transition-opacity text-xs font-bold"
                aria-label={`Delete tag ${tag.name}`}
              >
                ✕
              </button>
            </div>
          );
        })}
        {tags.length === 0 && !isAdding && (
          <p className="px-1 text-xs text-muted">No tags yet</p>
        )}
      </div>
    </div>
  );
}
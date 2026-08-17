"use client";

import { useCallback } from "react";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";

interface Tag {
  id: string;
  name: string;
  color: string | null;
}

export function useTags() {
  const { tags, setTags, addTag, removeTag } = useAppStore();

  const fetchTags = useCallback(async () => {
    const data = await api.get<Tag[]>("/tags/");
    setTags(data);
  }, [setTags]);

  const createTag = useCallback(
    async (tag: { name: string; color?: string }) => {
      const data = await api.post<Tag>("/tags/", tag);
      addTag(data);
      return data;
    },
    [addTag]
  );

  const deleteTag = useCallback(
    async (id: string) => {
      removeTag(id);
      try {
        await api.delete(`/tags/${id}`);
      } catch {
        // tag delete failed silently — already removed from local state
      }
    },
    [removeTag]
  );

  return { tags, fetchTags, createTag, deleteTag };
}

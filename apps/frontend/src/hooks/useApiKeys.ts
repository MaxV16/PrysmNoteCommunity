"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api";

interface ApiKey {
  id: string;
  provider: string;
  key_prefix: string;
  is_active: boolean;
}

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchKeys = useCallback(async () => {
    setLoading(true);
    try {
      const data = await api.get<ApiKey[]>("/keys/");
      setKeys(data);
    } catch {
      setKeys([]);
    } finally {
      setLoading(false);
    }
  }, []);

  const saveKey = useCallback(async (provider: string, apiKey: string) => {
    await api.post("/keys/", { provider, api_key: apiKey });
    await fetchKeys();
  }, [fetchKeys]);

  const deleteKey = useCallback(async (id: string) => {
    await api.delete(`/keys/${id}`);
    await fetchKeys();
  }, [fetchKeys]);

  return { keys, loading, fetchKeys, saveKey, deleteKey };
}

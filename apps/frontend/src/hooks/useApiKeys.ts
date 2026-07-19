"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api";

interface ApiKey {
  id: string;
  provider: string;
  key_prefix: string;
  is_active: boolean;
}

const LOCAL_KEY_PREFIX = "prysm_key_";

function btoaUnicode(str: string): string {
  return btoa(
    encodeURIComponent(str).replace(/%([0-9A-F]{2})/g, (_match, p1) =>
      String.fromCharCode(parseInt(p1, 16))
    )
  );
}

function atobUnicode(str: string): string {
  return decodeURIComponent(
    atob(str)
      .split("")
      .map((c) => "%" + ("00" + c.charCodeAt(0).toString(16)).slice(-2))
      .join("")
  );
}

function cacheKeyLocally(provider: string, apiKey: string) {
  if (typeof window === "undefined") return;
  localStorage.setItem(`${LOCAL_KEY_PREFIX}${provider}`, btoaUnicode(apiKey));
}

function removeLocalKey(provider: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(`${LOCAL_KEY_PREFIX}${provider}`);
}

function getLocalKey(provider: string): string | null {
  if (typeof window === "undefined") return null;
  const encoded = localStorage.getItem(`${LOCAL_KEY_PREFIX}${provider}`);
  if (!encoded) return null;
  try {
    return atobUnicode(encoded);
  } catch {
    return null;
  }
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
    cacheKeyLocally(provider, apiKey);
    await api.post("/keys/", { provider, api_key: apiKey });
    await fetchKeys();
  }, [fetchKeys]);

  const deleteKey = useCallback(async (id: string, provider: string) => {
    removeLocalKey(provider);
    await api.delete(`/keys/${id}`);
    await fetchKeys();
  }, [fetchKeys]);

  const syncKey = useCallback(async (provider: string, apiKey: string) => {
    cacheKeyLocally(provider, apiKey);
    await api.post("/keys/sync", { provider, api_key: apiKey });
  }, []);

  return { keys, loading, fetchKeys, saveKey, deleteKey, syncKey, getLocalKey };
}

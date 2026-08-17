"use client";

import { useState, useCallback } from "react";
import { api } from "@/lib/api";
import { encryptString, decryptString, clearCryptoKey } from "@/lib/crypto-utils";

interface ApiKey {
  id: string;
  provider: string;
  key_prefix: string;
  is_active: boolean;
}

const LOCAL_KEY_PREFIX = "prysm_key_";

async function cacheKeyLocally(provider: string, apiKey: string) {
  if (typeof window === "undefined") return;
  const encrypted = await encryptString(apiKey);
  localStorage.setItem(`${LOCAL_KEY_PREFIX}${provider}`, encrypted);
}

function removeLocalKey(provider: string) {
  if (typeof window === "undefined") return;
  localStorage.removeItem(`${LOCAL_KEY_PREFIX}${provider}`);
}

async function getLocalKey(provider: string): Promise<string | null> {
  if (typeof window === "undefined") return null;
  const encrypted = localStorage.getItem(`${LOCAL_KEY_PREFIX}${provider}`);
  if (!encrypted) return null;
  return decryptString(encrypted);
}

export function useApiKeys() {
  const [keys, setKeys] = useState<ApiKey[]>([]);
  const [loading, setLoading] = useState(false);

  const fetchKeys = useCallback(async (): Promise<ApiKey[]> => {
    setLoading(true);
    try {
      const data = await api.get<ApiKey[]>("/keys/");
      setKeys(data);
      return data;
    } catch {
      setKeys([]);
      return [];
    } finally {
      setLoading(false);
    }
  }, []);

  const saveKey = useCallback(async (provider: string, apiKey: string) => {
    await cacheKeyLocally(provider, apiKey);
    await api.post("/keys/", { provider, api_key: apiKey });
    await fetchKeys();
  }, [fetchKeys]);

  const deleteKey = useCallback(async (id: string, provider: string) => {
    removeLocalKey(provider);
    await api.delete(`/keys/${id}`);
    await fetchKeys();
  }, [fetchKeys]);

  const syncKey = useCallback(async (provider: string, apiKey: string) => {
    await cacheKeyLocally(provider, apiKey);
    await api.post("/keys/sync", { provider, api_key: apiKey });
  }, []);

  // Recover the caller's own stored key from the server (authenticated, returns
  // only keys that belong to the current account) and re-hydrate the local cache,
  // so a fresh tab/session doesn't require re-entering an already-saved key.
  const recoverKey = useCallback(async (provider: string): Promise<string | null> => {
    try {
      const data = await api.get<{ provider: string; api_key: string }>(`/keys/${provider}/key`);
      if (data?.api_key) {
        await cacheKeyLocally(provider, data.api_key);
        return data.api_key;
      }
      return null;
    } catch {
      return null;
    }
  }, []);

  return { keys, loading, fetchKeys, saveKey, deleteKey, syncKey, recoverKey, getLocalKey };
}

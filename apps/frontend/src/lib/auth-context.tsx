"use client";

import { createContext, useContext, useState, useCallback, useEffect, type ReactNode } from "react";
import type { User } from "@/types/user";
import { clearUserData } from "@/lib/clear-user-data";

const API_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api";

interface AuthContextValue {
  user: User | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  register: (email: string, password: string, displayName?: string) => Promise<void>;
  logout: () => void;
  refreshSession: () => Promise<boolean>;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: ReactNode }) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
        if (res.ok) {
          setUser(await res.json());
        } else {
          await fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" }).catch(() => {});
          const retry = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
          if (retry.ok) setUser(await retry.json());
        }
      } catch {
      }
      setLoading(false);
    })();
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await fetch(`${API_URL}/auth/login`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      credentials: "include",
      body: JSON.stringify({ email, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({ detail: "Login failed" }));
      throw new Error(err.detail || "Login failed");
    }
    const data = await res.json();
    // Account change: drop any lingering state/localStorage from a previous
    // account so the new login starts completely clean.
    clearUserData();
    setUser(data as User);
  }, []);

  const register = useCallback(
    async (email: string, password: string, displayName?: string) => {
      const res = await fetch(`${API_URL}/auth/register`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        credentials: "include",
        body: JSON.stringify({ email, password, display_name: displayName }),
      });
      if (!res.ok) {
        const err = await res.json().catch(() => ({ detail: "Registration failed" }));
        throw new Error(err.detail || "Registration failed");
      }
      const data = await res.json();
      clearUserData();
      setUser(data as User);
    },
    []
  );

  const logout = useCallback(async () => {
    await fetch(`${API_URL}/auth/logout`, { method: "POST", credentials: "include" }).catch(() => {});
    clearUserData();
    setUser(null);
  }, []);

  const refreshSession = useCallback(async () => {
    const res = await fetch(`${API_URL}/auth/refresh`, { method: "POST", credentials: "include" });
    if (res.ok) {
      const meRes = await fetch(`${API_URL}/auth/me`, { credentials: "include" });
      if (meRes.ok) {
        setUser(await meRes.json());
        return true;
      }
    }
    return false;
  }, []);

  return (
    <AuthContext.Provider value={{ user, loading, login, register, logout, refreshSession }}>
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}

"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useApiKeys } from "@/hooks/useApiKeys";
import { api } from "@/lib/api";
import type { ThemeName } from "@/types/theme";
import { THEMES } from "@/types/theme";

const THEME_NAMES = Object.keys(THEMES) as ThemeName[];

export default function SettingsPage() {
  const { user, logout, refreshSession } = useAuth();
  const { themeName, setThemeName } = useTheme();
  const router = useRouter();
  const { keys, fetchKeys, saveKey, deleteKey } = useApiKeys();

  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [profileMsg, setProfileMsg] = useState("");

  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [keyMsg, setKeyMsg] = useState("");
  const [keySaving, setKeySaving] = useState<string | null>(null);

  useEffect(() => {
    if (!user) { router.push("/login"); return; }
    fetchKeys();
  }, [user, router, fetchKeys]);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || "");
      setEmail(user.email || "");
    }
  }, [user]);

  const handleSaveProfile = async () => {
    try {
      await api.patch("/auth/me", {
        display_name: displayName.trim() || user?.display_name,
        email: email.trim() || user?.email,
      });
      await refreshSession();
      setProfileMsg("Profile updated.");
    } catch {
      setProfileMsg("Failed to update profile.");
    }
  };

  const handleSaveKey = useCallback(async (provider: string, key: string) => {
    if (!key.trim()) return;
    setKeySaving(provider);
    try {
      await saveKey(provider, key.trim());
      if (provider === "openai") setOpenaiKey("");
      if (provider === "gemini") setGeminiKey("");
      if (provider === "deepseek") setDeepseekKey("");
      setKeyMsg(`${provider} key saved.`);
    } catch {
      setKeyMsg(`Failed to save ${provider} key.`);
    } finally {
      setKeySaving(null);
    }
  }, [saveKey]);

  const handleDeleteKey = async (id: string, provider: string) => {
    await deleteKey(id);
    setKeyMsg(`${provider} key removed.`);
  };

  if (!user) return <div className="flex h-screen items-center justify-center bg-base" />;

  const getKeyByProvider = (provider: string) => keys.find((k) => k.provider === provider);

  return (
    <div className="flex min-h-screen bg-base">
      <div className="mx-auto w-full max-w-2xl space-y-6 p-8 fade-in">

        {/* Header */}
        <div className="flex items-center justify-between">
          <div>
            <h1 className="text-2xl font-bold text-primary">Settings</h1>
            <p className="text-sm text-muted mt-0.5">Manage your account and preferences</p>
          </div>
          <div className="flex gap-2">
            <button onClick={() => router.push("/")}
              className="btn bg-elevated px-4 py-2 text-sm text-secondary hover:bg-hover hover:text-primary">
              Back to app
            </button>
            <button onClick={() => { logout(); router.push("/login"); }}
              className="btn bg-elevated px-4 py-2 text-sm text-danger hover:bg-hover">
              Logout
            </button>
          </div>
        </div>

        {/* Profile */}
        <section className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">Profile</h2>
          <div className="space-y-3">
            <div>
              <label className="mb-1.5 block text-xs font-medium text-secondary">Display Name</label>
              <input className="input-field" placeholder="Your name" value={displayName}
                onChange={(e) => setDisplayName(e.target.value)} />
            </div>
            <div>
              <label className="mb-1.5 block text-xs font-medium text-secondary">Email</label>
              <input className="input-field" placeholder="you@example.com" type="email" value={email}
                onChange={(e) => setEmail(e.target.value)} />
            </div>
            <div className="flex items-center gap-3 pt-1">
              <button onClick={handleSaveProfile}
                className="btn bg-accent px-5 py-2 text-sm font-semibold text-base hover:bg-accent-hover">
                Save Profile
              </button>
              {profileMsg && <span className="text-sm text-success">{profileMsg}</span>}
            </div>
          </div>
        </section>

        {/* API Keys */}
        <section className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">AI Provider Keys</h2>
          <p className="text-sm text-muted leading-relaxed">
            Your API keys are encrypted at rest with Fernet (AES-128) and never stored in plaintext.
            Keys are decrypted in-memory only when making AI calls.
          </p>
          {keyMsg && (
            <div className="rounded-xl bg-success/10 border border-success/20 px-4 py-2.5 text-sm text-success">
              {keyMsg}
            </div>
          )}
          <div className="space-y-4">
            {[
              { provider: "openai", label: "OpenAI", placeholder: "sk-..." },
              { provider: "gemini", label: "Google Gemini", placeholder: "AIza..." },
              { provider: "deepseek", label: "DeepSeek", placeholder: "sk-..." },
            ].map(({ provider, label, placeholder }) => (
              <div key={provider}>
                <label className="mb-1.5 block text-xs font-medium text-secondary">{label}</label>
                {getKeyByProvider(provider) ? (
                  <div className="flex items-center gap-3 rounded-xl bg-elevated px-4 py-2.5 border border-border">
                    <span className="flex-1 text-sm text-success">
                      {"\u2713"} Key configured: {getKeyByProvider(provider)?.key_prefix}...
                    </span>
                    <button onClick={() => handleDeleteKey(getKeyByProvider(provider)!.id, provider)}
                      className="text-xs text-danger hover:underline font-medium">
                      Remove
                    </button>
                  </div>
                ) : (
                  <div className="flex gap-2">
                    <input type="password" className="input-field flex-1" placeholder={placeholder}
                      value={provider === "openai" ? openaiKey : provider === "gemini" ? geminiKey : deepseekKey}
                      onChange={(e) => {
                        if (provider === "openai") setOpenaiKey(e.target.value);
                        if (provider === "gemini") setGeminiKey(e.target.value);
                        if (provider === "deepseek") setDeepseekKey(e.target.value);
                      }} />
                    <button onClick={() => handleSaveKey(provider,
                      (provider === "openai" ? openaiKey : provider === "gemini" ? geminiKey : deepseekKey))}
                      disabled={keySaving === provider || !(provider === "openai" ? openaiKey : provider === "gemini" ? geminiKey : deepseekKey).trim()}
                      className="btn bg-accent px-4 text-sm font-semibold text-base hover:bg-accent-hover disabled:opacity-50">
                      {keySaving === provider ? "Saving..." : "Save"}
                    </button>
                  </div>
                )}
              </div>
            ))}
          </div>
        </section>

        {/* Themes */}
        <section className="card p-6 space-y-4">
          <h2 className="text-lg font-semibold text-primary">Theme</h2>
          <div className="grid grid-cols-5 gap-3">
            {THEME_NAMES.map((name) => (
              <button key={name} onClick={() => setThemeName(name)}
                className={`rounded-xl border-2 p-3 text-center transition-all ${
                  themeName === name
                    ? "border-accent bg-accent/10 shadow-md"
                    : "border-border bg-elevated hover:border-text-muted hover:bg-hover"
                }`}>
                <div className="h-6 w-full rounded-lg mb-2"
                  style={{ backgroundColor: THEMES[name].colors.accent }} />
                <span className={`text-xs font-medium ${themeName === name ? "text-accent" : "text-secondary"}`}>
                  {THEMES[name].label}
                </span>
              </button>
            ))}
          </div>
        </section>

        {/* Danger Zone */}
        <section className="card p-6 space-y-4 border-danger/20">
          <h2 className="text-lg font-semibold text-danger">Danger Zone</h2>
          <p className="text-sm text-muted">Permanently delete your account and all associated data.</p>
          <button disabled className="btn bg-danger/10 border border-danger/30 px-5 py-2 text-sm font-medium text-danger/50 cursor-not-allowed">
            Delete Account (coming soon)
          </button>
        </section>

      </div>
    </div>
  );
}

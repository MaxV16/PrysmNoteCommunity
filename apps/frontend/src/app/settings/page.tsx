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

type SettingsTab = "profile" | "api-keys" | "appearance" | "advanced";

const TABS: { id: SettingsTab; label: string; icon: string }[] = [
  { id: "profile", label: "Profile", icon: "👤" },
  { id: "api-keys", label: "AI Keys", icon: "🔑" },
  { id: "appearance", label: "Appearance", icon: "🎨" },
  { id: "advanced", label: "Advanced", icon: "⚙️" },
];

export default function SettingsPage() {
  const { user, logout, refreshSession } = useAuth();
  const { themeName, setThemeName } = useTheme();
  const router = useRouter();
  const { keys, fetchKeys, saveKey, deleteKey } = useApiKeys();

  const [activeTab, setActiveTab] = useState<SettingsTab>("profile");
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

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
    if (!displayName.trim() && !email.trim()) return;
    setProfileSaving(true);
    try {
      await api.patch("/auth/me", {
        display_name: displayName.trim() || user?.display_name,
        email: email.trim() || user?.email,
      });
      await refreshSession();
      setProfileMsg("Profile updated.");
      setTimeout(() => setProfileMsg(""), 3000);
    } catch {
      setProfileMsg("Failed to update profile.");
    } finally {
      setProfileSaving(false);
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
      setTimeout(() => setKeyMsg(""), 3000);
    } catch {
      setKeyMsg(`Failed to save ${provider} key.`);
    } finally {
      setKeySaving(null);
    }
  }, [saveKey]);

  const handleDeleteKey = async (id: string, provider: string) => {
    await deleteKey(id);
    setKeyMsg(`${provider} key removed.`);
    setTimeout(() => setKeyMsg(""), 3000);
  };

  if (!user) return <div className="flex h-screen items-center justify-center bg-base" />;

  const getKeyByProvider = (provider: string) => keys.find((k) => k.provider === provider);

  return (
    <div className="flex min-h-screen bg-base">
      {/* Sidebar nav */}
      <div className="flex w-56 flex-col border-r border-border bg-surface overflow-hidden shrink-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
          <button onClick={() => router.push("/")}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-elevated text-sm text-secondary hover:bg-hover hover:text-primary transition-colors">
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6"/>
            </svg>
          </button>
          <div>
            <h1 className="text-sm font-bold gradient-text leading-tight">Settings</h1>
            <p className="text-[10px] text-muted">Manage your workspace</p>
          </div>
        </div>
        <nav className="flex-1 p-2 space-y-1">
          {TABS.map((tab) => (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`sidebar-item w-full ${activeTab === tab.id ? "active" : ""}`}
            >
              <span className="text-base">{tab.icon}</span>
              <span>{tab.label}</span>
            </button>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <button onClick={() => { logout(); router.push("/login"); }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-danger hover:bg-hover transition-colors">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
              <polyline points="16 17 21 12 16 7"/>
              <line x1="21" y1="12" x2="9" y2="12"/>
            </svg>
            Sign Out
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto max-w-2xl space-y-6 p-8 fade-in">

          {/* Profile */}
          {activeTab === "profile" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl font-bold text-accent float">
                  {(user.display_name || user.email || "U")[0].toUpperCase()}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Profile</h2>
                  <p className="text-sm text-muted">Your personal account information</p>
                </div>
              </div>
              <div className="space-y-4">
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
                  <button onClick={handleSaveProfile} disabled={profileSaving}
                    className="btn btn-primary px-6 py-2 text-sm disabled:opacity-50">
                    {profileSaving ? "Saving..." : "Save Changes"}
                  </button>
                  {profileMsg && (
                    <span className={`text-sm ${profileMsg.includes("Failed") ? "text-danger" : "text-success"}`}>
                      {profileMsg}
                    </span>
                  )}
                </div>
              </div>
            </section>
          )}

          {/* AI Keys */}
          {activeTab === "api-keys" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/>
                    <path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">AI Provider Keys</h2>
                  <p className="text-sm text-muted">API keys for LLM providers</p>
                </div>
              </div>
              <p className="text-sm text-muted leading-relaxed rounded-xl bg-elevated px-4 py-3 border border-border">
                Your API keys are encrypted at rest using Fernet (AES-128). Keys are decrypted in-memory only when making AI calls.
              </p>
              {keyMsg && (
                <div className="rounded-xl bg-success/10 border border-success/20 px-4 py-2.5 text-sm text-success scale-in">
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
                    <label className="mb-1.5 block text-xs font-semibold text-secondary uppercase tracking-wider">{label}</label>
                    {getKeyByProvider(provider) ? (
                      <div className="flex items-center gap-3 rounded-xl bg-elevated px-4 py-2.5 border border-border hover:border-success/30 transition-colors">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/20 text-xs">✓</span>
                        <span className="flex-1 text-sm text-success font-medium">
                          Key configured: {getKeyByProvider(provider)?.key_prefix}...
                        </span>
                        <button onClick={() => handleDeleteKey(getKeyByProvider(provider)!.id, provider)}
                          className="rounded-lg px-2.5 py-1 text-xs text-danger hover:bg-danger/10 font-medium transition-colors">
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
                          className="btn btn-primary px-4 text-sm disabled:opacity-50 shrink-0">
                          {keySaving === provider ? "Saving..." : "Save"}
                        </button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* Appearance */}
          {activeTab === "appearance" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5"/>
                    <line x1="12" y1="1" x2="12" y2="3"/>
                    <line x1="12" y1="21" x2="12" y2="23"/>
                    <line x1="4.22" y1="4.22" x2="5.64" y2="5.64"/>
                    <line x1="18.36" y1="18.36" x2="19.78" y2="19.78"/>
                    <line x1="1" y1="12" x2="3" y2="12"/>
                    <line x1="21" y1="12" x2="23" y2="12"/>
                    <line x1="4.22" y1="19.78" x2="5.64" y2="18.36"/>
                    <line x1="18.36" y1="5.64" x2="19.78" y2="4.22"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Appearance</h2>
                  <p className="text-sm text-muted">Customize your theme</p>
                </div>
              </div>
              <div className="grid grid-cols-5 gap-3">
                {THEME_NAMES.map((name) => (
                  <button key={name} onClick={() => setThemeName(name)}
                    className={`rounded-2xl border-2 p-3 text-center transition-all duration-200 ${
                      themeName === name
                        ? "border-accent bg-accent/10 shadow-glow scale-105"
                        : "border-border bg-elevated hover:border-text-muted hover:bg-hover hover:scale-102"
                    }`}>
                    <div className="h-7 w-full rounded-xl mb-2 shadow-inner"
                      style={{ backgroundColor: THEMES[name].colors.accent }} />
                    <span className={`text-xs font-semibold ${themeName === name ? "text-accent" : "text-secondary"}`}>
                      {THEMES[name].label}
                    </span>
                  </button>
                ))}
              </div>
            </section>
          )}

          {/* Advanced */}
          {activeTab === "advanced" && (
            <section className="card p-6 space-y-5 border-danger/20">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-danger/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--danger)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="3"/>
                    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1 0 2.83 2 2 0 0 1-2.83 0l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-2 2 2 2 0 0 1-2-2v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83 0 2 2 0 0 1 0-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1-2-2 2 2 0 0 1 2-2h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 0-2.83 2 2 0 0 1 2.83 0l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 2-2 2 2 0 0 1 2 2v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 0 2 2 0 0 1 0 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 2 2 2 2 0 0 1-2 2h-.09a1.65 1.65 0 0 0-1.51 1z"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Advanced</h2>
                  <p className="text-sm text-muted">Danger zone and account management</p>
                </div>
              </div>
              <div className="rounded-xl bg-danger/5 border border-danger/20 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-danger">Danger Zone</h3>
                <p className="text-xs text-muted leading-relaxed">
                  Permanently delete your account and all associated data. This action cannot be undone.
                </p>
                <button disabled
                  className="btn bg-danger/10 border border-danger/30 px-5 py-2 text-sm font-medium text-danger/50 cursor-not-allowed rounded-xl">
                  Delete Account (coming soon)
                </button>
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

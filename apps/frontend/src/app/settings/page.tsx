"use client";

import { useState, useEffect, useCallback } from "react";
import { useRouter } from "next/navigation";
import dynamic from "next/dynamic";
import { useAuth } from "@/lib/auth-context";
import { useTheme } from "@/lib/theme-context";
import { useApiKeys } from "@/hooks/useApiKeys";
import { api } from "@/lib/api";
import { useAppStore } from "@/stores/app-store";
import type { ThemeName, ThemeColors, BackgroundPreset } from "@/types/theme";
import { THEMES, FONT_PRESETS, BACKGROUND_PRESETS } from "@/types/theme";

const PremiumSettings = dynamic(
  () => import("@ee/components/PremiumSettings").then((m) => m.PremiumSettings),
  { ssr: false }
);

const THEME_NAMES: ThemeName[] = [...(Object.keys(THEMES) as ThemeName[]), "custom"];

type SettingsTab =
  | "account"
  | "premium"
  | "features"
  | "smart-list"
  | "notifications"
  | "date-time"
  | "appearance"
  | "more"
  | "integrations"
  | "collaborate"
  | "sticky-note"
  | "widgets"
  | "ai-keys"
  | "shortcuts"
  | "about";

interface TabGroup {
  label: string;
  tabs: { id: SettingsTab; label: string; svg: string }[];
}

const TAB_GROUPS: TabGroup[] = [
  {
    label: "Account",
    tabs: [
      { id: "account", label: "Account", svg: "M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2 M12 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z" },
      { id: "premium", label: "Premium", svg: "M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z" },
    ],
  },
  {
    label: "App Customization",
    tabs: [
      { id: "features", label: "Features", svg: "M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5" },
      { id: "smart-list", label: "Smart List", svg: "M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" },
      { id: "notifications", label: "Notifications", svg: "M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0" },
      { id: "date-time", label: "Date & Time", svg: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 6v6l4 2" },
      { id: "appearance", label: "Appearance", svg: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z" },
      { id: "more", label: "More", svg: "M12 15a3 3 0 1 0 0-6 3 3 0 0 0 0 6z M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" },
    ],
  },
  {
    label: "Integrations & Extras",
    tabs: [
      { id: "integrations", label: "Integrations & Import", svg: "M13 2L3 14h9l-1 8 10-12h-9l1-8z" },
      { id: "collaborate", label: "Collaborate", svg: "M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" },
      { id: "sticky-note", label: "Sticky Note", svg: "M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" },
      { id: "widgets", label: "Desktop Widgets", svg: "M3 3h18v18H3V3z M3 9h18 M9 3v18" },
      { id: "ai-keys", label: "AI Keys", svg: "M7 11V7a5 5 0 0 1 10 0v4 M5 11h14a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-7a2 2 0 0 1 2-2z" },
      { id: "shortcuts", label: "Shortcuts", svg: "M12 8V4 M8 12H4 M12 16v4 M16 12h4 M12 2v2 M12 22v-2 M2 12h2 M22 12h-2" },
      { id: "about", label: "About", svg: "M12 2a10 10 0 1 0 0 20 10 10 0 0 0 0-20z M12 16v-4 M12 8h.01" },
    ],
  },
];

const ACCENT_COLORS = [
  "#4C7EFF", "#6C5CE7", "#FF9500", "#22C55E", "#EF4444", "#EC4899",
];

const SHORTCUTS = [
  { key: "Ctrl+K", action: "Search / Command palette" },
  { key: "Ctrl+N", action: "New task" },
  { key: "Ctrl+B", action: "Toggle sidebar" },
  { key: "Ctrl+Shift+J", action: "Toggle AI panel" },
  { key: "Ctrl+E", action: "Focus AI input" },
  { key: "Escape", action: "Close modal / Deselect task" },
  { key: "Ctrl+S", action: "Save current form" },
  { key: "Ctrl+Shift+T", action: "Toggle theme" },
];

function getLocalKey(provider: string): string | null {
  if (typeof window === "undefined") return null;
  return localStorage.getItem(`prysm_key_${provider}`);
}

function lsGet<T>(key: string, fallback: T): T {
  if (typeof window === "undefined") return fallback;
  try {
    const v = localStorage.getItem(key);
    return v ? (JSON.parse(v) as T) : fallback;
  } catch {
    return fallback;
  }
}

function lsSet(key: string, value: unknown) {
  if (typeof window === "undefined") return;
  localStorage.setItem(key, JSON.stringify(value));
}

function stBool(key: string, fallback = false): [boolean, (v: boolean) => void] {
  const [v, setV] = useState(() => lsGet<boolean>(key, fallback));
  const set = useCallback(
    (nv: boolean) => {
      setV(nv);
      lsSet(key, nv);
    },
    [key],
  );
  return [v, set];
}

function stStr(key: string, fallback = ""): [string, (v: string) => void] {
  const [v, setV] = useState(() => lsGet<string>(key, fallback));
  const set = useCallback(
    (nv: string) => {
      setV(nv);
      lsSet(key, nv);
    },
    [key],
  );
  return [v, set];
}

function Toggle({ value, onChange }: { value: boolean; onChange: (v: boolean) => void }) {
  return (
    <button
      onClick={() => onChange(!value)}
      className="relative w-11 h-6 rounded-full transition-colors"
      style={{ backgroundColor: value ? 'var(--accent)' : 'var(--border)' }}
    >
      <span
        className="absolute left-0.5 top-0.5 h-5 w-5 rounded-full bg-white transition-all"
        style={{ transform: value ? 'translateX(1.25rem)' : 'translateX(0)' }}
      />
    </button>
  );
}

function IntegrationRow({ label, description, connected, onConnect, onDisconnect }: { label: string; description: string; connected: boolean; onConnect: () => void; onDisconnect?: () => void }) {
  return (
    <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
      <div>
        <p className="text-sm text-secondary">{label}</p>
        <p className="text-xs text-muted">{description}</p>
      </div>
      {connected ? (
        <div className="flex items-center gap-2">
          <span className="text-[10px] px-2 py-0.5 rounded-full bg-success/10 text-success border border-success/20">Connected</span>
          {onDisconnect && (
            <button onClick={onDisconnect} className="btn bg-elevated border border-border text-xs text-danger px-3 py-1 rounded-xl hover:bg-danger/10">Disconnect</button>
          )}
        </div>
      ) : (
        <button onClick={onConnect} className="btn bg-accent text-white px-4 py-1.5 text-xs rounded-xl hover:bg-accent-hover">Connect</button>
      )}
    </div>
  );
}

export default function SettingsPage() {
  const { user, logout, refreshSession } = useAuth();
  const { themeName, setThemeName, fontFamily, setFontFamily, background, setBackgroundPreset, setBackgroundImage, clearBackground, customTheme, setCustomTheme } =
    useTheme();
  const router = useRouter();
  const { keys, fetchKeys, saveKey, deleteKey } = useApiKeys();
  const { tasks, projects } = useAppStore();

  const [activeTab, setActiveTab] = useState<SettingsTab>("account");
  const [displayName, setDisplayName] = useState(user?.display_name || "");
  const [email, setEmail] = useState(user?.email || "");
  const [profileMsg, setProfileMsg] = useState("");
  const [profileSaving, setProfileSaving] = useState(false);

  const [openaiKey, setOpenaiKey] = useState("");
  const [geminiKey, setGeminiKey] = useState("");
  const [deepseekKey, setDeepseekKey] = useState("");
  const [keyMsg, setKeyMsg] = useState("");
  const [keySaving, setKeySaving] = useState<string | null>(null);
  const [deletingAccount, setDeletingAccount] = useState(false);

  const [calendarOn, setCalendarOn] = stBool("prysm_feature_calendar", true);
  const [kanbanOn, setKanbanOn] = stBool("prysm_feature_kanban", true);
  const [habitsOn, setHabitsOn] = stBool("prysm_feature_habits", true);
  const [voiceOn, setVoiceOn] = stBool("prysm_feature_voice", true);

  const [showInbox, setShowInbox] = stBool("prysm_smartlist_inbox", true);
  const [showToday, setShowToday] = stBool("prysm_smartlist_today", true);
  const [showNext7, setShowNext7] = stBool("prysm_smartlist_next7", true);
  const [showAll, setShowAll] = stBool("prysm_smartlist_all", true);
  const [showCompleted, setShowCompleted] = stBool("prysm_smartlist_completed", true);

  const [notifPush, setNotifPush] = stBool("prysm_notif_push");
  const [notifEmail, setNotifEmail] = stBool("prysm_notif_email");
  const [notifDue, setNotifDue] = stBool("prysm_notif_due", true);
  const [notifDigest, setNotifDigest] = stBool("prysm_notif_digest");
  const [notifSound, setNotifSound] = stBool("prysm_notif_sound");

  const [startDay, setStartDay] = stStr("prysm_start_day", "monday");
  const [timeFormat, setTimeFormat] = stStr("prysm_time_format", "24h");
  const [dateFormat, setDateFormat] = stStr("prysm_date_format", "dd/mm/yyyy");
  const [timezone, setTimezone] = stStr("prysm_tz", Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC");

  const [lastExport, setLastExport] = stStr("prysm_last_export");

  const [notificationStatus, setNotificationStatus] = useState<"idle" | "granted" | "denied">("idle");

  const [stickyColor, setStickyColor] = stStr("prysm_sticky_color", "#FFD700");
  const [stickyFontSize, setStickyFontSize] = stStr("prysm_sticky_font", "14px");
  const [stickyAutoShow, setStickyAutoShow] = stBool("prysm_sticky_autoshow", true);

  const [widgetCalendar, setWidgetCalendar] = stBool("prysm_widget_calendar", true);
  const [widgetTasks, setWidgetTasks] = stBool("prysm_widget_tasks", true);
  const [widgetHabits, setWidgetHabits] = stBool("prysm_widget_habits", true);

  const [collabTeamName, setCollabTeamName] = useState("");
  const [collabInviteEmail, setCollabInviteEmail] = useState("");
  const [collabMsg, setCollabMsg] = useState("");
  const [collabTeams, setCollabTeams] = useState<{ name: string }[]>(() =>
    lsGet<{ name: string }[]>("prysm_collab_teams", [])
  );

  const [editingCustomTheme, setEditingCustomTheme] = useState(false);
  const [customThemeColors, setCustomThemeColors] = useState<ThemeColors>(() => {
    const base = THEMES[themeName] || THEMES.dark;
    return customTheme ? { ...base.colors, ...Object.fromEntries(Object.entries(customTheme)) } as unknown as ThemeColors : { ...base.colors };
  });
  const [customFontInput, setCustomFontInput] = useState("");
  const [fontInputOpen, setFontInputOpen] = useState(false);

  const [passwordResetOpen, setPasswordResetOpen] = useState(false);
  const [currentPassword, setCurrentPassword] = useState("");
  const [newPassword, setNewPassword] = useState("");
  const [passwordMsg, setPasswordMsg] = useState("");
  const [passwordSaving, setPasswordSaving] = useState(false);

  const [googleConnected, setGoogleConnected] = useState(() => !!lsGet("prysm_integration_google", ""));
  const [slackConnected, setSlackConnected] = useState(() => !!lsGet("prysm_integration_slack_webhook", ""));
  const [githubConnected, setGithubConnected] = useState(() => !!lsGet("prysm_integration_github_token", ""));
  const [siriConnected, setSiriConnected] = useState(() => !!lsGet("prysm_integration_siri_url", ""));

  const [inviteEmailCheck, setInviteEmailCheck] = useState("");

  useEffect(() => {
    if (!user) {
      router.push("/login");
      return;
    }
    fetchKeys();
  }, [user, router, fetchKeys]);

  useEffect(() => {
    if (user) {
      setDisplayName(user.display_name || "");
      setEmail(user.email || "");
    }
  }, [user]);

  useEffect(() => {
    if (typeof window !== "undefined" && "Notification" in window) {
      setNotificationStatus(Notification.permission as "granted" | "denied" | "idle");
    }
  }, []);

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

  const handleSaveKey = useCallback(
    async (provider: string, key: string) => {
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
    },
    [saveKey],
  );

  const handleDeleteKey = async (id: string, provider: string) => {
    await deleteKey(id, provider);
    setKeyMsg(`${provider} key removed.`);
    setTimeout(() => setKeyMsg(""), 3000);
  };

  const handleDeleteAccount = async () => {
    if (!window.confirm("This permanently deletes your account and all data. Are you sure?"))
      return;
    setDeletingAccount(true);
    try {
      await api.delete("/auth/me");
      logout();
      router.push("/login");
    } catch {
      setDeletingAccount(false);
      alert("Failed to delete account. Please try again.");
    }
  };

  const handleChangePassword = async () => {
    if (!currentPassword.trim() || !newPassword.trim()) return;
    setPasswordSaving(true);
    try {
      await api.post("/auth/change-password", { current_password: currentPassword, new_password: newPassword });
      setPasswordMsg("Password changed successfully.");
      setCurrentPassword("");
      setNewPassword("");
      setTimeout(() => { setPasswordMsg(""); setPasswordResetOpen(false); }, 2000);
    } catch {
      setPasswordMsg("Failed to change password.");
    } finally {
      setPasswordSaving(false);
    }
  };

  const handleExport = () => {
    const data = { tasks, projects, exportedAt: new Date().toISOString() };
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = `prysm-note-backup-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    const now = new Date().toLocaleString();
    setLastExport(now);
  };

  const handleImport = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".json";
    input.onchange = async (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      try {
        const text = await file.text();
        const data = JSON.parse(text);
        if (!data.tasks || !data.projects) {
          alert("Invalid backup file format.");
          return;
        }
        if (!window.confirm(`Import ${data.tasks.length} tasks and ${data.projects.length} projects? This will overwrite current data.`)) return;
        const store = useAppStore.getState();
        store.setTasks(data.tasks);
        store.setProjects(data.projects);
        alert("Import complete! Reloading...");
        window.location.reload();
      } catch {
        alert("Failed to parse backup file.");
      }
    };
    input.click();
  };

  const handleRequestNotification = async () => {
    if (!("Notification" in window)) return;
    const perm = await Notification.requestPermission();
    setNotificationStatus(perm as "granted" | "denied" | "idle");
  };

  const handleImageUpload = () => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = "image/*";
    input.onchange = (e) => {
      const file = (e.target as HTMLInputElement).files?.[0];
      if (!file) return;
      const reader = new FileReader();
      reader.onload = () => {
        setBackgroundImage(reader.result as string);
      };
      reader.readAsDataURL(file);
    };
    input.click();
  };

  const handleCreateTeam = () => {
    if (!collabTeamName.trim()) return;
    const teams = [...collabTeams, { name: collabTeamName.trim() }];
    setCollabTeams(teams);
    lsSet("prysm_collab_teams", teams);
    setCollabTeamName("");
    setCollabMsg("Team created.");
    setTimeout(() => setCollabMsg(""), 2000);
  };

  const handleInvite = () => {
    if (!collabInviteEmail.trim()) return;
    const knownUsers: string[] = lsGet<string[]>("prysm_known_users", []);
    if (!knownUsers.includes(collabInviteEmail.trim())) {
      setCollabMsg(`This user doesn't have an account. Creating pending invite for ${collabInviteEmail.trim()}.`);
    } else {
      setCollabMsg(`Invitation sent to ${collabInviteEmail.trim()}.`);
    }
    setCollabInviteEmail("");
    setTimeout(() => setCollabMsg(""), 3000);
  };

  const handleConnectGoogle = () => {
    lsSet("prysm_integration_google", "connected");
    setGoogleConnected(true);
  };

  const handleDisconnectGoogle = () => {
    localStorage.removeItem("prysm_integration_google");
    setGoogleConnected(false);
  };

  const handleConnectSlack = () => {
    const webhook = prompt("Enter Slack Webhook URL:");
    if (webhook && webhook.trim()) {
      lsSet("prysm_integration_slack_webhook", webhook.trim());
      setSlackConnected(true);
    }
  };

  const handleDisconnectSlack = () => {
    localStorage.removeItem("prysm_integration_slack_webhook");
    setSlackConnected(false);
  };

  const handleConnectGithub = () => {
    const token = prompt("Enter GitHub Personal Access Token:");
    if (token && token.trim()) {
      lsSet("prysm_integration_github_token", token.trim());
      setGithubConnected(true);
    }
  };

  const handleDisconnectGithub = () => {
    localStorage.removeItem("prysm_integration_github_token");
    setGithubConnected(false);
  };

  const handleConnectSiri = () => {
    lsSet("prysm_integration_siri_url", "prysmnote://");
    setSiriConnected(true);
    alert("Siri Shortcuts URL scheme: prysmnote://\nUse this in the Shortcuts app to deep-link into Prysm Note.");
  };

  const handleDisconnectSiri = () => {
    localStorage.removeItem("prysm_integration_siri_url");
    setSiriConnected(false);
  };

  const handleOpenWidgets = () => {
    window.open('/widgets', 'prysm-widgets', 'width=400,height=600');
  };

  const statuses = ["backlog", "todo", "in_progress", "done", "cancelled"] as const;
  const statusColors: Record<string, string> = {
    backlog: "var(--text-muted)",
    todo: "var(--accent)",
    in_progress: "var(--warning)",
    done: "var(--success)",
    cancelled: "var(--danger)",
  };
  const totalTasks = tasks.length;
  const doneCount = tasks.filter((t) => t.status === "done").length;
  const activeCount = tasks.filter((t) => t.status !== "done" && t.status !== "cancelled").length;
  const completionRate = activeCount + doneCount > 0 ? Math.round((doneCount / (activeCount + doneCount)) * 100) : 0;
  const projectStats = projects.map((p) => ({
    name: p.name,
    count: tasks.filter((t) => t.project_id === p.id).length,
    color: p.color || "var(--text-muted)",
  })).filter((s) => s.count > 0);
  const now = new Date();
  const weekStart = new Date(now);
  weekStart.setDate(now.getDate() - now.getDay());
  weekStart.setHours(0, 0, 0, 0);
  const tasksThisWeek = tasks.filter((t) => new Date(t.created_at) >= weekStart).length;
  const completedThisWeek = tasks.filter(
    (t) => t.status === "done" && t.completed_at && new Date(t.completed_at) >= weekStart
  ).length;

  if (!user) return <div className="flex h-screen items-center justify-center bg-base" />;

  const getKeyByProvider = (provider: string) => keys.find((k) => k.provider === provider);

  return (
    <div className="flex min-h-screen bg-base">
      {/* Sidebar nav */}
      <div className="flex w-56 flex-col border-r border-border bg-surface overflow-hidden shrink-0">
        <div className="flex items-center gap-2.5 border-b border-border px-4 py-4">
          <button
            onClick={() => router.push("/")}
            className="flex h-8 w-8 items-center justify-center rounded-xl bg-elevated text-sm text-secondary hover:bg-hover hover:text-primary transition-colors"
          >
            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="15 18 9 12 15 6" />
            </svg>
          </button>
          <div>
            <h1 className="text-sm font-bold gradient-text leading-tight">Settings</h1>
            <p className="text-[10px] text-muted">Manage your workspace</p>
          </div>
        </div>
        <nav className="flex-1 overflow-auto p-2">
          {TAB_GROUPS.map((group) => (
            <div key={group.label} className="mb-1">
              <p className="text-[10px] uppercase tracking-wider font-semibold text-muted px-2 pt-3 pb-1.5">
                {group.label}
              </p>
              <div className="space-y-0.5">
                {group.tabs.map((tab) => (
                  <button
                    key={tab.id}
                    onClick={() => setActiveTab(tab.id)}
                    className={`sidebar-item w-full ${activeTab === tab.id ? "active" : ""}`}
                  >
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <path d={tab.svg} />
                    </svg>
                    <span>{tab.label}</span>
                  </button>
                ))}
              </div>
            </div>
          ))}
        </nav>
        <div className="border-t border-border p-3">
          <button
            onClick={() => {
              logout();
              router.push("/login");
            }}
            className="flex w-full items-center gap-2 rounded-xl px-3 py-2 text-xs text-danger hover:bg-hover transition-colors"
          >
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
              <polyline points="16 17 21 12 16 7" />
              <line x1="21" y1="12" x2="9" y2="12" />
            </svg>
            Sign Out
          </button>
        </div>
      </div>

      {/* Content */}
      <div className="flex-1 overflow-auto">
        <div className="mx-auto w-full max-w-4xl space-y-6 p-4 sm:p-6 lg:p-8 fade-in">

          {/* === ACCOUNT === */}
          {activeTab === "account" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl font-bold text-accent float">
                  {(user.display_name || user.email || "U")[0].toUpperCase()}
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Account</h2>
                  <p className="text-sm text-muted">Your personal account information</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Display Name</label>
                  <input className="input-field" placeholder="Your name" value={displayName} onChange={(e) => setDisplayName(e.target.value)} />
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Email</label>
                  <input className="input-field" placeholder="you@example.com" type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                </div>
                <div className="flex items-center gap-3 pt-1">
                  <button onClick={handleSaveProfile} disabled={profileSaving} className="btn btn-primary px-6 py-2 text-sm disabled:opacity-50">
                    {profileSaving ? "Saving..." : "Save Changes"}
                  </button>
                  {profileMsg && (
                    <span className={`text-sm ${profileMsg.includes("Failed") ? "text-danger" : "text-success"}`}>{profileMsg}</span>
                  )}
                </div>
              </div>
              <div className="rounded-xl bg-elevated border border-border p-3">
                <p className="text-xs text-muted">
                  <strong className="text-secondary">Plan:</strong>{" "}
                  {lsGet("prysm_premium", false) ? "Premium · €5/month" : "Free"}
                </p>
              </div>

              <div className="border-t border-border pt-4 space-y-4">
                <h3 className="text-sm font-semibold text-primary">Security</h3>
                <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                  <div>
                    <p className="text-sm text-secondary">Password</p>
                    <p className="text-xs text-muted">Change your account password</p>
                  </div>
                  <button onClick={() => setPasswordResetOpen(true)} className="btn bg-accent text-white px-4 py-1.5 text-xs rounded-xl">Reset Password</button>
                </div>
              </div>

              {passwordResetOpen && (
                <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50">
                  <div className="card p-6 w-full max-w-md mx-4 space-y-4">
                    <div className="flex items-center justify-between">
                      <h3 className="text-sm font-semibold text-primary">Change Password</h3>
                      <button onClick={() => { setPasswordResetOpen(false); setPasswordMsg(""); }} className="text-sm text-secondary hover:text-primary">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                      </button>
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-secondary">Current Password</label>
                      <input type="password" className="input-field" placeholder="Current password" value={currentPassword} onChange={(e) => setCurrentPassword(e.target.value)} />
                    </div>
                    <div>
                      <label className="mb-1.5 block text-xs font-medium text-secondary">New Password</label>
                      <input type="password" className="input-field" placeholder="New password" value={newPassword} onChange={(e) => setNewPassword(e.target.value)} />
                    </div>
                    <div className="flex gap-2">
                      <button onClick={handleChangePassword} disabled={passwordSaving || !currentPassword.trim() || !newPassword.trim()} className="btn btn-primary flex-1 px-4 py-2 text-sm disabled:opacity-50">
                        {passwordSaving ? "Changing..." : "Change Password"}
                      </button>
                      <button onClick={() => { setPasswordResetOpen(false); setPasswordMsg(""); }} className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl">Cancel</button>
                    </div>
                    {passwordMsg && <p className={`text-sm ${passwordMsg.includes("Failed") ? "text-danger" : "text-success"}`}>{passwordMsg}</p>}
                  </div>
                </div>
              )}
            </section>
          )}

          {/* === PREMIUM === */}
          {activeTab === "premium" && <PremiumSettings />}

          {/* === FEATURES === */}
          {activeTab === "features" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 2L2 7l10 5 10-5-10-5z M2 17l10 5 10-5 M2 12l10 5 10-5" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Features</h2>
                  <p className="text-sm text-muted">Toggle app modules on or off</p>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  { label: "Calendar View", desc: "Timeline and calendar layout", value: calendarOn, set: setCalendarOn },
                  { label: "Kanban Board", desc: "Drag-and-drop board view", value: kanbanOn, set: setKanbanOn },
                  { label: "Habit Tracker", desc: "Daily habit tracking with streaks", value: habitsOn, set: setHabitsOn },
                  { label: "Voice Input", desc: "Speech-to-text for AI chat", value: voiceOn, set: setVoiceOn },
                ].map((f) => (
                  <div key={f.label} className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                    <div>
                      <p className="text-sm text-secondary">{f.label}</p>
                      <p className="text-xs text-muted">{f.desc}</p>
                    </div>
                    <Toggle value={f.value} onChange={f.set} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === SMART LIST === */}
          {activeTab === "smart-list" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z M14 2v6h6 M16 13H8 M16 17H8 M10 9H8" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Smart List</h2>
                  <p className="text-sm text-muted">Show or hide default lists</p>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  { label: "Inbox", value: showInbox, set: setShowInbox },
                  { label: "Today", value: showToday, set: setShowToday },
                  { label: "Next 7 Days", value: showNext7, set: setShowNext7 },
                  { label: "All Tasks", value: showAll, set: setShowAll },
                  { label: "Completed", value: showCompleted, set: setShowCompleted },
                ].map((s) => (
                  <div key={s.label} className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                    <span className="text-sm font-medium text-primary">{s.label}</span>
                    <Toggle value={s.value} onChange={s.set} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === NOTIFICATIONS === */}
          {activeTab === "notifications" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9 M13.73 21a2 2 0 0 1-3.46 0" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Notifications</h2>
                  <p className="text-sm text-muted">Manage alerts and reminders</p>
                </div>
              </div>
              <div className="space-y-3">
                <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                  <div>
                    <p className="text-sm text-secondary">Browser Push Notifications</p>
                    <p className="text-[11px] text-muted">
                      {notificationStatus === "granted"
                        ? "Enabled"
                        : notificationStatus === "denied"
                          ? "Blocked by browser"
                          : "Not requested"}
                    </p>
                  </div>
                  {notificationStatus === "idle" ? (
                    <button onClick={handleRequestNotification} className="btn bg-accent px-4 py-1.5 text-xs rounded-xl text-white">
                      Enable
                    </button>
                  ) : (
                    <Toggle value={notifPush && notificationStatus === "granted"} onChange={setNotifPush} />
                  )}
                </div>
                {[
                  { label: "Email Task Reminders", desc: "Receive reminders via email", value: notifEmail, set: setNotifEmail },
                  { label: "Due Date Alerts (24h)", desc: "Notify 24 hours before due", value: notifDue, set: setNotifDue },
                  { label: "Daily Digest Email", desc: "Summary of your tasks each morning", value: notifDigest, set: setNotifDigest },
                  { label: "Sound Alerts", desc: "Play sound on notifications", value: notifSound, set: setNotifSound },
                ].map((n) => (
                  <div key={n.label} className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                    <div>
                      <p className="text-sm text-secondary">{n.label}</p>
                      <p className="text-xs text-muted">{n.desc}</p>
                    </div>
                    <Toggle value={n.value} onChange={n.set} />
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === DATE & TIME === */}
          {activeTab === "date-time" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10" /><polyline points="12 6 12 12 16 14" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Date & Time</h2>
                  <p className="text-sm text-muted">Regional formatting preferences</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Week Starts On</label>
                  <select className="input-field" value={startDay} onChange={(e) => setStartDay(e.target.value)}>
                    <option value="monday">Monday</option>
                    <option value="sunday">Sunday</option>
                    <option value="saturday">Saturday</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Time Format</label>
                  <select className="input-field" value={timeFormat} onChange={(e) => setTimeFormat(e.target.value)}>
                    <option value="24h">24-hour (14:00)</option>
                    <option value="12h">12-hour (2:00 PM)</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Date Format</label>
                  <select className="input-field" value={dateFormat} onChange={(e) => setDateFormat(e.target.value)}>
                    <option value="dd/mm/yyyy">DD/MM/YYYY</option>
                    <option value="mm/dd/yyyy">MM/DD/YYYY</option>
                    <option value="yyyy-mm-dd">YYYY-MM-DD</option>
                  </select>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Timezone</label>
                  <input className="input-field" value={timezone} onChange={(e) => setTimezone(e.target.value)} placeholder="UTC" />
                </div>
              </div>
            </section>
          )}

          {/* === APPEARANCE === */}
          {activeTab === "appearance" && (
            <section className="card p-6 space-y-6">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="5" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Appearance</h2>
                  <p className="text-sm text-muted">Customize your theme, fonts, and colors</p>
                </div>
              </div>

              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">Theme</h3>
              <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 lg:grid-cols-5 gap-2">
                {THEME_NAMES.map((name) => {
                  const isBuiltin = name in THEMES;
                  const info = isBuiltin ? THEMES[name as keyof typeof THEMES] : { label: "My Custom", colors: customTheme };
                  const active = name === "custom" ? themeName === "custom" && !!customTheme : themeName === name && (!customTheme || name !== "custom");
                  return (
                    <button
                      key={name}
                      onClick={() => {
                        if (name === "custom") {
                          if (customTheme) setThemeName("custom");
                          else setEditingCustomTheme(true);
                        } else {
                          setThemeName(name);
                          setCustomTheme(null);
                        }
                      }}
                      className={`rounded-2xl border-2 p-2.5 text-center transition-all duration-200 ${
                        active ? "border-accent bg-accent/10 shadow-glow scale-105" : "border-border bg-elevated hover:border-text-muted hover:bg-hover"
                      }`}
                    >
                      <div
                        className="h-6 w-full rounded-lg mb-1.5 shadow-inner"
                        style={{ backgroundColor: isBuiltin ? (info as typeof THEMES["dark"]).colors.accent : (info as ThemeColors)?.accent || "#888" }}
                      />
                      <span className={`text-[10px] font-semibold ${active ? "text-accent" : "text-secondary"}`}>
                        {isBuiltin ? (info as typeof THEMES["dark"]).label : "Custom"}
                      </span>
                    </button>
                  );
                })}
              </div>

              <button
                onClick={() => {
                  const base = THEMES[themeName === "custom" ? "dark" : themeName] || THEMES.dark;
                  setCustomThemeColors({ ...base.colors });
                  setEditingCustomTheme(true);
                }}
                className="btn bg-accent text-white px-5 py-2 text-sm rounded-xl"
              >
                + Create Custom Theme
              </button>

              {editingCustomTheme && (
                <div className="rounded-2xl bg-elevated border border-border p-4 space-y-4">
                  <h4 className="text-xs font-semibold text-secondary uppercase tracking-wider">Custom Theme Editor</h4>
                  <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
                    {Object.keys(customThemeColors).map((key) => {
                      const k = key as keyof ThemeColors;
                      return (
                        <div key={k}>
                          <label className="text-[10px] text-muted block mb-1">{k.replace("accent-hover", "ahover").replace("shadow-sm", "shadowS").replace("shadow-md", "shadowM").replace("shadow-lg", "shadowL").replace("accent-glow", "glow")}</label>
                          <div className="flex items-center gap-1">
                            <input
                              type="color"
                              value={customThemeColors[k].startsWith("#") || customThemeColors[k].startsWith("rgb") ? (customThemeColors[k].startsWith("#") ? customThemeColors[k] : "#000000") : "#000000"}
                              onChange={(e) => {
                                setCustomThemeColors((prev) => ({ ...prev, [k]: e.target.value }));
                              }}
                              className="w-7 h-7 rounded cursor-pointer border-0 p-0"
                            />
                            <input
                              className="input-field flex-1 text-[10px]"
                              value={customThemeColors[k]}
                              onChange={(e) => {
                                setCustomThemeColors((prev) => ({ ...prev, [k]: e.target.value }));
                              }}
                            />
                          </div>
                        </div>
                      );
                    })}
                  </div>
                  <div className="flex gap-2">
                    <button
                      onClick={() => {
                        setCustomTheme({ ...customThemeColors });
                        setEditingCustomTheme(false);
                      }}
                      className="btn bg-accent text-white px-5 py-2 text-sm rounded-xl"
                    >
                      Apply Custom Theme
                    </button>
                    <button
                      onClick={() => setEditingCustomTheme(false)}
                      className="btn bg-elevated border border-border text-secondary px-4 py-2 text-sm rounded-xl"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}

              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider pt-2">Font Family</h3>
              <div className="space-y-3">
                <select
                  className="input-field"
                  value={FONT_PRESETS.includes(fontFamily) ? fontFamily : "__custom__"}
                  onChange={(e) => {
                    if (e.target.value === "__custom__") {
                      setFontInputOpen(true);
                    } else {
                      setFontInputOpen(false);
                      setFontFamily(e.target.value);
                    }
                  }}
                >
                  {FONT_PRESETS.map((f) => (
                    <option key={f} value={f}>
                      {f}
                    </option>
                  ))}
                  <option value="__custom__">Custom font...</option>
                </select>
                {fontInputOpen && (
                  <div className="flex gap-2">
                    <input
                      className="input-field flex-1"
                      placeholder="Type any Google Font name..."
                      value={customFontInput}
                      onChange={(e) => setCustomFontInput(e.target.value)}
                    />
                    <button
                      onClick={() => {
                        if (customFontInput.trim()) {
                          setFontFamily(customFontInput.trim());
                          setFontInputOpen(false);
                        }
                      }}
                      className="btn bg-accent text-white px-4 py-2 text-sm rounded-xl"
                    >
                      Apply
                    </button>
                  </div>
                )}
                <p className="text-[11px] text-muted">
                  Preview:{" "}
                  <span style={{ fontFamily: fontFamily }} className="text-primary">
                    The quick brown fox jumps over the lazy dog.
                  </span>
                </p>
              </div>

              <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider pt-2">Background</h3>
              <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
                {BACKGROUND_PRESETS.map((p) => (
                  <button
                    key={p.id}
                    onClick={() => setBackgroundPreset(p)}
                    className={`rounded-xl border-2 p-3 text-center transition-all ${
                      background.value === p.value && background.type !== "image"
                        ? "border-accent bg-accent/10"
                        : "border-border bg-elevated hover:border-text-muted"
                    }`}
                  >
                    <div
                      className="h-10 w-full rounded-lg mb-1"
                      style={p.type === "none" ? { backgroundColor: "var(--bg-base)", border: "1px solid var(--border)" } : { background: p.value, backgroundSize: p.size || "cover" }}
                    />
                    <span className="text-[10px] text-secondary">{p.label}</span>
                  </button>
                ))}
              </div>
              <div className="flex gap-2">
                <button
                  onClick={handleImageUpload}
                  className="btn bg-elevated border border-border text-secondary px-4 py-2 text-xs rounded-xl hover:text-primary"
                >
                  Upload Image
                </button>
                <button
                  onClick={clearBackground}
                  className="btn bg-elevated border border-border text-secondary px-4 py-2 text-xs rounded-xl hover:text-primary"
                >
                  Remove Background
                </button>
              </div>
            </section>
          )}

          {/* === MORE (Advanced) === */}
          {activeTab === "more" && (
            <section className="space-y-5">
              <div className="card p-6 space-y-5">
                <div className="flex items-center gap-4">
                  <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                    <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                      <circle cx="12" cy="12" r="3" />
                      <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
                    </svg>
                  </div>
                  <div>
                    <h2 className="text-lg font-bold text-primary">More</h2>
                    <p className="text-sm text-muted">Advanced preferences and app behaviors</p>
                  </div>
                </div>
              </div>

              <div className="card p-6 space-y-4">
                <h3 className="text-sm font-semibold text-primary">Cache Management</h3>
                <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                  <div>
                    <p className="text-sm text-secondary">Clear AI Chat Cache</p>
                    <p className="text-xs text-muted">Remove cached conversations from localStorage</p>
                  </div>
                  <button
                    className="btn px-4 py-2 text-sm bg-elevated border border-border text-secondary hover:bg-hover hover:text-primary transition-colors rounded-xl"
                    onClick={() => {
                      localStorage.removeItem("ai_session_id");
                      localStorage.removeItem("prysm_key_openai");
                      localStorage.removeItem("prysm_key_gemini");
                      localStorage.removeItem("prysm_key_deepseek");
                      alert("Local cache cleared.");
                    }}
                  >
                    Clear Cache
                  </button>
                </div>
              </div>

              <div className="card p-6 space-y-4">
                <h3 className="text-sm font-semibold text-primary">Debug Information</h3>
                <div className="rounded-xl bg-elevated px-4 py-3 border border-border space-y-1 font-mono text-xs text-secondary">
                  <div className="flex justify-between"><span className="text-muted">API Version</span><span>1.0.0</span></div>
                  <div className="flex justify-between"><span className="text-muted">Environment</span><span>{process.env.NODE_ENV || "development"}</span></div>
                  <div className="flex justify-between"><span className="text-muted">API URL</span><span className="truncate max-w-[200px]">{process.env.NEXT_PUBLIC_API_URL || "http://localhost:8000/api"}</span></div>
                </div>
              </div>

              <div className="rounded-xl bg-danger/5 border border-danger/20 p-4 space-y-3">
                <h3 className="text-sm font-semibold text-danger">Danger Zone</h3>
                <p className="text-xs text-muted leading-relaxed">Permanently delete your account and all associated data. This action cannot be undone.</p>
                <button onClick={handleDeleteAccount} disabled={deletingAccount} className="btn bg-danger/10 border border-danger/30 px-5 py-2 text-sm font-medium text-danger hover:bg-danger/20 hover:border-danger/50 rounded-xl disabled:opacity-50">
                  {deletingAccount ? "Deleting..." : "Delete Account"}
                </button>
              </div>
            </section>
          )}

          {/* === INTEGRATIONS === */}
          {activeTab === "integrations" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M13 2L3 14h9l-1 8 10-12h-9l1-8z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Integrations & Import</h2>
                  <p className="text-sm text-muted">Connect external services</p>
                </div>
              </div>
              <div className="space-y-3">
                <IntegrationRow label="Google Calendar" description="Sync tasks with Google Calendar" connected={googleConnected} onConnect={handleConnectGoogle} onDisconnect={handleDisconnectGoogle} />
                <IntegrationRow label="Slack" description="Receive task notifications in Slack" connected={slackConnected} onConnect={handleConnectSlack} onDisconnect={handleDisconnectSlack} />
                <IntegrationRow label="GitHub" description="Link issues and pull requests to tasks" connected={githubConnected} onConnect={handleConnectGithub} onDisconnect={handleDisconnectGithub} />
                <IntegrationRow label="Siri Shortcuts" description="Deep-link into Prysm Note from Shortcuts" connected={siriConnected} onConnect={handleConnectSiri} onDisconnect={handleDisconnectSiri} />
              </div>
              <div className="border-t border-border pt-5 space-y-3">
                <h3 className="text-sm font-semibold text-primary">Data Import/Export</h3>
                <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                  <div><p className="text-sm text-secondary">Export All Data</p><p className="text-xs text-muted">{lastExport ? `Last export: ${lastExport}` : "Download tasks, projects as JSON"}</p></div>
                  <button onClick={handleExport} className="btn bg-accent text-white px-4 py-1.5 text-xs rounded-xl">Export</button>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                  <div><p className="text-sm text-secondary">Import Data</p><p className="text-xs text-muted">Restore from backup JSON file</p></div>
                  <button onClick={handleImport} className="btn bg-elevated border border-border text-secondary px-4 py-1.5 text-xs rounded-xl hover:text-primary">Import</button>
                </div>
              </div>
            </section>
          )}

          {/* === COLLABORATE === */}
          {activeTab === "collaborate" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2 M9 3a4 4 0 1 0 0 8 4 4 0 0 0 0-8z M23 21v-2a4 4 0 0 0-3-3.87 M16 3.13a4 4 0 0 1 0 7.75" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Collaborate</h2>
                  <p className="text-sm text-muted">Shared list settings and invitations</p>
                </div>
              </div>
              {collabMsg && (
                <div className="rounded-xl bg-success/10 border border-success/20 px-4 py-2.5 text-sm text-success">{collabMsg}</div>
              )}
              <div className="space-y-3">
                <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">Create Team</h3>
                <div className="flex gap-2">
                  <input className="input-field flex-1" placeholder="Team name" value={collabTeamName} onChange={(e) => setCollabTeamName(e.target.value)} />
                  <button onClick={handleCreateTeam} disabled={!collabTeamName.trim()} className="btn bg-accent text-white px-4 py-2 text-sm rounded-xl disabled:opacity-50">Create</button>
                </div>
              </div>
              {collabTeams.length > 0 && (
                <div className="space-y-3">
                  <h3 className="text-xs font-semibold text-secondary uppercase tracking-wider">Your Teams</h3>
                  {collabTeams.map((t, i) => (
                    <div key={i} className="rounded-xl bg-elevated px-4 py-3 border border-border">
                      <p className="text-sm font-medium text-primary">{t.name}</p>
                      <div className="mt-2 flex gap-2">
                        <input className="input-field flex-1 text-xs" placeholder="Invite by email" value={i === collabTeams.length - 1 ? collabInviteEmail : ""} onChange={(e) => setCollabInviteEmail(e.target.value)} />
                        <button onClick={handleInvite} className="btn bg-elevated border border-border text-xs text-secondary px-3 py-1 rounded-xl hover:text-primary">Invite</button>
                      </div>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}

          {/* === STICKY NOTE === */}
          {activeTab === "sticky-note" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Sticky Note</h2>
                  <p className="text-sm text-muted">Desktop sticky note configuration</p>
                </div>
              </div>
              <div className="space-y-4">
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Default Color</label>
                  <div className="flex gap-2">{["#FFD700","#FF6B6B","#4ECDC4","#95E1D3","#F38181","#AA96DA"].map((c) => (
                    <button key={c} onClick={() => setStickyColor(c)} className={`w-8 h-8 rounded-lg transition-all hover:scale-110 ${stickyColor === c ? "ring-2 ring-white scale-110" : ""}`} style={{ backgroundColor: c }} />
                  ))}</div>
                </div>
                <div>
                  <label className="mb-1.5 block text-xs font-medium text-secondary">Font Size</label>
                  <select className="input-field" value={stickyFontSize} onChange={(e) => setStickyFontSize(e.target.value)}>
                    <option value="12px">12px</option>
                    <option value="14px">14px</option>
                    <option value="16px">16px</option>
                    <option value="18px">18px</option>
                  </select>
                </div>
                <div className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                  <div><p className="text-sm text-secondary">Auto-show on Launch</p><p className="text-xs text-muted">Show sticky notes when app opens</p></div>
                  <Toggle value={stickyAutoShow} onChange={setStickyAutoShow} />
                </div>
              </div>
            </section>
          )}

          {/* === WIDGETS === */}
          {activeTab === "widgets" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="3" width="18" height="18" rx="2" />;<line x1="3" y1="9" x2="21" y2="9" />;<line x1="9" y1="3" x2="9" y2="21" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Desktop Widgets</h2>
                  <p className="text-sm text-muted">Choose which widgets to display</p>
                </div>
              </div>
              <div className="space-y-3">
                {[
                  { label: "Calendar Mini-view", desc: "Compact month calendar widget", value: widgetCalendar, set: setWidgetCalendar },
                  { label: "Task Counter", desc: "Quick-glance task count badge", value: widgetTasks, set: setWidgetTasks },
                  { label: "Habit Progress", desc: "Today's habit completion ring", value: widgetHabits, set: setWidgetHabits },
                ].map((w) => (
                  <div key={w.label} className="flex items-center justify-between rounded-xl bg-elevated px-4 py-3 border border-border">
                    <div><p className="text-sm text-secondary">{w.label}</p><p className="text-xs text-muted">{w.desc}</p></div>
                    <Toggle value={w.value} onChange={w.set} />
                  </div>
                ))}
              </div>
              <button onClick={handleOpenWidgets} className="btn bg-accent text-white px-5 py-2 text-sm rounded-xl w-full">
                Open Widgets
              </button>
            </section>
          )}

          {/* === AI KEYS === */}
          {activeTab === "ai-keys" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">AI Provider Keys</h2>
                  <p className="text-sm text-muted">API keys for LLM providers</p>
                </div>
              </div>
              <div className="rounded-2xl bg-elevated border border-border p-4 space-y-2 text-xs text-muted leading-relaxed">
                <p className="font-semibold text-secondary text-sm">What happens when you provide your API key?</p>
                <ul className="list-disc list-inside space-y-1 ml-1">
                  <li>Keys are encrypted with <strong className="text-primary">Fernet (AES-128)</strong> before being stored on our servers.</li>
                  <li>Keys are also cached locally in your browser (base64-encoded) for instant, direct-to-LLM AI access.</li>
                  <li>Keys are <strong className="text-primary">only decrypted in-memory</strong> during AI requests — never logged or persisted in plaintext.</li>
                  <li>You can revoke or rotate keys at any time from your provider dashboard.</li>
                </ul>
              </div>
              {keyMsg && (
                <div className="rounded-xl bg-success/10 border border-success/20 px-4 py-2.5 text-sm text-success scale-in">{keyMsg}</div>
              )}
              <div className="space-y-4">
                {[
                  { provider: "openai", label: "OpenAI", placeholder: "sk-..." },
                  { provider: "gemini", label: "Google Gemini", placeholder: "AIza..." },
                  { provider: "deepseek", label: "DeepSeek", placeholder: "sk-..." },
                ].map(({ provider, label, placeholder }) => (
                  <div key={provider}>
                    <div className="flex items-center justify-between mb-1.5">
                      <label className="text-xs font-semibold text-secondary uppercase tracking-wider">{label}</label>
                      <span className={`text-[10px] px-2 py-0.5 rounded-full ${getLocalKey(provider) ? "bg-success/10 text-success border border-success/20" : "bg-muted/10 text-muted border border-border"}`}>
                        {getLocalKey(provider) ? "Local + Server" : "Server Only"}
                      </span>
                    </div>
                    {getKeyByProvider(provider) ? (
                      <div className="flex items-center gap-3 rounded-xl bg-elevated px-4 py-2.5 border border-border hover:border-success/30 transition-colors">
                        <span className="flex h-6 w-6 items-center justify-center rounded-full bg-success/20 text-xs">✓</span>
                        <span className="flex-1 text-sm text-success font-medium">Key configured: {getKeyByProvider(provider)?.key_prefix}...</span>
                        <button onClick={() => handleDeleteKey(getKeyByProvider(provider)!.id, provider)} className="rounded-lg px-2.5 py-1 text-xs text-danger hover:bg-danger/10 font-medium transition-colors">Remove</button>
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
                          className="btn btn-primary px-4 text-sm disabled:opacity-50 shrink-0">{keySaving === provider ? "Saving..." : "Save"}</button>
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === SHORTCUTS === */}
          {activeTab === "shortcuts" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 8V4 M8 12H4 M12 16v4 M16 12h4 M12 2v2 M12 22v-2 M2 12h2 M22 12h-2" />
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">Keyboard Shortcuts</h2>
                  <p className="text-sm text-muted">Quick reference for power users</p>
                </div>
              </div>
              <div className="space-y-1">
                {SHORTCUTS.map((s) => (
                  <div key={s.key} className="flex items-center justify-between rounded-xl bg-elevated px-4 py-2.5 border border-border">
                    <span className="text-sm text-secondary">{s.action}</span>
                    <kbd className="rounded-lg bg-surface border border-border px-3 py-1 text-xs font-mono text-primary">{s.key}</kbd>
                  </div>
                ))}
              </div>
            </section>
          )}

          {/* === ABOUT === */}
          {activeTab === "about" && (
            <section className="card p-6 space-y-5">
              <div className="flex items-center gap-4">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl float">
                  <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                    <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
                  </svg>
                </div>
                <div>
                  <h2 className="text-lg font-bold text-primary">About</h2>
                  <p className="text-sm text-muted">App information</p>
                </div>
              </div>
              <div className="space-y-3">
                <div className="rounded-xl bg-elevated px-4 py-3 border border-border flex justify-between">
                  <span className="text-sm text-secondary">Version</span><span className="text-sm font-mono text-primary">1.0.0</span>
                </div>
                <div className="rounded-xl bg-elevated px-4 py-3 border border-border flex justify-between">
                  <span className="text-sm text-secondary">License</span><span className="text-sm text-primary">AGPL-3.0 (Community)</span>
                </div>
                <div className="rounded-xl bg-elevated px-4 py-3 border border-border flex justify-between">
                  <span className="text-sm text-secondary">Build</span><span className="text-xs font-mono text-muted">development</span>
                </div>
              </div>
              <div className="space-y-2 pt-2">
                <a href="/privacy" className="block text-sm text-accent hover:underline">Privacy Policy</a>
                <a href="/tos" className="block text-sm text-accent hover:underline">Terms of Service</a>
                <a href="https://github.com/MaxV16/PrysmNoteCommunity" className="block text-sm text-accent hover:underline" target="_blank" rel="noopener">GitHub Repository</a>
              </div>
            </section>
          )}

        </div>
      </div>
    </div>
  );
}

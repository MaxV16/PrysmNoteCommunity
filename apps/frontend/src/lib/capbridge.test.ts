import { describe, it, expect, afterEach, vi } from "vitest";
import {
  cancelNativeReminder,
  handleMobileUrl,
  initCapbridge,
  nativeNotificationsSupported,
  openMobileIntegrationConnect,
  reconcileNativeReminders,
  reminderNotificationId,
  scheduleNativeReminder,
  syncNativeReminderForTask,
} from "./capbridge";
import { useAppStore } from "@/stores/app-store";
import type { Task } from "@/types/task";

afterEach(() => {
  vi.unstubAllGlobals();
  useAppStore.getState().reset();
});

function nativeCapacitor(open: ReturnType<typeof vi.fn>) {
  return {
    isNativePlatform: () => true,
    Plugins: {
      App: { addListener: async () => undefined },
      Browser: { open },
    },
  };
}

describe("mobile integration connect hand-off", () => {
  it("is a no-op in a plain browser so the normal redirect runs", async () => {
    expect(
      await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations"),
    ).toBe(false);
  });

  it("opens the app settings url with a mobile marker and nonce in the native app", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Capacitor", nativeCapacitor(open));
    expect(
      await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations"),
    ).toBe(true);
    expect(open).toHaveBeenCalledTimes(1);
    const url = (open.mock.calls[0][0] as { url: string }).url;
    expect(url).toContain("https://prysmnote.com/settings?tab=integrations");
    expect(url).toContain("redirect=mobile");
    expect(url).toContain("connect=github");
    expect(url).toMatch(/nonce=[A-Za-z0-9_-]+/);
  });

  it("returns to Settings on the matching integration deep link", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Capacitor", nativeCapacitor(open));
    const location = {
      origin: "https://prysmnote.com",
      href: "https://prysmnote.com/settings?tab=integrations",
    };
    vi.stubGlobal("location", location);
    await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations");
    const url = (open.mock.calls[0][0] as { url: string }).url;
    const nonce = new URL(url).searchParams.get("nonce");
    handleMobileUrl(`com.prysmnote.app://integration/callback?provider=github&nonce=${nonce}`);
    expect(location.href).toBe("https://prysmnote.com/settings?tab=integrations&connected=github");
  });

  it("ignores an integration deep link whose nonce does not match", async () => {
    const open = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("Capacitor", nativeCapacitor(open));
    const location = {
      origin: "https://prysmnote.com",
      href: "https://prysmnote.com/settings?tab=integrations",
    };
    vi.stubGlobal("location", location);
    await openMobileIntegrationConnect("github", "https://prysmnote.com/settings?tab=integrations");
    handleMobileUrl("com.prysmnote.app://integration/callback?provider=github&nonce=wrong");
    expect(location.href).toBe("https://prysmnote.com/settings?tab=integrations");
  });
});

function nativeCapacitorWithNotifications(overrides: Record<string, unknown> = {}) {
  return {
    isNativePlatform: () => true,
    Plugins: {
      App: { addListener: vi.fn().mockResolvedValue(undefined) },
      Browser: { open: vi.fn().mockResolvedValue(undefined) },
      LocalNotifications: {
        addListener: vi.fn().mockResolvedValue(undefined),
        checkPermissions: vi.fn().mockResolvedValue({ display: "granted" }),
        requestPermissions: vi.fn().mockResolvedValue({ display: "granted" }),
        createChannel: vi.fn().mockResolvedValue(undefined),
        schedule: vi.fn().mockResolvedValue(undefined),
        cancel: vi.fn().mockResolvedValue(undefined),
        getPending: vi.fn().mockResolvedValue({ notifications: [] }),
        ...overrides,
      },
    },
  };
}

function makeTask(over: Partial<Task> = {}): Task {
  return {
    id: "task-1",
    user_id: "user-1",
    parent_task_id: null,
    board_section_id: null,
    board_order: null,
    title: "Write release notes",
    description: null,
    status: "todo",
    priority: 2,
    start_date: null,
    due_date: null,
    start_time: null,
    end_time: null,
    is_all_day: false,
    estimated_minutes: null,
    recurrence_rule: null,
    recurrence_end_date: null,
    sort_order: 0,
    is_archived: false,
    list_id: null,
    deleted_at: null,
    completed_at: null,
    created_at: "2026-10-18T00:00:00Z",
    updated_at: "2026-10-18T00:00:00Z",
    ...over,
  };
}

describe("native reminder notifications", () => {
  it("is a no-op outside the native shell", async () => {
    expect(nativeNotificationsSupported()).toBe(false);
    expect(
      await scheduleNativeReminder({
        taskId: "task-1",
        title: "Write",
        at: "2030-01-01T09:00:00Z",
      })
    ).toBe(false);
    await expect(cancelNativeReminder("task-1")).resolves.toBeUndefined();
    await expect(
      reconcileNativeReminders([{ id: "task-1", title: "Write", reminder_at: "2030-01-01T09:00:00Z" }])
    ).resolves.toBeUndefined();
  });

  it("derives a stable positive notification id from the task id", () => {
    const first = reminderNotificationId("task-1");
    expect(first).toBe(reminderNotificationId("task-1"));
    expect(first).toBeGreaterThan(0);
    expect(first).toBeLessThan(2147483647);
    expect(reminderNotificationId("task-2")).not.toBe(first);
  });

  it("schedules a high-importance Android reminder with the task in extra", async () => {
    const capacitor = nativeCapacitorWithNotifications();
    vi.stubGlobal("Capacitor", capacitor);
    const plugin = capacitor.Plugins.LocalNotifications;

    const ok = await scheduleNativeReminder({
      taskId: "task-1",
      title: "Write release notes",
      at: "2030-01-01T09:00:00Z",
    });

    expect(ok).toBe(true);
    expect(plugin.createChannel).toHaveBeenCalledWith(
      expect.objectContaining({ id: "prysm-reminders", importance: 4 })
    );
    const payload = plugin.schedule.mock.calls[0][0].notifications[0];
    expect(payload.id).toBe(reminderNotificationId("task-1"));
    expect(payload.title).toBe("Write release notes");
    expect(payload.channelId).toBe("prysm-reminders");
    expect(payload.extra).toEqual({ taskId: "task-1", prysm: true });
    expect(payload.schedule.allowWhileIdle).toBe(true);
    expect(payload.schedule.at.toISOString()).toBe("2030-01-01T09:00:00.000Z");
  });

  it("does not schedule or prompt when permission is denied", async () => {
    const capacitor = nativeCapacitorWithNotifications({
      checkPermissions: vi.fn().mockResolvedValue({ display: "denied" }),
      requestPermissions: vi.fn().mockResolvedValue({ display: "denied" }),
    });
    vi.stubGlobal("Capacitor", capacitor);
    const plugin = capacitor.Plugins.LocalNotifications;

    expect(
      await scheduleNativeReminder({
        taskId: "task-1",
        title: "Write",
        at: "2030-01-01T09:00:00Z",
      })
    ).toBe(false);
    expect(plugin.requestPermissions).not.toHaveBeenCalled();
    expect(plugin.schedule).not.toHaveBeenCalled();
  });

  it("cancels by task id outside the plugin", async () => {
    const capacitor = nativeCapacitorWithNotifications();
    vi.stubGlobal("Capacitor", capacitor);

    await cancelNativeReminder("task-1");

    expect(capacitor.Plugins.LocalNotifications.cancel).toHaveBeenCalledWith({
      notifications: [{ id: reminderNotificationId("task-1") }],
    });
  });

  it("reconciles: cancels stale Prysm reminders and schedules upcoming ones", async () => {
    const keepId = reminderNotificationId("keep");
    const capacitor = nativeCapacitorWithNotifications({
      getPending: vi.fn().mockResolvedValue({
        notifications: [
          { id: reminderNotificationId("stale"), extra: { prysm: true } },
          { id: 424242, extra: { prysm: false } },
        ],
      }),
    });
    vi.stubGlobal("Capacitor", capacitor);
    const plugin = capacitor.Plugins.LocalNotifications;

    await reconcileNativeReminders([
      { id: "keep", title: "Keep me", reminder_at: "2030-01-01T09:00:00Z" },
      { id: "past", title: "Too late", reminder_at: "2020-01-01T09:00:00Z" },
    ]);

    expect(plugin.cancel).toHaveBeenCalledTimes(1);
    expect(plugin.cancel).toHaveBeenCalledWith({
      notifications: [{ id: reminderNotificationId("stale") }],
    });
    const scheduled = plugin.schedule.mock.calls[0][0].notifications;
    expect(scheduled).toHaveLength(1);
    expect(scheduled[0].id).toBe(keepId);
  });

  it("syncs a saved task: schedules when active, cancels when done", async () => {
    const capacitor = nativeCapacitorWithNotifications();
    vi.stubGlobal("Capacitor", capacitor);
    const plugin = capacitor.Plugins.LocalNotifications;

    await syncNativeReminderForTask({
      id: "task-1",
      title: "Write",
      status: "todo",
      reminder_enabled: true,
      reminder_at: "2030-01-01T09:00:00Z",
      reminder_push: true,
    });
    expect(plugin.schedule).toHaveBeenCalledTimes(1);

    await syncNativeReminderForTask({
      id: "task-1",
      title: "Write",
      status: "done",
      reminder_enabled: true,
      reminder_at: "2030-01-01T09:00:00Z",
      reminder_push: true,
    });
    expect(plugin.cancel).toHaveBeenCalledWith({
      notifications: [{ id: reminderNotificationId("task-1") }],
    });
  });

  it("opens the task when its OS notification is tapped", async () => {
    const capacitor = nativeCapacitorWithNotifications();
    vi.stubGlobal("Capacitor", capacitor);
    useAppStore.getState().setTasks([makeTask()]);

    initCapbridge();
    const call = capacitor.Plugins.LocalNotifications.addListener.mock.calls.find(
      (entry) => entry[0] === "localNotificationActionPerformed"
    );
    expect(call).toBeTruthy();
    const listener = call?.[1] as (event: Record<string, unknown>) => void;
    listener({ notification: { extra: { taskId: "task-1" } } });

    expect(useAppStore.getState().selectedTaskId).toBe("task-1");
  });
});

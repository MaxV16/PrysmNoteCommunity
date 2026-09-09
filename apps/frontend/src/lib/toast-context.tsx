"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type ToastType = "success" | "error" | "info" | "warning";

interface ToastAction {
  label: string;
  onClick: () => void;
}

interface Toast {
  id: string;
  type: ToastType;
  message: string;
  action?: ToastAction;
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType, action?: ToastAction) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

const TOAST_DURATION = 4000;

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const showToast = useCallback(
    (message: string, type: ToastType = "info", action?: ToastAction) => {
      const id = crypto.randomUUID();
      setToasts((prev) => [...prev, { id, type, message, action }]);
      setTimeout(() => {
        setToasts((prev) => prev.filter((t) => t.id !== id));
      }, TOAST_DURATION);
    },
    []
  );

  return (
    <ToastContext.Provider value={{ toasts, showToast, dismissToast }}>
      {children}
      {/* Toast container */}
      <div className="fixed bottom-4 right-4 z-[9999] flex flex-col gap-2 pointer-events-none">
        {toasts.map((toast) => {
          const colors: Record<ToastType, string> = {
            success: "bg-success/20 text-success border-success/40",
            error: "bg-danger/20 text-danger border-danger/40",
            info: "bg-accent/20 text-accent border-accent/40",
            warning: "bg-warning/20 text-warning border-warning/40",
          };
          const icons: Record<ToastType, string> = {
            success: "\u2714",
            error: "\u2716",
            info: "\u2139",
            warning: "\u26A0",
          };
          return (
            <div
              key={toast.id}
              className={`pointer-events-auto rounded-xl border px-4 py-3 text-sm shadow-lg backdrop-blur-sm slide-up ${colors[toast.type]}`}
            >
              <div className="flex items-center gap-2">
                <span>{icons[toast.type]}</span>
                <span>{toast.message}</span>
                {toast.action && (
                  <button
                    onClick={() => {
                      dismissToast(toast.id);
                      toast.action?.onClick();
                    }}
                    className="ml-2 shrink-0 rounded-lg bg-accent/20 px-2 py-0.5 text-xs font-semibold text-accent transition-colors hover:bg-accent/30"
                  >
                    {toast.action.label}
                  </button>
                )}
                {!toast.action && (
                  <button
                    onClick={() => dismissToast(toast.id)}
                    className="ml-2 opacity-60 hover:opacity-100"
                  >
                    ✖
                  </button>
                )}
              </div>
            </div>
          );
        })}
      </div>
    </ToastContext.Provider>
  );
}

export function useToast() {
  const ctx = useContext(ToastContext);
  if (!ctx) throw new Error("useToast must be used within ToastProvider");
  return ctx;
}
"use client";

import { createContext, useContext, useState, useCallback, type ReactNode } from "react";

type ToastType = "success" | "error" | "info" | "warning";

interface Toast {
  id: string;
  type: ToastType;
  message: string;
}

interface ToastContextValue {
  toasts: Toast[];
  showToast: (message: string, type?: ToastType) => void;
  dismissToast: (id: string) => void;
}

const ToastContext = createContext<ToastContextValue | null>(null);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);

  const showToast = useCallback((message: string, type: ToastType = "info") => {
    const id = crypto.randomUUID();
    setToasts((prev) => [...prev, { id, type, message }]);
    setTimeout(() => {
      setToasts((prev) => prev.filter((t) => t.id !== id));
    }, 4000);
  }, []);

  const dismissToast = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id));
  }, []);

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
                <button
                  onClick={() => dismissToast(toast.id)}
                  className="ml-2 opacity-60 hover:opacity-100"
                >
                  \u2716
                </button>
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
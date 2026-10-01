"use client";

// Core finance settings: read-only ledger summary plus the display currency.
// The premium projection defaults live with the EE projection panel.

import { useEffect, useCallback } from "react";
import { useFinance } from "@/hooks/useFinance";
import { usePreferencesStore } from "@/stores/preferences-store";
import { PREF_FINANCE_CURRENCY } from "@/lib/preferences";

const inputCls =
  "w-full rounded-xl bg-elevated border border-border px-3 py-2 text-sm text-primary placeholder:text-muted focus:outline-none focus:border-accent";

const formatMoney = (v: number, currencyCode: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode, maximumFractionDigits: 0 }).format(Math.round(v || 0));

export function FinanceSettings() {
  const { summary, loading, error, refresh } = useFinance();
  const { prefs, hydrated, hydrate, setPreference } = usePreferencesStore();

  useEffect(() => {
    void refresh();
    if (!hydrated) void hydrate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const currencyCode = typeof prefs[PREF_FINANCE_CURRENCY] === "string" && prefs[PREF_FINANCE_CURRENCY]
    ? (prefs[PREF_FINANCE_CURRENCY] as string)
    : "EUR";
  const currency = useCallback((v: number) => formatMoney(v, currencyCode), [currencyCode]);

  const cards = [
    { label: "Net monthly", value: currency(summary.net), tone: summary.net >= 0 ? "text-success" : "text-danger" },
    { label: "Upcoming income", value: currency(summary.income), tone: "text-success" },
    { label: "Upcoming expenses", value: currency(summary.expense), tone: "text-warning" },
    { label: "Outstanding debt", value: currency(summary.totalDebt), tone: summary.totalDebt > 0 ? "text-danger" : "text-success" },
  ];

  return (
    <div className="space-y-6">
      <section className="card p-6">
        <div className="flex items-center gap-4">
          <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-accent/15 text-2xl">
            <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="var(--accent)" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              <path d="M3 3h18v18H3V3z M3 9h18 M9 3v18" />
            </svg>
          </div>
          <div>
            <h2 className="text-lg font-bold text-primary">Finance</h2>
            <p className="text-sm text-muted">Income, bills and debts are managed in the Finance view.</p>
          </div>
        </div>
      </section>

      {error && (
        <div className="rounded-xl border bg-danger/10 border-danger/20 px-4 py-2.5 text-sm text-danger">{error}</div>
      )}

      <section className="card p-6 space-y-4">
        <h3 className="text-sm font-semibold text-primary">Summary</h3>
        <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
          {cards.map((c) => (
            <div key={c.label} className="rounded-2xl border border-border/70 bg-elevated p-4">
              <p className="text-xs text-muted">{c.label}</p>
              <p className={`mt-1.5 text-xl font-semibold tabular-nums ${c.tone}`}>{loading && c.label === "Net monthly" && summary.net === 0 ? "…" : c.value}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="card p-6 space-y-4">
        <h3 className="text-sm font-semibold text-primary">Configurations</h3>
        <div className="grid grid-cols-1 gap-4 sm:grid-cols-3">
          <div>
            <label className="mb-1.5 block text-xs font-medium text-secondary">Currency</label>
            <select className={inputCls} value={currencyCode} onChange={(e) => setPreference(PREF_FINANCE_CURRENCY, e.target.value)}>
              <option value="EUR">EUR</option>
              <option value="USD">USD</option>
              <option value="GBP">GBP</option>
            </select>
          </div>
        </div>
      </section>
    </div>
  );
}

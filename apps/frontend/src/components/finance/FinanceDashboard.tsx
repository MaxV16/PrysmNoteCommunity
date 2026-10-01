"use client";

// Core finance dashboard. Manual ledger only (income/expense items, debts,
// payments, pay-off). The premium cash-flow projection is an EE extension
// rendered through the guarded slot below.

import { useEffect, useState, useCallback, useMemo } from "react";
import dynamic from "next/dynamic";
import { useFinance, type FinancialItem } from "@/hooks/useFinance";
import { usePreferencesStore } from "@/stores/preferences-store";
import { PREF_FINANCE_CURRENCY } from "@/lib/preferences";
import { FOREGROUND_REFRESH_EVENT } from "@/hooks/useForegroundRefresh";
import {
  daysUntil,
  formatShortDateYear,
  nextDueDate,
  payoffEstimate,
  startOfToday,
  toISODate,
} from "@/lib/finance-utils";


interface FinanceDashboardProps {
  onOpenAi?: () => void;
}

const formatMoney = (v: number, currencyCode: string) =>
  new Intl.NumberFormat(undefined, { style: "currency", currency: currencyCode, maximumFractionDigits: 0 }).format(Math.round(v || 0));

function useFinanceCurrencyCode(): string {
  return usePreferencesStore((s) => {
    const v = s.prefs[PREF_FINANCE_CURRENCY];
    return typeof v === "string" && v ? v : "EUR";
  });
}

const fieldCls = "input-field text-xs px-3 py-2 min-h-0";
const btnSecondary =
  "btn bg-elevated border border-border px-3 py-1.5 text-xs text-secondary hover:text-primary disabled:opacity-50";
const btnPrimary = "btn btn-primary px-4 py-2 text-xs disabled:opacity-50";

const capitalize = (s: string) => (s ? s[0].toUpperCase() + s.slice(1) : s);

function Icon({ path, size = 14 }: { path: string; size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d={path} />
    </svg>
  );
}

const ICON = {
  wallet: "M3 7a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z M16 12h3",
  up: "M12 19V5 M5 12l7-7 7 7",
  down: "M12 5v14 M19 12l-7 7-7-7",
  scale: "M12 3v18 M5 7h14 M7 7l-3 7h6z M17 7l-3 7h6z",
  debt: "M12 2v20 M17 5H9.5a3.5 3.5 0 0 0 0 7h5a3.5 3.5 0 0 1 0 7H6",
  spark: "M13 2L3 14h9l-1 8 10-12h-9l1-8z",
  refresh: "M23 4v6h-6 M20.49 15a9 9 0 1 1-2.12-9.36L23 10",
  plus: "M12 5v14 M5 12h14",
  activity: "M22 12h-4l-3 9L9 3l-3 9H2",
  chevron: "M6 9l6 6 6-6",
  search: "M11 4a7 7 0 1 0 0 14 7 7 0 0 0 0-14z M21 21l-4.3-4.3",
  clock: "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 6v6l4 2",
};

function DueBadge({ item }: { item: FinancialItem }) {
  const due = nextDueDate(item);
  if (!due) return null;
  const d = daysUntil(due);
  const tone =
    d < 0
      ? "bg-danger/10 text-danger"
      : d <= 3
        ? "bg-warning/10 text-warning"
        : "bg-elevated text-secondary";
  const label = d < 0 ? `Overdue ${Math.abs(d)}d` : d === 0 ? "Due today" : `Due in ${d}d`;
  return (
    <span className={`inline-flex items-center gap-1 rounded-full px-2 py-0.5 text-[10px] font-medium ${tone}`} title={formatShortDateYear(due)}>
      <Icon path={ICON.clock} size={10} />
      {label}
    </span>
  );
}

export function FinanceDashboard({ onOpenAi }: FinanceDashboardProps) {
  const {
    items, debts, transactions, summary, loading, error,
    refresh, createItem, updateItem, deleteItem, recordPayment, payOff, reverseTransaction,
  } = useFinance();

  const currencyCode = useFinanceCurrencyCode();
  const currency = useCallback((v: number) => formatMoney(v, currencyCode), [currencyCode]);

  useEffect(() => {
    refresh();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const onRefresh = () => refresh();
    window.addEventListener(FOREGROUND_REFRESH_EVENT, onRefresh);
    return () => window.removeEventListener(FOREGROUND_REFRESH_EVENT, onRefresh);
  }, [refresh]);

  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [showAdd, setShowAdd] = useState(false);

  // List controls
  const [query, setQuery] = useState("");
  const [categoryFilter, setCategoryFilter] = useState("");
  const [debtSort, setDebtSort] = useState<"remaining" | "due" | "name">("remaining");

  // Add-item form state
  const [fName, setFName] = useState("");
  const [fDirection, setFDirection] = useState("expense");
  const [fAmount, setFAmount] = useState("");
  const [fKind, setFKind] = useState("recurring");
  const [fStart, setFStart] = useState("");
  const [fEnd, setFEnd] = useState("");
  const [fUnit, setFUnit] = useState("month");
  const [fInterval, setFInterval] = useState("1");
  const [fRepeatCount, setFRepeatCount] = useState("");
  const [fIsDebt, setFIsDebt] = useState(false);
  const [fPrincipal, setFPrincipal] = useState("");
  const [fInterest, setFInterest] = useState("");

  const hasData = summary.itemCount > 0;

  const incomeShare = summary.monthlyIncome + summary.monthlyExpense > 0
    ? Math.round((summary.monthlyIncome / (summary.monthlyIncome + summary.monthlyExpense)) * 100)
    : 50;

  const stats = [
    { label: "Upcoming income", value: currency(summary.income), tone: "text-success", chip: "bg-success/10 text-success", icon: ICON.up, hint: `${summary.incomeCount} item${summary.incomeCount === 1 ? "" : "s"}` },
    { label: "Upcoming expenses", value: currency(summary.expense), tone: "text-warning", chip: "bg-warning/10 text-warning", icon: ICON.down, hint: `${summary.expenseCount} item${summary.expenseCount === 1 ? "" : "s"}` },
    { label: "Net monthly", value: currency(summary.monthlyIncome - summary.monthlyExpense), tone: summary.monthlyIncome - summary.monthlyExpense >= 0 ? "text-success" : "text-danger", chip: "bg-accent/10 text-accent", icon: ICON.scale, hint: "recurring only" },
    { label: "Outstanding debt", value: currency(summary.totalDebt), tone: summary.totalDebt > 0 ? "text-danger" : "text-success", chip: "bg-danger/10 text-danger", icon: ICON.debt, hint: `${summary.debtCount} active` },
  ];

  const categories = useMemo(() => {
    const set = new Set<string>();
    items.forEach((i) => { if (i.category) set.add(i.category); });
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [items]);

  const filteredItems = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((i) => {
      if (categoryFilter && i.category !== categoryFilter) return false;
      if (!q) return true;
      return [i.name, i.category, i.payee].some((v) => (v || "").toLowerCase().includes(q));
    });
  }, [items, query, categoryFilter]);

  const expenseItems = useMemo(() => filteredItems.filter((i) => i.direction !== "income"), [filteredItems]);
  const incomeItems = useMemo(() => filteredItems.filter((i) => i.direction === "income"), [filteredItems]);
  const expenseTotal = expenseItems.reduce((s, i) => s + parseFloat(i.amount || "0"), 0);
  const incomeTotal = incomeItems.reduce((s, i) => s + parseFloat(i.amount || "0"), 0);

  const sortedDebts = useMemo(() => {
    const list = [...debts];
    if (debtSort === "name") list.sort((a, b) => a.name.localeCompare(b.name));
    else if (debtSort === "due") {
      const today = startOfToday();
      const at = (i: FinancialItem) => nextDueDate(i, today)?.getTime() ?? Number.POSITIVE_INFINITY;
      list.sort((a, b) => at(a) - at(b));
    } else {
      const rem = (i: FinancialItem) => parseFloat(i.remaining_balance || i.principal || "0");
      list.sort((a, b) => rem(b) - rem(a));
    }
    return list;
  }, [debts, debtSort]);

  const suggestCadence = useCallback((name: string) => {
    const n = name.toLowerCase();
    if (/\bweek/.test(n)) { setFUnit("week"); setFInterval("1"); }
    else if (/\b(year|annual|annually)\b/.test(n)) { setFUnit("year"); setFInterval("1"); }
    else if (/\b(month|rent|salary|wage|subscription|bill|mortgage)\b/.test(n)) { setFUnit("month"); setFInterval("1"); }
  }, []);

  const handleAdd = useCallback(async () => {
    if (!fName || !fAmount) {
      setMsg({ text: "Name and amount are required.", ok: false });
      return;
    }
    const dupe = items.find((i) => i.name.trim().toLowerCase() === fName.trim().toLowerCase());
    if (dupe && !window.confirm(`"${fName}" is already in your ledger. Add another?`)) return;

    const payload: Record<string, unknown> = {
      name: fName,
      direction: fDirection,
      amount: parseFloat(fAmount),
      kind: fKind,
      // A recurring item with no start date starts today; a one-off with no
      // date is left undated for the user to fill in.
      start_date: fStart || (fKind === "recurring" ? toISODate(startOfToday()) : null),
      end_date: fEnd || null,
      frequency_unit: fKind === "recurring" ? fUnit : null,
      frequency_interval: fKind === "recurring" ? parseInt(fInterval || "1", 10) : null,
      repeat_count: fRepeatCount ? parseInt(fRepeatCount, 10) : null,
    };
    if (fIsDebt) {
      payload.principal = parseFloat(fPrincipal || fAmount);
      payload.interest_rate = fInterest ? parseFloat(fInterest) : null;
    }
    try {
      await createItem(payload);
      setFName(""); setFAmount(""); setFEnd(""); setFStart(""); setFRepeatCount(""); setFPrincipal(""); setFInterest("");
      setMsg({ text: "Item added.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to add item", ok: false });
    }
  }, [fName, fAmount, fDirection, fKind, fStart, fEnd, fUnit, fInterval, fRepeatCount, fIsDebt, fPrincipal, fInterest, createItem, items]);

  const handleUpdate = useCallback(async (itemId: string, payload: Record<string, unknown>) => {
    try {
      await updateItem(itemId, payload);
      setMsg({ text: "Item updated.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to update item", ok: false });
    }
  }, [updateItem]);

  const handleDelete = useCallback(async (itemId: string, name: string) => {
    if (!window.confirm(`Delete "${name}"? This cannot be undone.`)) return;
    try {
      await deleteItem(itemId);
      setMsg({ text: "Item deleted.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to delete item", ok: false });
    }
  }, [deleteItem]);

  const handlePay = useCallback(async (itemId: string, amount: number) => {
    const today = toISODate(startOfToday());
    try {
      await recordPayment(itemId, today, amount);
      setMsg({ text: "Payment recorded.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to record payment", ok: false });
    }
  }, [recordPayment]);

  const handlePayOff = useCallback(async (itemId: string, name: string) => {
    if (!window.confirm(`Pay off "${name}" in full?`)) return;
    const today = toISODate(startOfToday());
    try {
      await payOff(itemId, today);
      setMsg({ text: "Item paid off in full.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to pay off item", ok: false });
    }
  }, [payOff]);

  const handleUndoTransaction = useCallback(async (transactionId: string, label: string) => {
    if (!window.confirm(`Remove this payment (${label})? The item's balance will be restored.`)) return;
    try {
      await reverseTransaction(transactionId);
      setMsg({ text: "Payment removed.", ok: true });
    } catch (e) {
      setMsg({ text: e instanceof Error ? e.message : "Failed to remove payment", ok: false });
    }
  }, [reverseTransaction]);

  const savingsTone = summary.savingsRate >= 0.2 ? "text-success" : summary.savingsRate >= 0 ? "text-warning" : "text-danger";

  return (
    <div className="h-full min-h-0 overflow-y-auto bg-base">
      <div className="mx-auto w-full max-w-6xl px-4 py-6 lg:px-8">
        {/* Header */}
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-3">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-accent/10 text-accent">
              <Icon path={ICON.wallet} size={20} />
            </div>
            <div>
              <h1 className="text-2xl font-bold text-primary">Finance</h1>
              <p className="text-sm text-secondary">Income, bills and debts in one ledger.</p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            {onOpenAi && (
              <button onClick={onOpenAi} className={btnSecondary}>
                <Icon path={ICON.spark} size={13} />
                <span className="ml-1.5">Ask AI</span>
              </button>
            )}
            <button onClick={refresh} disabled={loading} className={btnSecondary}>
              <Icon path={ICON.refresh} size={13} />
              <span className="ml-1.5">{loading ? "Loading..." : "Refresh"}</span>
            </button>
          </div>
        </div>

        {error && (
          <div className="mt-4 rounded-xl border border-danger/20 bg-danger/10 px-4 py-2.5 text-sm text-danger">{error}</div>
        )}
        {msg && (
          <div className={`mt-4 rounded-xl border px-4 py-2.5 text-sm ${msg.ok ? "border-success/20 bg-success/10 text-success" : "border-danger/20 bg-danger/10 text-danger"}`}>
            {msg.text}
          </div>
        )}

        {/* Overview */}
        <div className="mt-6 grid grid-cols-2 gap-3 lg:grid-cols-4">
          {stats.map((c) => (
            <div key={c.label} className="card p-4">
              <div className="flex items-center justify-between gap-2">
                <p className="text-xs text-muted">{c.label}</p>
                <span className={`flex h-7 w-7 items-center justify-center rounded-lg ${c.chip}`}>
                  <Icon path={c.icon} size={14} />
                </span>
              </div>
              <p className={`mt-2 text-xl font-semibold tabular-nums ${c.tone}`}>{c.value}</p>
              <p className="mt-0.5 text-[11px] text-muted">{c.hint}</p>
            </div>
          ))}
        </div>

        {/* Monthly picture */}
        <div className="mt-3 card p-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <p className="text-sm font-semibold text-primary">A typical month</p>
            <div className="flex items-center gap-4 text-xs">
              <span className="text-secondary">Savings rate <span className={`font-semibold tabular-nums ${savingsTone}`}>{Math.round(summary.savingsRate * 100)}%</span></span>
            </div>
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="text-[11px] text-muted">Income / mo</p>
              <p className="text-sm font-semibold tabular-nums text-success">{currency(summary.monthlyIncome)}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Expenses / mo</p>
              <p className="text-sm font-semibold tabular-nums text-warning">{currency(summary.monthlyExpense)}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Debt payments / mo</p>
              <p className="text-sm font-semibold tabular-nums text-danger">{currency(summary.monthlyDebt)}</p>
            </div>
            <div>
              <p className="text-[11px] text-muted">Left / mo</p>
              <p className="text-sm font-semibold tabular-nums text-primary">{currency(summary.monthlyIncome - summary.monthlyExpense)}</p>
            </div>
          </div>
          <div className="mt-3 flex h-2 overflow-hidden rounded-full bg-elevated">
            <div className="bg-success transition-all" style={{ width: `${incomeShare}%` }} />
            <div className="flex-1 bg-warning transition-all" />
          </div>
          <p className="mt-2 text-[11px] text-muted">Recurring items normalised to an average month (weekly x52/12, yearly /12).</p>
        </div>

        {/* Add item */}
        <section className="mt-6 card overflow-hidden">
          <button
            onClick={() => setShowAdd((v) => !v)}
            className="flex w-full items-center justify-between px-5 py-4 text-left"
          >
            <div className="flex items-center gap-3">
              <span className="flex h-8 w-8 items-center justify-center rounded-lg bg-accent/10 text-accent">
                <Icon path={ICON.plus} size={15} />
              </span>
              <div>
                <p className="text-sm font-semibold text-primary">Add income, expense or debt</p>
                <p className="text-[11px] text-muted">Recurring or one-off, with an optional remaining balance for loans.</p>
              </div>
            </div>
            <span className={`text-muted transition-transform ${showAdd ? "rotate-180" : ""}`}>
              <Icon path={ICON.chevron} size={16} />
            </span>
          </button>

          {showAdd && (
            <div className="border-t border-border px-5 pb-5 pt-4">
              <div className="flex flex-wrap items-center gap-3">
                <div className="inline-flex rounded-full bg-elevated p-0.5">
                  {["expense", "income"].map((d) => (
                    <button
                      key={d}
                      onClick={() => setFDirection(d)}
                      className={`rounded-full px-3.5 py-1 text-xs transition-colors ${
                        fDirection === d
                          ? "bg-accent font-semibold text-[var(--on-gradient)]"
                          : "text-secondary hover:text-primary"
                      }`}
                    >
                      {capitalize(d)}
                    </button>
                  ))}
                </div>
                <label className="flex items-center gap-2 text-xs text-secondary">
                  <input type="checkbox" checked={fIsDebt} onChange={(e) => setFIsDebt(e.target.checked)} className="accent-accent" />
                  This is a debt / loan
                </label>
              </div>

              <div className="mt-3 grid grid-cols-2 gap-3 sm:grid-cols-4 lg:grid-cols-6">
                <input className={fieldCls} placeholder="Name (e.g. Car loan)" value={fName} onChange={(e) => { setFName(e.target.value); suggestCadence(e.target.value); }} />
                <input className={fieldCls} placeholder={fIsDebt ? "Payment amount" : "Amount"} type="number" value={fAmount} onChange={(e) => setFAmount(e.target.value)} />
                {fIsDebt && (
                  <>
                    <input className={fieldCls} placeholder="Total owed (principal)" type="number" value={fPrincipal} onChange={(e) => setFPrincipal(e.target.value)} />
                    <input className={fieldCls} placeholder="Interest % (opt)" type="number" value={fInterest} onChange={(e) => setFInterest(e.target.value)} />
                  </>
                )}
                <input className={fieldCls} placeholder="Start date" type="date" value={fStart} onChange={(e) => setFStart(e.target.value)} />
                <input className={fieldCls} placeholder="End date (opt)" type="date" value={fEnd} onChange={(e) => setFEnd(e.target.value)} />
                <select className={fieldCls} value={fKind} onChange={(e) => setFKind(e.target.value)}>
                  <option value="recurring">Recurring</option>
                  <option value="one_off">One-off</option>
                </select>
                {fKind === "recurring" && (
                  <>
                    <select className={fieldCls} value={fUnit} onChange={(e) => setFUnit(e.target.value)} aria-label="Interval unit">
                      <option value="day">day(s)</option>
                      <option value="week">week(s)</option>
                      <option value="month">month(s)</option>
                      <option value="year">year(s)</option>
                    </select>
                    <input className={fieldCls} placeholder="Every (default 1)" type="number" min={1} value={fInterval} onChange={(e) => setFInterval(e.target.value)} aria-label="Interval count" />
                    <input className={fieldCls} placeholder="For N times (opt)" type="number" min={1} value={fRepeatCount} onChange={(e) => setFRepeatCount(e.target.value)} aria-label="Repeat count" />
                  </>
                )}
                <button onClick={handleAdd} className={btnPrimary}>Add</button>
              </div>
              <p className="mt-3 text-[11px] text-muted">
                Recurrence is fully customisable: every 2 weeks, every 3 months, or a set number of occurrences. Debts track a remaining balance and a pay-off date.
              </p>
            </div>
          )}
        </section>

        {/* Controls */}
        <div className="mt-6 flex flex-wrap items-center gap-2">
          <label className="relative flex-1 min-w-[180px]">
            <span className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted">
              <Icon path={ICON.search} size={13} />
            </span>
            <input
              className={`${fieldCls} pl-8`}
              placeholder="Search income, expenses and debts"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              aria-label="Search finance"
            />
          </label>
          <select className={fieldCls} style={{ maxWidth: 180 }} value={categoryFilter} onChange={(e) => setCategoryFilter(e.target.value)} aria-label="Filter by category">
            <option value="">All categories</option>
            {categories.map((c) => <option key={c} value={c}>{c}</option>)}
          </select>
        </div>

        {/* Lists */}
        <div className="mt-4 grid gap-6 lg:grid-cols-3">
          <div className="space-y-6 lg:col-span-2">
            <section className="card p-5">
              <div className="flex items-center justify-between">
                <h2 className="text-base font-semibold text-primary">Income &amp; expenses</h2>
                <span className="badge bg-elevated text-secondary">{filteredItems.length}</span>
              </div>
              <div className="mt-4">
                {items.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-surface/60 p-8 text-center">
                    <p className="text-sm font-medium text-secondary">Nothing tracked yet</p>
                    <p className="mx-auto mt-1 max-w-sm text-xs text-muted">Add income, a bill, or a debt above - or tell the AI, e.g. &ldquo;log my salary as income&rdquo;.</p>
                  </div>
                ) : filteredItems.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-surface/60 p-8 text-center text-sm text-muted">
                    No items match your filters.
                  </div>
                ) : (
                  <div className="space-y-5">
                    {expenseItems.length > 0 && (
                      <ItemGroup title="Expenses" total={expenseTotal} currency={currency} count={expenseItems.length}>
                        {expenseItems.map((i) => (
                          <ItemRow key={i.id} item={i} onUpdate={handleUpdate} onDelete={handleDelete} onPayOff={handlePayOff} />
                        ))}
                      </ItemGroup>
                    )}
                    {incomeItems.length > 0 && (
                      <ItemGroup title="Income" total={incomeTotal} currency={currency} count={incomeItems.length}>
                        {incomeItems.map((i) => (
                          <ItemRow key={i.id} item={i} onUpdate={handleUpdate} onDelete={handleDelete} onPayOff={handlePayOff} />
                        ))}
                      </ItemGroup>
                    )}
                  </div>
                )}
              </div>
            </section>
          </div>

          <div className="space-y-6">
            <section className="card p-5">
              <div className="flex items-center justify-between gap-2">
                <h2 className="text-base font-semibold text-primary">Debts &amp; loans</h2>
                <div className="flex items-center gap-2">
                  <span className="badge bg-elevated text-secondary">{debts.length}</span>
                  {debts.length > 1 && (
                    <select className={`${fieldCls} !py-1`} style={{ maxWidth: 130 }} value={debtSort} onChange={(e) => setDebtSort(e.target.value as typeof debtSort)} aria-label="Sort debts">
                      <option value="remaining">Biggest</option>
                      <option value="due">Next due</option>
                      <option value="name">Name</option>
                    </select>
                  )}
                </div>
              </div>
              <div className="mt-4">
                {debts.length === 0 ? (
                  <div className="rounded-xl border border-dashed border-border bg-surface/60 p-6 text-center">
                    <p className="text-sm font-medium text-secondary">No debts tracked</p>
                    <p className="mx-auto mt-1 text-xs text-muted">Tick &ldquo;This is a debt / loan&rdquo; when adding an item to track its balance.</p>
                  </div>
                ) : (
                  <div className="space-y-3">
                    {sortedDebts.map((d) => (
                      <DebtCard
                        key={d.id}
                        debt={d}
                        currency={currency}
                        onSave={(id, payload) => handleUpdate(id, payload)}
                        onDelete={handleDelete}
                        onPay={handlePay}
                        onPayOff={handlePayOff}
                      />
                    ))}
                  </div>
                )}
              </div>
            </section>

            <section className="card p-5">
              <h2 className="text-base font-semibold text-primary">Recent activity</h2>
              {transactions.length === 0 ? (
                <p className="mt-4 text-sm text-muted">No transactions yet. Payments you record appear here.</p>
              ) : (
                <div className="mt-3 space-y-1.5">
                  {transactions.map((t) => (
                    <div key={t.id} className="flex items-center justify-between rounded-lg bg-elevated px-3 py-2.5">
                      <div className="min-w-0">
                        <p className="truncate text-sm text-primary">{t.description || t.counterparty || "Transaction"}</p>
                        <p className="text-[11px] text-muted">{t.date}{t.category ? ` - ${t.category}` : ""}{t.source !== "manual" ? " - imported" : ""}</p>
                      </div>
                      <div className="flex items-center gap-2">
                        <span className={`text-sm font-medium tabular-nums ${parseFloat(t.amount) >= 0 ? "text-success" : "text-danger"}`}>
                          {parseFloat(t.amount) >= 0 ? "+" : ""}{currency(parseFloat(t.amount))}
                        </span>
                        {t.item_id && (
                          <button
                            type="button"
                            onClick={() => handleUndoTransaction(t.id, t.description || t.counterparty || "payment")}
                            title="Remove this payment and restore the balance"
                            className="rounded-full border border-border bg-base px-2 py-0.5 text-[11px] text-secondary transition-colors hover:text-primary"
                          >
                            Undo
                          </button>
                        )}
                      </div>
                    </div>
                  ))}
                </div>
              )}
              {!hasData && (
                <p className="mt-4 border-t border-border pt-3 text-[11px] text-muted">
                  This dashboard reflects your own ledger. Add data above or through the AI command.
                </p>
              )}
            </section>
          </div>
        </div>

        {/* Cash-flow projection (premium) */}
      </div>
    </div>
  );
}

interface ItemGroupProps {
  title: string;
  total: number;
  count: number;
  currency: (v: number) => string;
  children: React.ReactNode;
}

function ItemGroup({ title, total, count, currency, children }: ItemGroupProps) {
  return (
    <div>
      <div className="mb-2 flex items-center justify-between">
        <p className="text-xs font-semibold uppercase tracking-wide text-muted">{title}</p>
        <p className="text-xs text-secondary">
          <span className="tabular-nums text-primary">{currency(total)}</span>
          <span className="ml-2 text-muted">{count} item{count === 1 ? "" : "s"}</span>
        </p>
      </div>
      <div className="space-y-1.5">{children}</div>
    </div>
  );
}

interface ItemEditorProps {
  item: FinancialItem;
  submitLabel?: string;
  onSave: (payload: Record<string, unknown>) => void | Promise<void>;
  onCancel: () => void;
}

/** One editor for every ledger row (income/expense and debts). Saving sends an
 * explicit value for every editable field, including nulls that clear a field
 * (e.g. converting a debt back into a plain item). */
function ItemEditor({ item, submitLabel = "Save", onSave, onCancel }: ItemEditorProps) {
  const [name, setName] = useState(item.name);
  const [amount, setAmount] = useState(item.amount);
  const [kind, setKind] = useState(item.kind || "recurring");
  const [unit, setUnit] = useState(item.frequency_unit || "month");
  const [interval, setInterval] = useState(String(item.frequency_interval || 1));
  const [repeatCount, setRepeatCount] = useState(item.repeat_count != null ? String(item.repeat_count) : "");
  const [start, setStart] = useState(item.start_date || "");
  const [end, setEnd] = useState(item.end_date || "");
  const [isDebt, setIsDebt] = useState(item.principal != null);
  const [principal, setPrincipal] = useState(item.principal ?? "");
  const [remaining, setRemaining] = useState(item.remaining_balance ?? "");
  const [interest, setInterest] = useState(item.interest_rate ?? "");
  const [paidOff, setPaidOff] = useState(Boolean(item.paid_off_at));
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (busy) return;
    setBusy(true);
    const payload: Record<string, unknown> = {
      name,
      amount: parseFloat(amount || "0"),
      kind,
      start_date: start || null,
      end_date: end || null,
      frequency_unit: kind === "recurring" ? unit : null,
      frequency_interval: kind === "recurring" ? parseInt(interval || "1", 10) : null,
      repeat_count: kind === "recurring" && repeatCount ? parseInt(repeatCount, 10) : null,
    };
    if (isDebt) {
      payload.principal = principal !== "" ? parseFloat(String(principal)) : parseFloat(amount || "0");
      payload.remaining_balance = remaining !== "" ? parseFloat(String(remaining)) : null;
      payload.interest_rate = interest !== "" ? parseFloat(String(interest)) : null;
      payload.paid_off_at = paidOff ? (item.paid_off_at || toISODate(startOfToday())) : null;
    } else {
      // Clear any previous debt fields when the item stops being a debt.
      payload.principal = null;
      payload.remaining_balance = null;
      payload.interest_rate = null;
      payload.paid_off_at = null;
    }
    try {
      await onSave(payload);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex w-full flex-wrap items-center gap-2">
      <input className={fieldCls} style={{ maxWidth: "160px" }} value={name} onChange={(e) => setName(e.target.value)} placeholder="Name" />
      <input className={fieldCls} style={{ maxWidth: "110px" }} type="number" value={amount} onChange={(e) => setAmount(e.target.value)} placeholder="Amount" aria-label="Amount" />
      <select className={fieldCls} style={{ maxWidth: "120px" }} value={kind} onChange={(e) => setKind(e.target.value)} aria-label="Kind">
        <option value="recurring">Recurring</option>
        <option value="one_off">One-off</option>
      </select>
      {kind === "recurring" && (
        <>
          <select className={fieldCls} style={{ maxWidth: "100px" }} value={unit} onChange={(e) => setUnit(e.target.value)} aria-label="Interval unit">
            <option value="day">day(s)</option><option value="week">week(s)</option><option value="month">month(s)</option><option value="year">year(s)</option>
          </select>
          <input className={fieldCls} style={{ maxWidth: "80px" }} type="number" min={1} value={interval} onChange={(e) => setInterval(e.target.value)} aria-label="Every" />
          <input className={fieldCls} style={{ maxWidth: "110px" }} type="number" min={1} value={repeatCount} onChange={(e) => setRepeatCount(e.target.value)} placeholder="For N times" aria-label="Repeat count" />
        </>
      )}
      <input className={fieldCls} style={{ maxWidth: "140px" }} type="date" value={start} onChange={(e) => setStart(e.target.value)} aria-label="Start date" />
      <input className={fieldCls} style={{ maxWidth: "140px" }} type="date" value={end} onChange={(e) => setEnd(e.target.value)} aria-label="End date" />

      <label className="flex items-center gap-1.5 text-[11px] text-secondary">
        <input type="checkbox" checked={isDebt} onChange={(e) => setIsDebt(e.target.checked)} className="accent-accent" />
        Debt / loan
      </label>
      {isDebt && (
        <>
          <input className={fieldCls} style={{ maxWidth: "120px" }} type="number" value={principal} onChange={(e) => setPrincipal(e.target.value)} placeholder="Total owed" aria-label="Principal" />
          <input className={fieldCls} style={{ maxWidth: "120px" }} type="number" value={remaining} onChange={(e) => setRemaining(e.target.value)} placeholder="Remaining" aria-label="Remaining balance" />
          <input className={fieldCls} style={{ maxWidth: "100px" }} type="number" value={interest} onChange={(e) => setInterest(e.target.value)} placeholder="Interest %" aria-label="Interest rate" />
          <label className="flex items-center gap-1.5 text-[11px] text-secondary">
            <input type="checkbox" checked={paidOff} onChange={(e) => setPaidOff(e.target.checked)} className="accent-accent" />
            Paid off
          </label>
        </>
      )}

      <button onClick={() => void save()} disabled={busy} className={btnPrimary}>{busy ? "Saving..." : submitLabel}</button>
      <button onClick={onCancel} className={btnSecondary}>Cancel</button>
    </div>
  );
}

interface ItemRowProps {
  item: FinancialItem;
  onUpdate: (id: string, payload: Record<string, unknown>) => Promise<void> | void;
  onDelete: (id: string, name: string) => Promise<void> | void;
  onPayOff: (id: string, name: string) => Promise<void> | void;
}

function ItemRow({ item, onUpdate, onDelete, onPayOff }: ItemRowProps) {
  const [editing, setEditing] = useState(false);
  const currencyCode = useFinanceCurrencyCode();
  const currency = (v: number) => formatMoney(v, currencyCode);

  const isPaidOff = Boolean(item.paid_off_at);
  const isIncome = item.direction === "income";

  if (editing) {
    return (
      <div className="rounded-lg border border-accent/30 bg-elevated px-3 py-2.5">
        <ItemEditor
          item={item}
          onSave={async (payload) => { await onUpdate(item.id, payload); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="group flex flex-wrap items-center justify-between gap-2 rounded-lg bg-elevated px-3 py-2.5 transition-colors hover:bg-hover">
      <div className="flex min-w-0 items-center gap-3">
        <span className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-lg ${isIncome ? "bg-success/10 text-success" : "bg-warning/10 text-warning"}`}>
          <Icon path={isIncome ? ICON.up : ICON.down} size={13} />
        </span>
        <div className="min-w-0">
          <p className="truncate text-sm text-primary">{item.name}{isPaidOff ? " ✓" : ""}</p>
          <p className="truncate text-[11px] text-muted">
            {item.kind === "recurring" ? "recurring" : "one-off"}
            {item.frequency_unit ? ` - every ${item.frequency_interval || 1} ${item.frequency_unit}${(item.frequency_interval || 1) > 1 ? "s" : ""}` : item.frequency ? ` - ${item.frequency}` : ""}
            {item.repeat_count ? ` - for ${item.repeat_count}` : ""}
            {item.start_date ? ` - ${item.start_date}` : ""}
            {item.category ? ` - ${item.category}` : ""}
            {isPaidOff ? " - paid" : ""}
          </p>
        </div>
      </div>
      <div className="flex items-center gap-2">
        {item.kind === "recurring" && <DueBadge item={item} />}
        <span className={`text-sm font-semibold tabular-nums ${isIncome ? "text-success" : "text-danger"}`}>
          {isIncome ? "+" : "−"}{currency(parseFloat(item.amount || "0"))}
        </span>
        <div className="flex items-center gap-1 opacity-100 transition-opacity lg:opacity-0 lg:group-hover:opacity-100">
          <button onClick={() => setEditing(true)} className="rounded border border-border bg-base px-2 py-1 text-[11px] text-secondary hover:text-primary">Edit</button>
          {item.principal !== null && item.principal !== undefined && !isPaidOff && (
            <button onClick={() => onPayOff(item.id, item.name)} className="rounded border border-border bg-base px-2 py-1 text-[11px] text-success">Pay off</button>
          )}
          <button onClick={() => onDelete(item.id, item.name)} className="rounded border border-border bg-base px-2 py-1 text-[11px] text-danger">Delete</button>
        </div>
      </div>
    </div>
  );
}

interface DebtCardProps {
  debt: FinancialItem;
  currency: (v: number) => string;
  onSave: (id: string, payload: Record<string, unknown>) => Promise<void> | void;
  onDelete: (id: string, name: string) => Promise<void> | void;
  onPay: (id: string, amount: number) => Promise<void> | void;
  onPayOff: (id: string, name: string) => Promise<void> | void;
}

function DebtCard({ debt, currency, onSave, onDelete, onPay, onPayOff }: DebtCardProps) {
  const [editing, setEditing] = useState(false);
  const remainingRaw = parseFloat(debt.remaining_balance || debt.principal || "0");
  const principalRaw = parseFloat(debt.principal || "0");
  const payment = parseFloat(debt.amount || "0");
  const paidPct = principalRaw > 0 ? Math.min(100, Math.round(((principalRaw - remainingRaw) / principalRaw) * 100)) : 0;
  const payoff = payoffEstimate(debt);

  if (editing) {
    return (
      <div className="rounded-xl border border-accent/30 bg-elevated p-3.5">
        <p className="mb-2 truncate text-sm font-medium text-primary">{debt.name}</p>
        <ItemEditor
          item={debt}
          onSave={async (payload) => { await onSave(debt.id, payload); setEditing(false); }}
          onCancel={() => setEditing(false)}
        />
      </div>
    );
  }

  return (
    <div className="group rounded-xl border border-border/70 bg-elevated p-3.5">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium text-primary">{debt.name}</p>
          <p className="text-[11px] text-muted">
            {payment ? `${currency(payment)} payment` : ""}
            {debt.frequency_unit ? ` every ${debt.frequency_interval || 1} ${debt.frequency_unit}${(debt.frequency_interval || 1) > 1 ? "s" : ""}` : ""}
            {debt.repeat_count ? ` - for ${debt.repeat_count} more` : ""}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-1.5">
          <DueBadge item={debt} />
          <p className="text-right text-sm font-semibold tabular-nums text-danger">{currency(remainingRaw)}</p>
        </div>
      </div>
      <div className="mt-2.5 h-1.5 overflow-hidden rounded-full bg-base">
        <div className="h-full rounded-full bg-success transition-all" style={{ width: `${paidPct}%` }} />
      </div>
      <div className="mt-2.5 flex flex-wrap items-center justify-between gap-2">
        <span className="text-[11px] text-muted">
          {paidPct}% paid of {currency(principalRaw)}
          {payoff ? ` · ~${payoff.payments} payments left (${formatShortDateYear(payoff.date)})` : ""}
        </span>
        <div className="flex gap-1.5">
          <button onClick={() => setEditing(true)} className="rounded border border-border bg-base px-2 py-1 text-[11px] text-secondary hover:text-primary">Edit</button>
          <button onClick={() => onPay(debt.id, payment)} disabled={payment <= 0} className={btnSecondary}>Pay</button>
          <button onClick={() => onPayOff(debt.id, debt.name)} className={`${btnSecondary} !border-success/30 !text-success`}>Pay off</button>
          <button onClick={() => onDelete(debt.id, debt.name)} className="rounded border border-border bg-base px-2 py-1 text-[11px] text-danger">Delete</button>
        </div>
      </div>
    </div>
  );
}

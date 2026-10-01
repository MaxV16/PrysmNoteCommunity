"use client";

import { useState, useCallback, useMemo } from "react";
import { api } from "@/lib/api";
import { monthlyEquivalent } from "@/lib/finance-utils";

export interface FinancialItem {
  id: string;
  name: string;
  direction: string;
  amount: string;
  kind: string;
  start_date: string | null;
  end_date: string | null;
  frequency: string | null;
  next_date: string | null;
  payee?: string | null;
  category?: string | null;
  principal?: string | null;
  remaining_balance?: string | null;
  interest_rate?: string | null;
  paid_off_at?: string | null;
  repeat_count?: number | null;
  frequency_unit?: string | null;
  frequency_interval?: number | null;
}

export interface Transaction {
  id: string;
  date: string;
  amount: string;
  counterparty?: string | null;
  description?: string | null;
  category?: string | null;
  source: string;
  item_id?: string | null;
}

export interface PaymentResult {
  recorded?: boolean;
  paid_off?: boolean;
  remaining_balance?: string | null;
  transaction_id?: string;
  error?: string;
}

export function useFinance() {
  const [items, setItems] = useState<FinancialItem[]>([]);
  const [transactions, setTransactions] = useState<Transaction[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const fetchItems = useCallback(async () => {
    try {
      const data = await api.get<FinancialItem[]>("/finance/items");
      setItems(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load items");
    }
  }, []);

  const fetchTransactions = useCallback(async () => {
    try {
      const data = await api.get<Transaction[]>("/finance/transactions");
      setTransactions(data);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load transactions");
    }
  }, []);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    await Promise.allSettled([fetchItems(), fetchTransactions()]);
    setLoading(false);
  }, [fetchItems, fetchTransactions]);

  const createItem = useCallback(async (payload: Record<string, unknown>) => {
    const res = await api.post<{ id: string }>("/finance/items", payload);
    await fetchItems();
    return res;
  }, [fetchItems]);

  const updateItem = useCallback(async (itemId: string, payload: Record<string, unknown>) => {
    const res = await api.patch<FinancialItem>(`/finance/items/${itemId}`, payload);
    await fetchItems();
    return res;
  }, [fetchItems]);

  const deleteItem = useCallback(async (itemId: string) => {
    await api.delete(`/finance/items/${itemId}`);
    await fetchItems();
  }, [fetchItems]);

  const recordPayment = useCallback(async (itemId: string, date: string, amount: number) => {
    const res = await api.post<PaymentResult>(`/finance/items/${itemId}/pay`, {
      date,
      amount,
    });
    await refresh();
    return res;
  }, [refresh]);

  const payOff = useCallback(async (itemId: string, date: string) => {
    const res = await api.post<PaymentResult>(`/finance/items/${itemId}/pay-off`, {
      date,
    });
    await refresh();
    return res;
  }, [refresh]);

  const reverseTransaction = useCallback(async (transactionId: string) => {
    const res = await api.delete<{ reversed?: boolean; remaining_balance?: string | null }>(
      `/finance/transactions/${transactionId}`
    );
    await refresh();
    return res;
  }, [refresh]);

  const debts = useMemo(
    () => items.filter((i) => i.principal !== null && i.principal !== undefined && !i.paid_off_at),
    [items]
  );

  const summary = useMemo(() => {
    const income = items
      .filter((i) => i.direction === "income")
      .reduce((s, i) => s + parseFloat(i.amount || "0"), 0);
    const expense = items
      .filter((i) => i.direction === "expense")
      .reduce((s, i) => s + parseFloat(i.amount || "0"), 0);
    const totalDebt = debts.reduce((s, d) => s + parseFloat(d.remaining_balance || d.principal || "0"), 0);
    const totalPrincipal = debts.reduce((s, d) => s + parseFloat(d.principal || "0"), 0);
    const incomeCount = items.filter((i) => i.direction === "income").length;
    const expenseCount = items.filter((i) => i.direction === "expense").length;
    // Normalised to an average month so a weekly bill and a yearly one can be
    // compared on the same axis. One-off items contribute 0 here.
    const monthlyIncome = items
      .filter((i) => i.direction === "income")
      .reduce((s, i) => s + monthlyEquivalent(i), 0);
    const monthlyExpense = items
      .filter((i) => i.direction !== "income")
      .reduce((s, i) => s + monthlyEquivalent(i), 0);
    const monthlyDebt = debts.reduce((s, d) => s + monthlyEquivalent(d), 0);
    const savingsRate = monthlyIncome > 0 ? (monthlyIncome - monthlyExpense) / monthlyIncome : 0;
    return {
      income,
      expense,
      net: income - expense,
      totalDebt,
      totalPrincipal,
      debtPaid: Math.max(0, totalPrincipal - totalDebt),
      debtCount: debts.length,
      incomeCount,
      expenseCount,
      itemCount: items.length,
      monthlyIncome,
      monthlyExpense,
      monthlyDebt,
      savingsRate,
    };
  }, [items, debts]);

  return {
    items,
    debts,
    transactions,
    summary,
    loading,
    error,
    refresh,
    fetchItems,
    createItem,
    updateItem,
    deleteItem,
    recordPayment,
    payOff,
    reverseTransaction,
  };
}

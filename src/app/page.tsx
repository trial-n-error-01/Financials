"use client";

import { startTransition, useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { addDoc, collection, deleteDoc, doc, enableNetwork, getDocs, onSnapshot, query, setDoc, updateDoc, where, writeBatch } from "firebase/firestore";
import { onAuthStateChanged, type User } from "firebase/auth";
import Papa from "papaparse";
import { auth, db, firebaseConfigured } from "@/lib/firebase";

type Transaction = {
  id: string;
  userId: string;
  date: string;
  merchant: string;
  category: string;
  paymentMethod: string;
  amountCents: number;
  notes: string;
};

type MonthlyPlan = {
  id: string;
  userId: string;
  month: string;
  salaryCents: number;
  budgetCents: number;
};

type YearlyExpenseEntry = {
  id: string;
  name: string;
  amountCents: number;
};

type ImportRow = Omit<Transaction, "id" | "userId">;
type SortKey = "date" | "merchant" | "category" | "paymentMethod" | "amountCents";

const paymentMethods = ["Bank card", "Cash", "Direct debit", "Bank transfer"];
const demoTransactions: Transaction[] = [
  { id: "demo-1", userId: "demo", date: "2026-09-21", merchant: "Grocer & Co", category: "Food", paymentMethod: "Bank card", amountCents: 6840, notes: "Weekly shop" },
  { id: "demo-2", userId: "demo", date: "2026-09-18", merchant: "City Rail", category: "Transport", paymentMethod: "Bank card", amountCents: 2450, notes: "Monthly pass" },
  { id: "demo-3", userId: "demo", date: "2026-09-09", merchant: "Northlight Energy", category: "Bills", paymentMethod: "Direct debit", amountCents: 9210, notes: "Electricity" },
  { id: "demo-4", userId: "demo", date: "2026-09-03", merchant: "Corner Books", category: "Fun", paymentMethod: "Bank card", amountCents: 1890, notes: "" },
];

const money = new Intl.NumberFormat("en-HK", { style: "currency", currency: "HKD" });
const chartMoney = new Intl.NumberFormat("en-HK", { style: "currency", currency: "HKD", maximumFractionDigits: 0 });
const formatMoney = (hkdCents: number) => money.format(hkdCents / 100);
const formatChartMoney = (hkdCents: number) => chartMoney.format(hkdCents / 100);
const monthLabel = (key: string) => key === "all" ? "All months" : new Intl.DateTimeFormat("en-GB", { month: "long", year: "numeric" }).format(new Date(`${key}-01T12:00:00`));
const monthNames = Array.from({ length: 12 }, (_, index) => new Intl.DateTimeFormat("en-GB", { month: "long" }).format(new Date(2026, index, 1)).toLowerCase());
const categoryChartColors = ["#bf5b3f", "#4f8271", "#d39b45", "#6478a6", "#9a6586", "#71833c", "#478a9e", "#ce7757"];

function parseYearlyExpenseCache(value: string): Record<string, YearlyExpenseEntry[]> {
  const cached = JSON.parse(value) as Record<string, unknown>;
  const expenses: Record<string, YearlyExpenseEntry[]> = {};
  Object.entries(cached).forEach(([year, entries]) => {
    if (Array.isArray(entries)) {
      expenses[year] = entries as YearlyExpenseEntry[];
    } else if (typeof entries === "number") {
      expenses[year] = [{ id: `legacy-${year}`, name: "Existing yearly expense", amountCents: entries }];
    }
  });
  return expenses;
}

function Stat({ label, value, detail }: { label: string; value: string; detail: string }) {
  return <div className="min-w-0 border-l-2 border-[#bf5b3f] pl-4"><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">{label}</p><p className="mt-2 break-words text-2xl font-semibold tracking-tight sm:text-3xl">{value}</p><p className="mt-1 text-sm text-[#65715e]">{detail}</p></div>;
}

function EmptyState({ onAdd }: { onAdd: () => void }) {
  return <div className="border border-dashed border-[#20251f]/20 px-6 py-12 text-center"><p className="text-lg font-semibold">No expenses for this month</p><p className="mt-2 text-sm text-[#65715e]">Start with one transaction and your patterns will appear here.</p><button className="mt-5 bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7]" onClick={onAdd}>Add an expense</button></div>;
}

export default function Home() {
  const pathname = usePathname();
  const router = useRouter();
  const pathSegments = pathname.split("/").filter(Boolean);
  const routeYear = /^\d{4}$/.test(pathSegments[0] ?? "") ? pathSegments[0] : "";
  const routeMonthIndex = monthNames.indexOf((pathSegments[1] ?? "").toLowerCase());
  const isYearlyExpenseRoute = pathSegments[1] === "taxes-and-others";
  const isOverallView = pathname === "/overall" || pathname === "/";
  const isMonthView = Boolean(routeYear && routeMonthIndex >= 0);
  const selectedMonth = isYearlyExpenseRoute
    ? "yearly-expenses"
    : routeYear && routeMonthIndex >= 0
      ? `${routeYear}-${String(routeMonthIndex + 1).padStart(2, "0")}`
      : "all";
  const [user, setUser] = useState<User | null>(null);
  const [transactions, setTransactions] = useState<Transaction[]>(firebaseConfigured ? [] : demoTransactions);
  const [monthlyPlans, setMonthlyPlans] = useState<MonthlyPlan[]>([]);
  const [yearlyExpenses, setYearlyExpenses] = useState<Record<string, YearlyExpenseEntry[]>>({});
  const [yearlyExpenseName, setYearlyExpenseName] = useState("");
  const [yearlyExpenseAmount, setYearlyExpenseAmount] = useState("");
  const [yearlyExpenseError, setYearlyExpenseError] = useState("");
  const [yearlyExpenseMessage, setYearlyExpenseMessage] = useState("");
  const [savingYearlyExpense, setSavingYearlyExpense] = useState(false);
  const [removingYearlyExpense, setRemovingYearlyExpense] = useState("");
  const [planDrafts, setPlanDrafts] = useState<Record<string, { salary: string; budget: string }>>({});
  const [planLoadError, setPlanLoadError] = useState("");
  const [planSaveError, setPlanSaveError] = useState("");
  const [planSaveMessage, setPlanSaveMessage] = useState("");
  const [savingPlan, setSavingPlan] = useState(false);
  const [showExpenseHistory, setShowExpenseHistory] = useState(false);
  const [searchTerm, setSearchTerm] = useState("");
  const [filterCategory, setFilterCategory] = useState("");
  const [filterPaymentMethod, setFilterPaymentMethod] = useState("");
  const [showForm, setShowForm] = useState(false);
  const [editingTransaction, setEditingTransaction] = useState<Transaction | null>(null);
  const [showImport, setShowImport] = useState(false);
  const [showCategories, setShowCategories] = useState(false);
  const [userCategories, setUserCategories] = useState<string[]>([]);
  const [categoryName, setCategoryName] = useState("");
  const [categoryError, setCategoryError] = useState("");
  const [deletingCategory, setDeletingCategory] = useState("");
  const [categoryLoadError, setCategoryLoadError] = useState("");
  const [transactionLoadError, setTransactionLoadError] = useState("");
  const [deleteError, setDeleteError] = useState("");
  const [deletingId, setDeletingId] = useState("");
  const [sortKey, setSortKey] = useState<SortKey>("date");
  const [sortDirection, setSortDirection] = useState<"asc" | "desc">("desc");

  useEffect(() => {
    if (pathname === "/") {
      router.replace("/overall");
      return;
    }
    if (pathname === "/overall") return;
    if (!routeYear) {
      router.replace("/overall");
      return;
    }
    if (pathSegments.length > 1 && routeMonthIndex === -1 && !isYearlyExpenseRoute) {
      router.replace(`/${routeYear}`);
    }
  }, [pathname, pathSegments.length, routeMonthIndex, routeYear, isYearlyExpenseRoute, router]);

  useEffect(() => {
    if (!auth) return;
    return onAuthStateChanged(auth, setUser);
  }, []);

  useEffect(() => {
    if (!db || !user) return;
    const cacheKey = `financials:transactions:${user.uid}`;
    const cachedTransactions = window.localStorage.getItem(cacheKey);
    if (cachedTransactions) {
      try {
        const savedTransactions = JSON.parse(cachedTransactions) as Transaction[];
        startTransition(() => setTransactions(savedTransactions));
      } catch {
        window.localStorage.removeItem(cacheKey);
      }
    }
    const transactionQuery = query(collection(db, "transactions"), where("userId", "==", user.uid));
    return onSnapshot(transactionQuery, { includeMetadataChanges: true }, (snapshot) => {
      const savedTransactions = snapshot.docs.map((item) => ({ id: item.id, ...item.data() } as Transaction));
      setTransactions((current) => {
        if (savedTransactions.length === 0 && current.length > 0 && snapshot.metadata.fromCache) {
          return current;
        }
        window.localStorage.setItem(cacheKey, JSON.stringify(savedTransactions));
        return savedTransactions;
      });
      setTransactionLoadError("");
    }, (error) => {
      setTransactionLoadError(`Could not load transactions: ${error.message}`);
    });
  }, [user]);

  useEffect(() => {
    const cacheKey = `financials:monthly-plans:${user?.uid ?? "demo"}`;
    if (!db || !user) {
      if (firebaseConfigured) return;
      const cachedPlans = window.localStorage.getItem(cacheKey);
      if (cachedPlans) {
        try {
          startTransition(() => setMonthlyPlans(JSON.parse(cachedPlans) as MonthlyPlan[]));
        } catch {
          window.localStorage.removeItem(cacheKey);
        }
      }
      return;
    }

    const cachedPlans = window.localStorage.getItem(cacheKey);
    if (cachedPlans) {
      try {
        startTransition(() => setMonthlyPlans(JSON.parse(cachedPlans) as MonthlyPlan[]));
      } catch {
        window.localStorage.removeItem(cacheKey);
      }
    }
    const plansQuery = query(collection(db, "monthlyBudgets"), where("userId", "==", user.uid));
    return onSnapshot(plansQuery, { includeMetadataChanges: true }, (snapshot) => {
      const plans = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }) as MonthlyPlan);
      setMonthlyPlans((current) => {
        if (plans.length === 0 && current.length > 0 && snapshot.metadata.fromCache) {
          return current;
        }
        window.localStorage.setItem(cacheKey, JSON.stringify(plans));
        return plans;
      });
      setPlanLoadError("");
    }, (error) => {
      setPlanLoadError(`Could not load monthly budgets: ${error.message}`);
    });
  }, [user]);

  useEffect(() => {
    const cacheKey = `financials:yearly-expenses:${user?.uid ?? "demo"}`;
    if (!db || !user) {
      if (firebaseConfigured) return;
      const cachedExpenses = window.localStorage.getItem(cacheKey);
      if (cachedExpenses) {
        try {
          startTransition(() => setYearlyExpenses(parseYearlyExpenseCache(cachedExpenses)));
        } catch {
          window.localStorage.removeItem(cacheKey);
        }
      }
      return;
    }

    const cachedExpenses = window.localStorage.getItem(cacheKey);
    if (cachedExpenses) {
      try {
        startTransition(() => setYearlyExpenses(parseYearlyExpenseCache(cachedExpenses)));
      } catch {
        window.localStorage.removeItem(cacheKey);
      }
    }
    const expensesQuery = query(collection(db, "yearlyExpenses"), where("userId", "==", user.uid));
    return onSnapshot(expensesQuery, (snapshot) => {
      const expenses: Record<string, YearlyExpenseEntry[]> = {};
      snapshot.docs.forEach((item) => {
        const expense = item.data();
        const year = String(expense.year);
        expenses[year] = Array.isArray(expense.expenses)
          ? expense.expenses as YearlyExpenseEntry[]
          : typeof expense.amountCents === "number"
            ? [{ id: "legacy", name: "Existing yearly expense", amountCents: expense.amountCents }]
            : [];
      });
      setYearlyExpenses(expenses);
      window.localStorage.setItem(cacheKey, JSON.stringify(expenses));
      setYearlyExpenseError("");
    }, (error) => {
      setYearlyExpenseError(`Could not load yearly expenses: ${error.message}`);
    });
  }, [user]);

  useEffect(() => {
    if (!db || !user) return;
    const cacheKey = `financials:categories:${user.uid}`;
    const cachedCategories = window.localStorage.getItem(cacheKey);
    if (cachedCategories) {
      try {
        const names = JSON.parse(cachedCategories) as string[];
        startTransition(() => setUserCategories(names));
      } catch {
        window.localStorage.removeItem(cacheKey);
      }
    }
    const categoryQuery = query(collection(db, "categories"), where("userId", "==", user.uid));
    return onSnapshot(categoryQuery, (snapshot) => {
      const names = snapshot.docs.map((item) => item.data().name as string);
      setUserCategories(names);
      window.localStorage.setItem(cacheKey, JSON.stringify(names));
      setCategoryLoadError("");
    }, (error) => {
      setCategoryLoadError(`Could not load categories: ${error.message}`);
    });
  }, [user]);

  const categories = useMemo(() => [...new Set(userCategories)].sort(), [userCategories]);

  const currentYear = routeYear ? Number(routeYear) : new Date().getFullYear();
  const currentYearExpenseEntries = yearlyExpenses[String(currentYear)] ?? [];
  const yearlyExpenseTotal = currentYearExpenseEntries.reduce((total, expense) => total + expense.amountCents, 0);
  const yearMonths = useMemo(() => Array.from({ length: 12 }, (_, index) => {
    const key = `${currentYear}-${String(index + 1).padStart(2, "0")}`;
    const monthlyTransactions = transactions.filter((transaction) => transaction.date.startsWith(key));
    const plan = monthlyPlans.find((item) => item.month === key);
    const total = monthlyTransactions.reduce((sum, transaction) => sum + transaction.amountCents, 0);
    const budgetCents = plan?.budgetCents ?? 0;
    const salaryCents = plan?.salaryCents ?? 0;
    const date = new Date(currentYear, index, 1);
    return {
      key,
      label: new Intl.DateTimeFormat("en-GB", { month: "long" }).format(date),
      shortLabel: new Intl.DateTimeFormat("en-GB", { month: "short" }).format(date),
      total,
      count: monthlyTransactions.length,
      budgetCents,
      budgetVarianceCents: budgetCents > 0 ? budgetCents - total : null,
      salaryCents,
      overBudgetCents: budgetCents > 0 ? Math.max(total - budgetCents, 0) : 0,
      savingsCents: salaryCents > 0 ? salaryCents - total : 0,
    };
  }), [currentYear, monthlyPlans, transactions]);
  const yearTransactions = transactions.filter((transaction) => transaction.date.startsWith(`${currentYear}-`));
  const selectedMonthPlan = yearMonths.find((item) => item.key === selectedMonth);
  const isYearlyExpenseView = selectedMonth === "yearly-expenses";
  const selectedDraft = planDrafts[selectedMonth] ?? {
    salary: selectedMonthPlan?.salaryCents ? String(selectedMonthPlan.salaryCents / 100) : "",
    budget: selectedMonthPlan?.budgetCents ? String(selectedMonthPlan.budgetCents / 100) : "",
  };
  const monthTransactions = useMemo(() => isYearlyExpenseView ? [] : transactions.filter((transaction) => selectedMonth === "all"
    ? transaction.date.startsWith(`${currentYear}-`)
    : transaction.date.startsWith(selectedMonth)), [currentYear, isYearlyExpenseView, selectedMonth, transactions]);
  const monthCategoryExpenses = useMemo(() => {
    const categoryTotals = new Map<string, number>();
    monthTransactions.forEach((transaction) => {
      const category = transaction.category.trim() || "Uncategorized";
      categoryTotals.set(category, (categoryTotals.get(category) ?? 0) + transaction.amountCents);
    });
    return [...categoryTotals.entries()]
      .map(([name, amountCents]) => ({ name, amountCents }))
      .sort((left, right) => right.amountCents - left.amountCents)
      .map((category, index) => ({ ...category, color: categoryChartColors[index % categoryChartColors.length] }));
  }, [monthTransactions]);
  const monthCategoryTotal = monthCategoryExpenses.reduce((total, category) => total + category.amountCents, 0);
  const pieChartSlices = monthCategoryExpenses.reduce((chart, category) => {
    const end = chart.offset + (monthCategoryTotal ? category.amountCents / monthCategoryTotal * 100 : 0);
    return {
      offset: end,
      slices: [...chart.slices, `${category.color} ${chart.offset}% ${end}%`],
    };
  }, { offset: 0, slices: [] as string[] }).slices;
  const pieChartBackground = pieChartSlices.length
    ? `conic-gradient(${pieChartSlices.join(", ")})`
    : "#e6e3db";
  const filteredTransactions = useMemo(() => monthTransactions.filter((transaction) => {
    const normalizedSearch = searchTerm.trim().toLowerCase();
    const matchesSearch = !normalizedSearch || [transaction.merchant, transaction.category, transaction.paymentMethod, transaction.notes].some((value) => value.toLowerCase().includes(normalizedSearch));
    const matchesCategory = !filterCategory || transaction.category === filterCategory;
    const matchesPaymentMethod = !filterPaymentMethod || transaction.paymentMethod === filterPaymentMethod;
    return matchesSearch && matchesCategory && matchesPaymentMethod;
  }), [filterCategory, filterPaymentMethod, monthTransactions, searchTerm]);
  const sortedFilteredTransactions = useMemo(() => [...filteredTransactions].sort((left, right) => {
    const leftValue = left[sortKey];
    const rightValue = right[sortKey];
    const comparison = typeof leftValue === "number" && typeof rightValue === "number" ? leftValue - rightValue : String(leftValue).localeCompare(String(rightValue));
    return sortDirection === "asc" ? comparison : -comparison;
  }), [filteredTransactions, sortDirection, sortKey]);
  const monthTotal = monthTransactions.reduce((total, transaction) => total + transaction.amountCents, 0);
  const yearTotal = yearTransactions.reduce((total, transaction) => total + transaction.amountCents, 0);
  const yearBudget = yearMonths.reduce((total, item) => total + item.budgetCents, 0);
  const yearSalary = yearMonths.reduce((total, item) => total + item.salaryCents, 0);
  const yearOverBudget = yearMonths.reduce((total, item) => total + item.overBudgetCents, 0);
  const yearSavings = yearSalary - yearTotal - yearlyExpenseTotal;
  const salarySavingsMax = Math.max(1, ...yearMonths.map((item) => item.salaryCents), ...yearMonths.map((item) => item.savingsCents));
  const salarySavingsMin = Math.min(0, ...yearMonths.map((item) => item.savingsCents));
  const salarySavingsRange = salarySavingsMax - salarySavingsMin || 1;
  const yearChartX = (index: number) => 82 + index / (yearMonths.length - 1) * 622;
  const yearChartY = (value: number) => 18 + (salarySavingsMax - value) / salarySavingsRange * 188;
  const salaryLinePath = yearMonths.map((item, index) => `${index === 0 ? "M" : "L"} ${yearChartX(index)} ${yearChartY(item.salaryCents)}`).join(" ");
  const savingsLinePath = yearMonths.map((item, index) => `${index === 0 ? "M" : "L"} ${yearChartX(index)} ${yearChartY(item.savingsCents)}`).join(" ");
  const salarySavingsTicks = Array.from({ length: 5 }, (_, index) => salarySavingsMax - salarySavingsRange * index / 4);
  const budgetVarianceMax = Math.max(1, ...yearMonths.map((item) => Math.abs(item.budgetVarianceCents ?? 0)));
  const monthBudgetVariance = selectedMonthPlan && selectedMonthPlan.budgetCents > 0
    ? selectedMonthPlan.budgetCents - monthTotal
    : null;
  const maxYearValue = Math.max(...yearMonths.flatMap((item) => [item.total, item.budgetCents, Math.abs(item.savingsCents)]), 1);
  const saveMonthlyPlan = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (selectedMonth === "all") return;
    const salary = Number(selectedDraft.salary);
    const budget = Number(selectedDraft.budget);
    if (!selectedDraft.salary.trim() || !selectedDraft.budget.trim() || !Number.isFinite(salary) || !Number.isFinite(budget) || salary < 0 || budget < 0) {
      setPlanSaveError("Enter a valid non-negative salary and budget.");
      setPlanSaveMessage("");
      return;
    }

    const plan: MonthlyPlan = {
      id: `${user?.uid ?? "demo"}_${selectedMonth}`,
      userId: user?.uid ?? "demo",
      month: selectedMonth,
      salaryCents: Math.round(salary * 100),
      budgetCents: Math.round(budget * 100),
    };
    const nextPlans = [...monthlyPlans.filter((item) => item.month !== selectedMonth), plan];
    const cacheKey = `financials:monthly-plans:${user?.uid ?? "demo"}`;
    setSavingPlan(true);
    setPlanSaveError("");
    setPlanSaveMessage("");
    setMonthlyPlans(nextPlans);
    window.localStorage.setItem(cacheKey, JSON.stringify(nextPlans));
    try {
      if (db && user) {
        await setDoc(doc(db, "monthlyBudgets", plan.id), { ...plan, updatedAt: new Date().toISOString() });
      }
      setPlanSaveMessage("Monthly plan saved.");
    } catch (error) {
      setPlanSaveError(error instanceof Error ? error.message : "Could not save this monthly plan.");
    } finally {
      setSavingPlan(false);
    }
  };

  const saveYearlyExpenseEntries = async (expenses: YearlyExpenseEntry[]) => {
    if (firebaseConfigured && (!db || !user)) {
      throw new Error("Sign in before saving yearly expenses.");
    }

    if (db && user) {
      await setDoc(doc(db, "yearlyExpenses", `${user.uid}_${currentYear}`), {
        userId: user.uid,
        year: currentYear,
        expenses,
        updatedAt: new Date().toISOString(),
      });
    }

    const nextExpenses = { ...yearlyExpenses, [String(currentYear)]: expenses };
    const cacheKey = `financials:yearly-expenses:${user?.uid ?? "demo"}`;
    setYearlyExpenses(nextExpenses);
    window.localStorage.setItem(cacheKey, JSON.stringify(nextExpenses));
  };

  const saveYearlyExpense = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = yearlyExpenseName.trim();
    const amount = Number(yearlyExpenseAmount);
    if (!name || !yearlyExpenseAmount.trim() || !Number.isFinite(amount) || amount < 0) {
      setYearlyExpenseError("Enter an expense name and a valid non-negative amount.");
      setYearlyExpenseMessage("");
      return;
    }

    setSavingYearlyExpense(true);
    setYearlyExpenseError("");
    setYearlyExpenseMessage("");
    try {
      await saveYearlyExpenseEntries([...currentYearExpenseEntries, {
        id: crypto.randomUUID(),
        name,
        amountCents: Math.round(amount * 100),
      }]);
      setYearlyExpenseName("");
      setYearlyExpenseAmount("");
      setYearlyExpenseMessage("Expense added.");
    } catch (error) {
      setYearlyExpenseError(error instanceof Error ? error.message : "Could not save yearly expenses.");
    } finally {
      setSavingYearlyExpense(false);
    }
  };

  const removeYearlyExpense = async (id: string) => {
    setRemovingYearlyExpense(id);
    setYearlyExpenseError("");
    setYearlyExpenseMessage("");
    try {
      await saveYearlyExpenseEntries(currentYearExpenseEntries.filter((expense) => expense.id !== id));
      setYearlyExpenseMessage("Expense removed.");
    } catch (error) {
      setYearlyExpenseError(error instanceof Error ? error.message : "Could not remove this expense.");
    } finally {
      setRemovingYearlyExpense("");
    }
  };

  const removeTransaction = async (id: string) => {
    if (!db || !id || id.startsWith("demo-")) return;
    setDeletingId(id);
    setDeleteError("");
    const transactionToRemove = transactions.find((transaction) => transaction.id === id);
    if (!transactionToRemove) {
      setDeletingId("");
      return;
    }
    const remainingTransactions = transactions.filter((transaction) => transaction.id !== id);
    setTransactions(remainingTransactions);
    if (user) {
      window.localStorage.setItem(`financials:transactions:${user.uid}`, JSON.stringify(remainingTransactions));
    }
    try {
      const transactionRef = doc(db, "transactions", id);
      await enableNetwork(db);
      const deleteRequest = deleteDoc(transactionRef);
      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Firebase could not remove this transaction. Check your internet connection and publish firestore.rules to your Firebase project.")), 10000);
      });
      await Promise.race([deleteRequest, timeout]);
    } catch (error) {
      setTransactions((current) => {
        const restored = current.some((transaction) => transaction.id === id)
          ? current
          : [...current, transactionToRemove];
        if (user) {
          window.localStorage.setItem(`financials:transactions:${user.uid}`, JSON.stringify(restored));
        }
        return restored;
      });
      setDeleteError(error instanceof Error ? error.message : "Could not remove this transaction.");
    } finally {
      setDeletingId("");
    }
  };

  const addCategory = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const name = categoryName.trim();
    if (!name) return;
    if (!db || !user) {
      setCategoryError("Connect Firebase and sign in before adding categories.");
      return;
    }
    if (categories.some((category) => category.toLowerCase() === name.toLowerCase())) {
      setCategoryError("That category already exists.");
      return;
    }
    await addDoc(collection(db, "categories"), { userId: user.uid, name, createdAt: new Date().toISOString() });
    setCategoryName("");
    setCategoryError("");
  };

  const removeCategory = async (name: string) => {
    if (!db || !user) return;
    const category = userCategories.find((item) => item === name);
    if (!category) return;
    setDeletingCategory(name);
    setCategoryError("");
    try {
      const categoryQuery = query(collection(db, "categories"), where("userId", "==", user.uid), where("name", "==", name));
      const snapshotRequest = getDocs(categoryQuery);
      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Firebase did not respond while removing this category.")), 10000);
      });
      const snapshot = await Promise.race([snapshotRequest, timeout]);
      await Promise.race([
        Promise.all(snapshot.docs.map((item) => deleteDoc(item.ref))),
        timeout,
      ]);
      setUserCategories((current) => {
        const remaining = current.filter((category) => category !== name);
        window.localStorage.setItem(`financials:categories:${user.uid}`, JSON.stringify(remaining));
        return remaining;
      });
    } catch (error) {
      setCategoryError(error instanceof Error ? error.message : "Could not remove this category.");
    } finally {
      setDeletingCategory("");
    }
  };

  const changeSort = (nextKey: SortKey) => {
    if (sortKey === nextKey) {
      setSortDirection((current) => current === "asc" ? "desc" : "asc");
      return;
    }
    setSortKey(nextKey);
    setSortDirection(nextKey === "date" || nextKey === "amountCents" ? "desc" : "asc");
  };

  const sortIndicator = (key: SortKey) => sortKey === key ? (sortDirection === "asc" ? " ^" : " v") : "";
  const navigateToMonth = (month: string) => {
    if (month === "all") {
      router.push(`/${currentYear}`);
      return;
    }
    if (month === "yearly-expenses") {
      router.push(`/${currentYear}/taxes-and-others`);
      return;
    }
    const match = month.match(/^(\d{4})-(\d{2})$/);
    const index = match ? Number(match[2]) - 1 : -1;
    if (match && index >= 0 && index < 12) router.push(`/${match[1]}/${monthNames[index]}`);
  };

  const expenseHistorySection = (
    <section className={`${isMonthView ? "" : "mt-5"} border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7`}>
      <div className="mb-5 flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">
            Expense history
          </p>
          <h2 className="mt-2 text-2xl font-semibold">{isMonthView ? `${monthLabel(selectedMonth)} expenses` : "All expenses"}</h2>
        </div>
        <span className="text-sm text-[#65715e]">
          {filteredTransactions.length} shown
        </span>
      </div>
      <div className="mb-5 grid gap-3 sm:grid-cols-[1.5fr_1fr_1fr]">
        <label className="sr-only" htmlFor="expense-search">
          Search expenses
        </label>
        <input
          id="expense-search"
          className="border border-[#20251f]/15 bg-transparent px-3 py-2 text-sm"
          placeholder="Search merchant, category, notes..."
          value={searchTerm}
          onChange={(event) => setSearchTerm(event.target.value)}
        />
        <label className="sr-only" htmlFor="category-filter">
          Filter category
        </label>
        <select
          id="category-filter"
          className="border border-[#20251f]/15 bg-[#fbfaf7] px-3 py-2 text-sm"
          value={filterCategory}
          onChange={(event) => setFilterCategory(event.target.value)}
        >
          <option value="">All categories</option>
          {categories.map((category) => (
            <option key={category}>{category}</option>
          ))}
        </select>
        <label className="sr-only" htmlFor="payment-filter">
          Filter payment method
        </label>
        <select
          id="payment-filter"
          className="border border-[#20251f]/15 bg-[#fbfaf7] px-3 py-2 text-sm"
          value={filterPaymentMethod}
          onChange={(event) => setFilterPaymentMethod(event.target.value)}
        >
          <option value="">All payment methods</option>
          {paymentMethods.map((method) => (
            <option key={method}>{method}</option>
          ))}
        </select>
      </div>
      {filteredTransactions.length ? (
        <div className="overflow-x-auto">
          <table className="w-full min-w-[680px] text-left text-sm">
            <thead className="border-b border-[#20251f]/15 text-xs uppercase tracking-[0.12em] text-[#65715e]">
              <tr>
                <th className="pb-3 font-semibold">
                  <button onClick={() => changeSort("date")}>Date{sortIndicator("date")}</button>
                </th>
                <th className="pb-3 font-semibold">
                  <button onClick={() => changeSort("merchant")}>Merchant{sortIndicator("merchant")}</button>
                </th>
                <th className="pb-3 font-semibold">
                  <button onClick={() => changeSort("category")}>Category{sortIndicator("category")}</button>
                </th>
                <th className="pb-3 font-semibold">
                  <button onClick={() => changeSort("paymentMethod")}>Payment{sortIndicator("paymentMethod")}</button>
                </th>
                <th className="pb-3 text-right font-semibold">
                  <button onClick={() => changeSort("amountCents")}>Amount{sortIndicator("amountCents")}</button>
                </th>
                <th />
              </tr>
            </thead>
            <tbody>
              {sortedFilteredTransactions.map((transaction) => (
                <tr className="border-b border-[#20251f]/10 last:border-0" key={transaction.id}>
                  <td className="py-4 text-[#65715e]">{transaction.date}</td>
                  <td className="py-4 font-semibold">{transaction.merchant}</td>
                  <td className="py-4">
                    <span className="border border-[#20251f]/15 px-2 py-1 text-xs">{transaction.category}</span>
                  </td>
                  <td className="py-4 text-[#65715e]">{transaction.paymentMethod}</td>
                  <td className="py-4 text-right font-semibold">{formatMoney(transaction.amountCents)}</td>
                  <td className="py-4 text-right">
                    <button
                      className="mr-3 text-xs text-[#65715e]"
                      onClick={() => {
                        setEditingTransaction(transaction);
                        setShowForm(true);
                      }}
                    >
                      Edit
                    </button>
                    <button
                      className="text-xs text-[#bf5b3f]"
                      onClick={() => void removeTransaction(transaction.id)}
                      disabled={deletingId === transaction.id}
                    >
                      {deletingId === transaction.id ? "Removing" : "Remove"}
                    </button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <EmptyState onAdd={() => setShowForm(true)} />
      )}
    </section>
  );

  if (isOverallView) {
    const availableYears = [...new Set([
      ...transactions.map((transaction) => transaction.date.slice(0, 4)),
      ...monthlyPlans.map((plan) => plan.month.slice(0, 4)),
      ...Object.keys(yearlyExpenses),
      String(new Date().getFullYear()),
    ])].filter((year) => /^\d{4}$/.test(year)).sort((left, right) => Number(right) - Number(left));
    const annualSummaries = availableYears.map((year) => {
      const annualTransactions = transactions.filter((transaction) => transaction.date.startsWith(`${year}-`));
      const annualTotal = annualTransactions.reduce((total, transaction) => total + transaction.amountCents, 0);
      const annualPlans = monthlyPlans.filter((plan) => plan.month.startsWith(`${year}-`));
      const annualBudget = annualPlans.reduce((total, plan) => total + plan.budgetCents, 0);
      const annualSalary = annualPlans.reduce((total, plan) => total + plan.salaryCents, 0);
      const annualExpenseEntries = yearlyExpenses[year] ?? [];
      const annualExtraExpenses = annualExpenseEntries.reduce((total, expense) => total + expense.amountCents, 0);
      const savings = annualSalary > 0 ? annualSalary - annualTotal - annualExtraExpenses : null;
      const budgetVariance = annualBudget > 0 ? annualBudget - annualTotal : null;
      const metrics = [
        { label: "Savings", value: savings, detail: savings === null ? "No salary plan" : "After taxes & other expenses", color: "bg-[#4f8271]" },
        { label: "Budget variance", value: budgetVariance, detail: budgetVariance === null ? "No budget set" : budgetVariance >= 0 ? "Under budget" : "Over budget", color: budgetVariance === null ? "bg-[#65715e]" : budgetVariance >= 0 ? "bg-[#4f8271]" : "bg-[#bf5b3f]" },
        { label: "Taxes & other", value: annualExtraExpenses, detail: `${annualExpenseEntries.length} ${annualExpenseEntries.length === 1 ? "item" : "items"}`, color: "bg-[#bf5b3f]" },
      ];
      return { year, annualTotal, transactionCount: annualTransactions.length, metrics };
    });
    const maxMetricValue = Math.max(1, ...annualSummaries.flatMap(({ metrics }) => metrics.map((metric) => Math.abs(metric.value ?? 0))));

    return (
      <main className="min-h-screen bg-[#f4f1ea] px-5 py-8 text-[#20251f] sm:px-8 lg:px-12">
        <div className="mx-auto max-w-5xl">
          <header className="border-b border-[#20251f]/20 pb-6">
            <Link className="text-xs font-semibold uppercase tracking-[0.2em] text-[#65715e]" href="/overall">Financials</Link>
            <h1 className="mt-3 text-3xl font-semibold">Your years</h1>
          </header>
          <div className="divide-y divide-[#20251f]/20">
            {annualSummaries.map(({ year, annualTotal, transactionCount, metrics }) => (
              <section className="grid gap-5 py-6 sm:grid-cols-[150px_minmax(0,1fr)] sm:gap-8" key={year}>
                <div>
                  <Link className="text-2xl font-semibold hover:text-[#bf5b3f]" href={`/${year}`}>{year}</Link>
                  <p className="mt-1 text-sm text-[#65715e]">{formatMoney(annualTotal)}</p>
                  <p className="text-xs text-[#65715e]">{transactionCount} expenses</p>
                </div>
                <div aria-label={`${year} annual savings, budget variance, and taxes and other expenses`} className="space-y-4" role="group">
                  {metrics.map((metric) => (
                    <div className="grid gap-2 sm:grid-cols-[minmax(120px,0.8fr)_minmax(120px,2fr)_minmax(140px,auto)] sm:items-center sm:gap-4" key={metric.label}>
                      <p className="text-sm font-semibold">{metric.label}</p>
                      <div aria-hidden="true" className="relative h-3 bg-[#20251f]/5">
                        <span className="absolute inset-y-0 left-1/2 w-px bg-[#20251f]/35" />
                        {metric.value !== null && metric.value !== 0 && (
                          <span
                            className={`absolute top-0.5 h-2 ${metric.color}`}
                            style={{
                              left: metric.value > 0 ? "50%" : undefined,
                              right: metric.value < 0 ? "50%" : undefined,
                              width: `${Math.min(Math.abs(metric.value) / maxMetricValue * 50, 50)}%`,
                            }}
                          />
                        )}
                      </div>
                      <div className="flex items-baseline justify-between gap-3 text-sm sm:block sm:text-right">
                        <span className="font-semibold tabular-nums">{metric.value === null ? "Not set" : formatMoney(metric.value)}</span>
                        <span className="text-xs text-[#65715e] sm:ml-2">{metric.detail}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      </main>
    );
  }

  return (
    <main className="min-h-screen bg-[#f4f1ea] px-5 py-6 text-[#20251f] sm:px-8 lg:px-12">
      <div className="mx-auto max-w-[1440px]">
        <div className="grid grid-cols-1 gap-8 lg:grid-cols-[230px_minmax(0,1fr)]">
          <aside className="border-b border-[#20251f]/15 pb-5 lg:sticky lg:top-6 lg:h-[calc(100vh-3rem)] lg:self-start lg:overflow-y-auto lg:border-b-0 lg:border-r lg:pb-0 lg:pr-6">
            <div className="mb-4 flex items-baseline justify-between">
              <h2 className="text-lg font-semibold">{currentYear}</h2>
              <button
                className={`text-xs font-semibold uppercase tracking-[0.12em] ${selectedMonth === "all" ? "text-[#bf5b3f]" : "text-[#65715e]"}`}
                onClick={() => navigateToMonth("all")}
              >
                Year
              </button>
            </div>
            <nav aria-label={`${currentYear} budget periods`} className="flex gap-2 overflow-x-auto pb-2 lg:flex-col lg:gap-1 lg:overflow-visible lg:pb-0">
              {yearMonths.map((month) => (
                <button
                  key={month.key}
                  aria-current={selectedMonth === month.key ? "date" : undefined}
                  className={`min-w-[132px] border px-3 py-2 text-left transition-colors lg:min-w-0 ${selectedMonth === month.key ? "border-[#20251f] bg-[#20251f] text-[#fbfaf7]" : "border-transparent hover:border-[#20251f]/15 hover:bg-[#fbfaf7]"}`}
                  onClick={() => navigateToMonth(month.key)}
                >
                  <span className="flex items-center justify-between gap-3 text-sm font-semibold">
                    {month.label}
                    <span className={`text-xs font-normal ${selectedMonth === month.key ? "text-[#fbfaf7]/70" : "text-[#65715e]"}`}>
                      {formatMoney(month.total)}
                    </span>
                  </span>
                </button>
              ))}
              {!isMonthView && (
                <button
                  aria-current={isYearlyExpenseView ? "true" : undefined}
                  className={`min-w-[132px] border px-3 py-2 text-left transition-colors lg:min-w-0 ${isYearlyExpenseView ? "border-[#20251f] bg-[#20251f] text-[#fbfaf7]" : "border-transparent hover:border-[#20251f]/15 hover:bg-[#fbfaf7]"}`}
                  onClick={() => navigateToMonth("yearly-expenses")}
                >
                  <span className="flex items-center justify-between gap-3 text-sm font-semibold">
                    <span>Taxes and Others</span>
                    <span className={`text-xs font-normal ${isYearlyExpenseView ? "text-[#fbfaf7]/70" : "text-[#65715e]"}`}>
                      {formatMoney(yearlyExpenseTotal)}
                    </span>
                  </span>
                </button>
              )}
            </nav>
          </aside>
          <div className="min-w-0">
            <header className="flex flex-wrap items-end justify-between gap-5 border-b border-[#20251f]/15 pb-6">
              <div>
                <Link href="/overall" className="text-xs font-semibold uppercase tracking-[0.28em] text-[#65715e] hover:text-[#bf5b3f]">
                  Financials
                </Link>
                <h1 className="mt-2 text-3xl font-semibold tracking-tight">
                  {isMonthView ? monthLabel(selectedMonth) : isYearlyExpenseView ? "Taxes and Others" : "Budget & savings"}
                </h1>
              </div>
              <div className="flex flex-wrap items-center gap-3">
                {!isMonthView && (
                  <button
                    className="border border-[#20251f]/20 px-4 py-2 text-sm font-semibold"
                    onClick={() => setShowExpenseHistory((shown) => !shown)}
                  >
                    {showExpenseHistory ? "Hide expense history" : "Expense history"}
                  </button>
                )}
                <button
                  className="border border-[#20251f]/20 px-4 py-2 text-sm font-semibold"
                  onClick={() => setShowCategories(true)}
                >
                  Manage categories
                </button>
                <button
                  className="border border-[#20251f]/20 px-4 py-2 text-sm font-semibold"
                  onClick={() => setShowImport(true)}
                >
                  Import file
                </button>
                <button
                  className="bg-[#20251f] px-4 py-2 text-sm font-semibold text-[#fbfaf7]"
                  onClick={() => setShowForm(true)}
                >
                  + Add expense
                </button>
              </div>
            </header>
            <div className={`grid gap-5 py-7 sm:grid-cols-2 ${isMonthView ? "2xl:grid-cols-2" : "2xl:grid-cols-4"}`}>
              {isMonthView ? (
                <>
                  <Stat label="Expenses this month" value={formatMoney(monthTotal)} detail={`${monthTransactions.length} transactions`} />
                  <Stat
                    label="Budget variance"
                    value={monthBudgetVariance === null ? "Not set" : formatMoney(monthBudgetVariance)}
                    detail={monthBudgetVariance === null ? "Set a monthly budget to compare" : monthBudgetVariance < 0 ? "Over budget" : monthBudgetVariance > 0 ? "Under budget" : "On budget"}
                  />
                </>
              ) : (
                <>
                  <Stat
                    label="Expenses this year"
                    value={formatMoney(yearTotal)}
                    detail={`${yearTransactions.length} transactions this year`}
                  />
                  <Stat
                    label="Over budget"
                    value={yearBudget > 0 ? formatMoney(yearOverBudget) : "-"}
                    detail={yearBudget > 0 ? `Across ${currentYear}` : "Set monthly budgets to compare"}
                  />
                  <Stat
                    label="Savings"
                    value={yearSalary > 0 ? formatMoney(yearSavings) : "-"}
                    detail={yearSalary > 0 ? `After ${formatMoney(yearTotal)} expenses and ${formatMoney(yearlyExpenseTotal)} taxes/other expenses` : "Set monthly salaries to track"}
                  />
                  <Stat
                    label={isYearlyExpenseView ? "Taxes and Others" : "Year expenses"}
                    value={formatMoney(isYearlyExpenseView ? yearlyExpenseTotal : monthTotal)}
                    detail={isYearlyExpenseView ? `${currentYear} annual expenses` : `${monthTransactions.length} transactions`}
                  />
                </>
              )}
            </div>
            {selectedMonth === "all" && (
              <section aria-label={`${currentYear} salary and savings charts`} className="mb-5 grid grid-cols-1 gap-5 xl:grid-cols-2">
                <div className="min-w-0 border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">Monthly movement</p>
                  <h2 className="mt-2 text-2xl font-semibold">Salary &amp; savings</h2>
                  <svg className="mt-5 block h-auto w-full max-w-full" width="720" height="270" viewBox="0 0 720 270" role="img" aria-labelledby="salary-savings-chart-title salary-savings-chart-description">
                    <title id="salary-savings-chart-title">Monthly salary and savings for {currentYear}</title>
                    <desc id="salary-savings-chart-description">Salary and savings after recorded monthly expenses, shown from January through December.</desc>
                    {salarySavingsTicks.map((tick, index) => {
                      const y = yearChartY(tick);
                      return (
                        <g key={index}>
                          <line x1="82" x2="704" y1={y} y2={y} stroke="#20251f" strokeOpacity="0.12" />
                          <text x="74" y={y + 4} textAnchor="end" fill="#65715e" fontSize="10">{formatChartMoney(tick)}</text>
                        </g>
                      );
                    })}
                    <path d={salaryLinePath} fill="none" stroke="#bf5b3f" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    <path d={savingsLinePath} fill="none" stroke="#4f8271" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" />
                    {yearMonths.map((item, index) => (
                      <g key={item.key}>
                        <circle cx={yearChartX(index)} cy={yearChartY(item.salaryCents)} r="4" fill="#bf5b3f">
                          <title>{`${item.label} salary: ${formatMoney(item.salaryCents)}`}</title>
                        </circle>
                        <circle cx={yearChartX(index)} cy={yearChartY(item.savingsCents)} r="4" fill="#4f8271">
                          <title>{`${item.label} savings: ${formatMoney(item.savingsCents)}`}</title>
                        </circle>
                        <text x={yearChartX(index)} y="238" textAnchor="middle" fill="#65715e" fontSize="11">{item.shortLabel}</text>
                      </g>
                    ))}
                  </svg>
                  <div className="mt-1 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#65715e]">
                    <span><span className="mr-2 inline-block size-2 rounded-full bg-[#bf5b3f]" />Salary</span>
                    <span><span className="mr-2 inline-block size-2 rounded-full bg-[#4f8271]" />Savings after monthly expenses</span>
                  </div>
                </div>
                <div className="min-w-0 border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7">
                  <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">Budget variance</p>
                  <h2 className="mt-2 text-2xl font-semibold">Over / under budget</h2>
                  <svg className="mt-5 block h-auto w-full max-w-full" width="720" height="270" viewBox="0 0 720 270" role="img" aria-labelledby="budget-variance-chart-title budget-variance-chart-description">
                    <title id="budget-variance-chart-title">Monthly budget variance for {currentYear}</title>
                    <desc id="budget-variance-chart-description">Budget minus spending. Positive bars indicate under budget; negative bars indicate over budget. Months without a budget have no bar.</desc>
                    {[-1, -0.5, 0, 0.5, 1].map((ratio) => {
                      const y = 112 - ratio * 88;
                      const value = budgetVarianceMax * ratio;
                      return (
                        <g key={ratio}>
                          <line x1="82" x2="704" y1={y} y2={y} stroke="#20251f" strokeOpacity={ratio === 0 ? "0.35" : "0.12"} />
                          <text x="74" y={y + 4} textAnchor="end" fill="#65715e" fontSize="10">{formatChartMoney(value)}</text>
                        </g>
                      );
                    })}
                    {yearMonths.map((item, index) => {
                      if (item.budgetVarianceCents === null) {
                        return <text key={item.key} x={yearChartX(index)} y="238" textAnchor="middle" fill="#65715e" fontSize="11">{item.shortLabel}</text>;
                      }
                      const height = Math.abs(item.budgetVarianceCents) / budgetVarianceMax * 88;
                      return (
                        <g key={item.key}>
                          <rect
                            x={yearChartX(index) - 14}
                            y={item.budgetVarianceCents >= 0 ? 112 - height : 112}
                            width="28"
                            height={height}
                            fill={item.budgetVarianceCents < 0 ? "#bf5b3f" : "#4f8271"}
                          >
                            <title>{`${item.label} ${item.budgetVarianceCents < 0 ? "over" : "under"} budget: ${formatMoney(Math.abs(item.budgetVarianceCents))}`}</title>
                          </rect>
                          <text x={yearChartX(index)} y="238" textAnchor="middle" fill="#65715e" fontSize="11">{item.shortLabel}</text>
                        </g>
                      );
                    })}
                  </svg>
                  <p className="mt-1 text-xs text-[#65715e]">Positive is under budget; negative is over. Months without a budget have no bar.</p>
                </div>
              </section>
            )}
            <section className={`grid gap-5 ${isMonthView ? "" : "xl:grid-cols-[minmax(0,1.35fr)_minmax(320px,0.85fr)]"}`}>
              {isMonthView && (
                <section className="border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7">
                  <div className="flex flex-wrap items-baseline justify-between gap-3">
                    <div>
                      <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">Monthly breakdown</p>
                      <h2 className="mt-2 text-2xl font-semibold">Spending by category</h2>
                    </div>
                    <p className="font-semibold tabular-nums">{formatMoney(monthCategoryTotal)}</p>
                  </div>
                  {monthCategoryExpenses.length ? (
                    <figure className="mt-6 flex flex-col items-center gap-6 sm:flex-row sm:items-center">
                      <div
                        aria-label={`Category expenses for ${monthLabel(selectedMonth)}`}
                        className="size-48 shrink-0 rounded-full border border-[#20251f]/10 sm:size-56"
                        role="img"
                        style={{ background: pieChartBackground }}
                      />
                      <ul className="grid max-h-64 w-full grid-cols-1 gap-x-6 gap-y-2 overflow-y-auto sm:grid-cols-2">
                        {monthCategoryExpenses.map((category) => (
                          <li className="flex min-w-0 items-center justify-between gap-3 border-b border-[#20251f]/10 py-2 text-sm" key={category.name}>
                            <span className="flex min-w-0 items-center gap-2">
                              <span aria-hidden="true" className="size-3 shrink-0 rounded-full" style={{ backgroundColor: category.color }} />
                              <span className="truncate">{category.name}</span>
                            </span>
                            <span className="shrink-0 text-right tabular-nums">
                              <span className="font-semibold">{formatMoney(category.amountCents)}</span>
                              <span className="ml-2 text-xs text-[#65715e]">{(category.amountCents / monthCategoryTotal * 100).toFixed(1)}%</span>
                            </span>
                          </li>
                        ))}
                      </ul>
                    </figure>
                  ) : (
                    <p className="mt-6 border-t border-[#20251f]/10 pt-4 text-sm text-[#65715e]">No expenses recorded for this month.</p>
                  )}
                </section>
              )}
              {!isMonthView && <div className="border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">
                      Annual overview
                    </p>
                    <h2 className="mt-2 text-2xl font-semibold">Budget, spending & savings</h2>
                  </div>
                  <span className="text-sm text-[#65715e]">
                    {formatMoney(yearTotal)} year to date
                  </span>
                </div>
                <div className="mt-10 grid gap-3 sm:h-48 sm:grid-cols-[minmax(6.5rem,8rem)_minmax(0,1fr)]">
                  <button type="button" aria-current={isYearlyExpenseView ? "true" : undefined} onClick={() => navigateToMonth("yearly-expenses")} className={`flex min-w-0 flex-col justify-between border-b border-r border-[#20251f]/15 pb-2 pr-3 text-left ${isYearlyExpenseView ? "text-[#bf5b3f]" : "text-[#20251f] hover:text-[#bf5b3f]"}`}>
                    <span className="text-[11px] font-semibold text-[#65715e]">Taxes and Others</span>
                    <span className="break-words text-sm font-semibold tabular-nums">{formatMoney(yearlyExpenseTotal)}</span>
                    <span className="text-center text-[11px] text-[#65715e]">{currentYear}</span>
                  </button>
                  <div role="group" aria-label={`Monthly budget, spending and savings for ${currentYear}`} className="grid h-48 grid-cols-6 items-end gap-3 border-b border-[#20251f]/15 sm:grid-cols-12 sm:gap-2">
                    {yearMonths.map((item) => (
                      <div
                        className="flex h-full min-w-0 flex-col justify-end gap-2"
                        key={item.key}
                      >
                        <div className="flex h-full w-full items-end justify-center gap-0.5">
                          {[
                            { label: "Budget", value: item.budgetCents, color: "bg-[#b8c6ae]" },
                            { label: "Spent", value: item.total, color: item.overBudgetCents > 0 ? "bg-[#bf5b3f]" : "bg-[#65715e]" },
                            { label: "Savings", value: item.savingsCents, color: item.savingsCents >= 0 ? "bg-[#4f8271]" : "bg-[#bf5b3f]" },
                          ].map((series) => (
                            <div
                              key={series.label}
                              className={`w-1/3 ${series.color} ${item.key === selectedMonth ? "opacity-100" : "opacity-75"}`}
                              style={{ height: `${Math.max((Math.abs(series.value) / maxYearValue) * 100, series.value ? 5 : 1)}%` }}
                              title={`${item.label} ${series.label.toLowerCase()}: ${formatMoney(series.value)}`}
                            />
                          ))}
                        </div>
                        <button className="truncate text-center text-[11px] text-[#65715e]" onClick={() => navigateToMonth(item.key)} title={item.label}>
                          {item.shortLabel}
                        </button>
                      </div>
                    ))}
                  </div>
                </div>
                <div className="mt-4 flex flex-wrap gap-x-5 gap-y-2 text-xs text-[#65715e]">
                  <span><span className="mr-2 inline-block size-2 bg-[#b8c6ae]" />Budget</span>
                  <span><span className="mr-2 inline-block size-2 bg-[#65715e]" />Spent</span>
                  <span><span className="mr-2 inline-block size-2 bg-[#4f8271]" />Savings</span>
                  <span><span className="mr-2 inline-block size-2 bg-[#bf5b3f]" />Over budget / negative savings</span>
                </div>
              </div>}
              {isMonthView && expenseHistorySection}
              <div className="border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7">
                <p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">
                  {isYearlyExpenseView ? "Yearly expenses" : "Monthly plan"}
                </p>
                <h2 className="mt-2 text-2xl font-semibold">{isYearlyExpenseView ? "Taxes and Others" : selectedMonthPlan?.label ?? "Choose a month"}</h2>
                {isYearlyExpenseView ? (
                  <div className="mt-5">
                    <form className="space-y-4" onSubmit={saveYearlyExpense}>
                      <div className="grid gap-4 sm:grid-cols-2">
                        <label className="block text-sm font-semibold" htmlFor="yearly-expense-name">
                          Expense
                          <input id="yearly-expense-name" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="text" placeholder="Tax payment, rental deposit..." value={yearlyExpenseName} onChange={(event) => setYearlyExpenseName(event.target.value)} required />
                        </label>
                        <label className="block text-sm font-semibold" htmlFor="yearly-expense-amount">
                          Amount
                          <span className="mt-1 block text-xs font-normal text-[#65715e]">HKD for {currentYear}</span>
                          <input id="yearly-expense-amount" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" value={yearlyExpenseAmount} onChange={(event) => setYearlyExpenseAmount(event.target.value)} required />
                        </label>
                      </div>
                      <button className="w-full bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7] disabled:opacity-50" type="submit" disabled={savingYearlyExpense}>
                        {savingYearlyExpense ? "Adding..." : "Add expense"}
                      </button>
                    </form>
                    {yearlyExpenseMessage && <p className="mt-3 text-sm text-[#4f8271]">{yearlyExpenseMessage}</p>}
                    {yearlyExpenseError && <p className="mt-3 text-sm text-[#bf5b3f]">{yearlyExpenseError}</p>}
                    <div className="mt-6 border-t border-[#20251f]/15 pt-5">
                      <div className="flex items-baseline justify-between gap-4">
                        <p className="text-sm text-[#65715e]">Total for {currentYear}</p>
                        <p className="font-semibold tabular-nums">{formatMoney(yearlyExpenseTotal)}</p>
                      </div>
                      <div className="mt-4 space-y-3">
                        {currentYearExpenseEntries.map((expense) => (
                          <div className="flex items-center justify-between gap-4 border-b border-[#20251f]/10 pb-3" key={expense.id}>
                            <div className="min-w-0">
                              <p className="break-words text-sm font-semibold">{expense.name}</p>
                              <p className="mt-1 text-sm tabular-nums">{formatMoney(expense.amountCents)}</p>
                            </div>
                            <button className="shrink-0 text-xs font-semibold text-[#bf5b3f] disabled:opacity-50" type="button" onClick={() => void removeYearlyExpense(expense.id)} disabled={Boolean(removingYearlyExpense)}>
                              {removingYearlyExpense === expense.id ? "Removing..." : "Remove"}
                            </button>
                          </div>
                        ))}
                        {currentYearExpenseEntries.length === 0 && <p className="text-sm text-[#65715e]">No yearly expenses added.</p>}
                      </div>
                    </div>
                  </div>
                ) : selectedMonthPlan ? (
                  <form className="mt-5 space-y-4" onSubmit={saveMonthlyPlan}>
                    <label className="block text-sm font-semibold" htmlFor="monthly-salary">
                      Salary
                      <span className="mt-1 block text-xs font-normal text-[#65715e]">HKD per month</span>
                      <input id="monthly-salary" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="number" min="0" step="0.01" inputMode="decimal" value={selectedDraft.salary} onChange={(event) => setPlanDrafts((current) => ({ ...current, [selectedMonth]: { ...selectedDraft, salary: event.target.value } }))} required />
                    </label>
                    <label className="block text-sm font-semibold" htmlFor="monthly-budget">
                      Spending budget
                      <span className="mt-1 block text-xs font-normal text-[#65715e]">HKD per month</span>
                      <input id="monthly-budget" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="number" min="0" step="0.01" inputMode="decimal" value={selectedDraft.budget} onChange={(event) => setPlanDrafts((current) => ({ ...current, [selectedMonth]: { ...selectedDraft, budget: event.target.value } }))} required />
                    </label>
                    <button className="w-full bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7] disabled:opacity-50" type="submit" disabled={savingPlan}>
                      {savingPlan ? "Saving..." : "Save monthly plan"}
                    </button>
                    {planSaveMessage && <p className="text-sm text-[#4f8271]">{planSaveMessage}</p>}
                    {(planSaveError || planLoadError) && <p className="text-sm text-[#bf5b3f]">{planSaveError || planLoadError}</p>}
                  </form>
                ) : (
                  <p className="mt-5 text-sm text-[#65715e]">Select a month or Taxes and Others in the sidebar to edit its plan.</p>
                )}
                {selectedMonthPlan && (
                  <div className="mt-6 space-y-3 border-t border-[#20251f]/15 pt-5 text-sm">
                    <div className="flex items-baseline justify-between gap-4"><p className="text-[#65715e]">Spent</p><p className="text-right font-semibold tabular-nums">{formatMoney(selectedMonthPlan.total)}</p></div>
                    <div className="flex items-baseline justify-between gap-4"><p className="text-[#65715e]">Over budget</p><p className="text-right font-semibold tabular-nums">{selectedMonthPlan.overBudgetCents ? formatMoney(selectedMonthPlan.overBudgetCents) : formatMoney(0)}</p></div>
                    <div className="flex items-baseline justify-between gap-4"><p className="text-[#65715e]">Savings</p><p className="text-right font-semibold tabular-nums">{selectedMonthPlan.salaryCents ? formatMoney(selectedMonthPlan.savingsCents) : "-"}</p></div>
                  </div>
                )}
              </div>
            </section>
            {!isMonthView && showExpenseHistory && expenseHistorySection}
          </div>
        </div>
      </div>
      {(transactionLoadError || deleteError) && (
        <p className="mt-4 text-sm text-[#bf5b3f]">
          {transactionLoadError || deleteError}
        </p>
      )}
      {showForm && (
        <TransactionForm
          key={editingTransaction?.id ?? "new"}
          user={user}
          categories={categories}
          transaction={editingTransaction}
          onClose={() => {
            setShowForm(false);
            setEditingTransaction(null);
          }}
        />
      )}
      {showImport && (
        <BulkImportModal
          user={user}
          categories={categories}
          onImported={(imported) => {
            setTransactions((current) => {
              const merged = new Map(current.map((transaction) => [transaction.id, transaction]));
              imported.forEach((transaction) => merged.set(transaction.id, transaction));
              const next = [...merged.values()];
              if (user) window.localStorage.setItem(`financials:transactions:${user.uid}`, JSON.stringify(next));
              return next;
            });
          }}
          onClose={() => setShowImport(false)}
        />
      )}
      {showCategories && (
        <CategoryManager
          categories={categories}
          categoryName={categoryName}
          error={categoryError || categoryLoadError}
          deletingCategory={deletingCategory}
          onChange={setCategoryName}
          onSubmit={addCategory}
          onRemove={removeCategory}
          onClose={() => setShowCategories(false)}
        />
      )}
    </main>
  );
}
function TransactionForm({ user, categories, transaction, onClose }: { user: User | null; categories: string[]; transaction: Transaction | null; onClose: () => void }) {
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState("");
  const [form, setForm] = useState({ date: transaction?.date ?? new Date().toISOString().slice(0, 10), merchant: transaction?.merchant ?? "", category: transaction?.category ?? categories[0] ?? "", paymentMethod: transaction?.paymentMethod ?? "Bank card", amount: transaction ? String(transaction.amountCents / 100) : "", notes: transaction?.notes ?? "" });
  const update = (field: keyof typeof form, value: string) => setForm((current) => ({ ...current, [field]: value }));
  const save = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (!db || !user) { setError("Connect Firebase and sign in before saving transactions."); return; }
    setSaving(true); setError("");
    try {
      const transactionData = {
        userId: user.uid,
        date: form.date,
        merchant: form.merchant.trim(),
        category: form.category,
        paymentMethod: form.paymentMethod,
        amountCents: Math.round(Number(form.amount) * 100),
        notes: form.notes.trim(),
        createdAt: new Date().toISOString(),
      };
      const saveRequest = transaction ? updateDoc(doc(db, "transactions", transaction.id), transactionData) : addDoc(collection(db, "transactions"), transactionData);
      const timeout = new Promise<never>((_, reject) => {
        window.setTimeout(() => reject(new Error("Firebase did not respond. Check Firestore setup and security rules.")), 10000);
      });
      await Promise.race([saveRequest, timeout]);
      onClose();
    } catch (saveError) {
      setError(saveError instanceof Error ? saveError.message : "Could not save this expense.");
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="fixed inset-0 z-10 flex items-end justify-center bg-[#20251f]/40 p-4 sm:items-center">
      <form className="w-full max-w-lg border border-[#20251f]/15 bg-[#fbfaf7] p-6 shadow-[8px_8px_0_#d9dfd1] sm:p-8" onSubmit={save}>
        <div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">New transaction</p><h2 className="mt-2 text-2xl font-semibold">Add an expense</h2></div><button type="button" className="text-sm text-[#65715e]" onClick={onClose}>Close</button></div>
        <div className="mt-7 grid gap-4 sm:grid-cols-2">
          <label className="text-sm">Date<input className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-3" type="date" value={form.date} onChange={(event) => update("date", event.target.value)} required /></label>
          <label className="text-sm">Amount<input className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-3" type="number" min="0.01" step="0.01" placeholder="0.00" value={form.amount} onChange={(event) => update("amount", event.target.value)} required /></label>
          <label className="text-sm sm:col-span-2">Merchant<input className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-3" placeholder="Optional" value={form.merchant} onChange={(event) => update("merchant", event.target.value)} /></label>
          <label className="text-sm">Category<select className="mt-2 w-full border border-[#20251f]/15 bg-[#fbfaf7] px-3 py-3" value={form.category} onChange={(event) => update("category", event.target.value)} required><option value="">Select a category</option>{categories.map((category) => <option key={category}>{category}</option>)}</select></label>
          <label className="text-sm">Payment method<select className="mt-2 w-full border border-[#20251f]/15 bg-[#fbfaf7] px-3 py-3" value={form.paymentMethod} onChange={(event) => update("paymentMethod", event.target.value)}>{paymentMethods.map((method) => <option key={method}>{method}</option>)}</select></label>
          <label className="text-sm sm:col-span-2">Notes<input className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-3" placeholder="Optional" value={form.notes} onChange={(event) => update("notes", event.target.value)} /></label>
        </div>
        {error && <p className="mt-4 text-sm text-[#bf5b3f]">{error}</p>}
        <button className="mt-6 w-full bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7]" type="submit" disabled={saving}>{saving ? "Saving..." : transaction ? "Save changes" : "Save expense"}</button>
      </form>
    </div>
  );
}

function CategoryManager({ categories, categoryName, error, deletingCategory, onChange, onSubmit, onRemove, onClose }: { categories: string[]; categoryName: string; error: string; deletingCategory: string; onChange: (value: string) => void; onSubmit: (event: React.FormEvent<HTMLFormElement>) => void; onRemove: (name: string) => void; onClose: () => void }) {
  return <div className="fixed inset-0 z-10 flex items-end justify-center bg-[#20251f]/40 p-4 sm:items-center"><div className="w-full max-w-md border border-[#20251f]/15 bg-[#fbfaf7] p-6 shadow-[8px_8px_0_#d9dfd1] sm:p-8"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">Personalize</p><h2 className="mt-2 text-2xl font-semibold">Expense categories</h2></div><button type="button" className="text-sm text-[#65715e]" onClick={onClose}>Close</button></div><form className="mt-6 flex gap-2" onSubmit={onSubmit}><label className="sr-only" htmlFor="category-name">New category</label><input id="category-name" className="min-w-0 flex-1 border border-[#20251f]/15 bg-transparent px-3 py-3" placeholder="e.g. Pets" value={categoryName} onChange={(event) => onChange(event.target.value)} /><button className="bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7]" type="submit">Add</button></form>{error && <p className="mt-3 text-sm text-[#bf5b3f]">{error}</p>}<div className="mt-6 flex flex-wrap gap-2">{categories.map((category) => <span className="flex items-center gap-2 border border-[#20251f]/15 px-3 py-2 text-sm" key={category}>{category}<button type="button" className="text-xs text-[#bf5b3f]" onClick={() => void onRemove(category)} disabled={deletingCategory === category}>{deletingCategory === category ? "..." : "Remove"}</button></span>)}</div>{!categories.length && <p className="mt-6 text-sm text-[#65715e]">No categories yet. Add one to start recording expenses.</p>}<p className="mt-5 text-xs leading-5 text-[#65715e]">Categories are saved to your Firebase account.</p></div></div>;
}
function normalizeHeader(value: string) {
  return value.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function getCell(row: Record<string, unknown>, names: string[]) {
  const entry = Object.entries(row).find(([key]) => names.includes(normalizeHeader(key)));
  return entry?.[1];
}

function parseImportDate(value: unknown) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  if (typeof value === "number") {
    const date = new Date(Math.round((value - 25569) * 86400 * 1000));
    return date.toISOString().slice(0, 10);
  }
  const text = String(value ?? "").trim().replace(/\s*\([^)]*\)\s*$/, "");
  const dayFirstDate = text.match(/^(\d{1,2})\s+([A-Za-z]{3,9})\s+(\d{4})$/);
  const monthFirstDate = text.match(/^([A-Za-z]{3,9})\s+(\d{1,2}),\s+(\d{4})$/);
  if (dayFirstDate || monthFirstDate) {
    const monthName = dayFirstDate?.[2] ?? monthFirstDate?.[1] ?? "";
    const day = dayFirstDate?.[1] ?? monthFirstDate?.[2] ?? "";
    const year = dayFirstDate?.[3] ?? monthFirstDate?.[3] ?? "";
    const date = new Date(`${monthName} ${day}, ${year} 12:00:00`);
    return Number.isNaN(date.getTime()) ? "" : `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
  }
  const isoDate = text.match(/^(\d{4})-(\d{2})-(\d{2})$/);
  if (isoDate) return text;
  const date = new Date(text);
  return text && !Number.isNaN(date.getTime()) ? date.toISOString().slice(0, 10) : "";
}

function parseImportAmount(value: unknown) {
  const amount = Number(String(value ?? "").replace(/[$,\sHKD]/gi, ""));
  return Number.isFinite(amount) && amount > 0 ? Math.round(amount * 100) : 0;
}

function withImportTimeout<T>(request: Promise<T>, message: string) {
  const timeout = new Promise<never>((_, reject) => {
    window.setTimeout(() => reject(new Error(message)), 15000);
  });
  return Promise.race([request, timeout]);
}

function BulkImportModal({ user, categories, onImported, onClose }: { user: User | null; categories: string[]; onImported: (rows: Transaction[]) => void; onClose: () => void }) {
  const [rows, setRows] = useState<ImportRow[]>([]);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);

  const readFile = async (file: File) => {
    setError("");
    try {
      const parsed = Papa.parse<Record<string, string>>(await file.text(), { header: true, skipEmptyLines: true });
      if (parsed.errors.length) {
        setError("Could not read this CSV. Check that it has a single header row.");
        setRows([]);
        return;
      }
      const requiredOrder = ["date", "merchant", "category", "amount"];
      const actualOrder = (parsed.meta.fields ?? []).slice(0, requiredOrder.length).map(normalizeHeader);
      if (actualOrder.join(",") !== requiredOrder.join(",")) {
        setError("CSV columns must be in this order: Date, Merchant, Category, Amount.");
        setRows([]);
        return;
      }
      const rawRows = parsed.data;
      const importedRows = rawRows.map((row) => ({
        date: parseImportDate(getCell(row, ["date", "transactiondate", "spentdate"])),
        merchant: String(getCell(row, ["merchant", "payee", "description"]) ?? "").trim(),
        category: String(getCell(row, ["category", "type"]) ?? "").trim(),
        paymentMethod: String(getCell(row, ["paymentmethod", "payment", "method"]) ?? "").trim() || "Bank card",
        amountCents: parseImportAmount(getCell(row, ["amount", "cost", "price"])),
        notes: String(getCell(row, ["notes", "note", "memo"]) ?? "").trim(),
      }));
      const invalidRow = importedRows.find((row) => !row.date || !row.category || !row.amountCents);
      if (invalidRow) {
        setError("Every row needs a valid date, non-empty category, and positive amount. Merchant can be empty.");
        setRows([]);
        return;
      }
      setRows(importedRows);
    } catch {
      setError("Could not read this file. Use a CSV with a header row.");
      setRows([]);
    }
  };

  const importRows = async () => {
    if (!rows.length) return;
    if (!db || !user) {
      setError("You must be signed in and connected to Firebase before importing expenses.");
      return;
    }
    const configuredDb = db;
    setSaving(true);
    setError("");
    try {
      const importedTransactions: Transaction[] = [];
      const newCategories = [...new Set(rows.map((row) => row.category.trim()))].filter(
        (category) => category && !categories.some((existing) => existing.toLowerCase() === category.toLowerCase())
      );
      for (let index = 0; index < rows.length; index += 500) {
        const batch = writeBatch(configuredDb);
        rows.slice(index, index + 500).forEach((row) => {
          const transactionRef = doc(collection(configuredDb, "transactions"));
          batch.set(transactionRef, { ...row, userId: user.uid, createdAt: new Date().toISOString() });
          importedTransactions.push({ ...row, id: transactionRef.id, userId: user.uid });
        });
        await withImportTimeout(batch.commit(), "Firebase did not finish importing expenses. Check your connection and Firestore rules.");
      }
      if (newCategories.length) {
        const categoryBatch = writeBatch(configuredDb);
        newCategories.forEach((name) => {
          categoryBatch.set(doc(collection(configuredDb, "categories")), {
            userId: user.uid,
            name,
            createdAt: new Date().toISOString(),
          });
        });
        try {
          await withImportTimeout(categoryBatch.commit(), "Categories could not be saved. Publish the categories rules in Firestore, then retry category setup.");
        } catch (categoryError) {
          console.error(categoryError);
        }
      }
      onImported(importedTransactions);
      onClose();
    } catch (importError) {
      setError(importError instanceof Error ? importError.message : "Could not import these expenses.");
    } finally {
      setSaving(false);
    }
  };

  return <div className="fixed inset-0 z-10 flex items-end justify-center bg-[#20251f]/40 p-4 sm:items-center"><div className="w-full max-w-xl border border-[#20251f]/15 bg-[#fbfaf7] p-6 shadow-[8px_8px_0_#d9dfd1] sm:p-8"><div className="flex items-start justify-between"><div><p className="text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">Bulk upload</p><h2 className="mt-2 text-2xl font-semibold">Import expenses</h2></div><button type="button" className="text-sm text-[#65715e]" onClick={onClose}>Close</button></div><p className="mt-3 text-sm leading-6 text-[#65715e]">Export Excel or Numbers as CSV, then choose the file here. Required columns: Date, Merchant, Amount, and Category.</p><input className="mt-6 block w-full border border-[#20251f]/15 p-3 text-sm" type="file" accept=".csv,text/csv" onChange={(event) => { const file = event.target.files?.[0]; if (file) void readFile(file); }} />{error && <p className="mt-4 text-sm text-[#bf5b3f]">{error}</p>}{rows.length > 0 && <><p className="mt-5 text-sm font-semibold">{rows.length} expenses ready to import</p><div className="mt-3 max-h-48 overflow-auto border border-[#20251f]/10 text-sm"><table className="w-full text-left"><thead className="border-b border-[#20251f]/10 text-xs uppercase text-[#65715e]"><tr><th className="p-3">Date</th><th className="p-3">Merchant</th><th className="p-3">Category</th><th className="p-3 text-right">Amount</th></tr></thead><tbody>{rows.slice(0, 10).map((row, index) => <tr className="border-b border-[#20251f]/10 last:border-0" key={`${row.date}-${row.merchant}-${index}`}><td className="p-3">{row.date}</td><td className="p-3">{row.merchant}</td><td className="p-3">{row.category}</td><td className="p-3 text-right">{formatMoney(row.amountCents)}</td></tr>)}</tbody></table>{rows.length > 10 && <p className="p-3 text-xs text-[#65715e]">Showing the first 10 rows.</p>}</div><button className="mt-5 w-full bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7]" type="button" onClick={() => void importRows()} disabled={saving}>{saving ? "Importing..." : `Import ${rows.length} expenses`}</button></>}</div></div>;
}

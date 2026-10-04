"use client";

import { startTransition, useEffect, useState } from "react";
import { collection, deleteDoc, doc, onSnapshot, query, setDoc, where } from "firebase/firestore";
import type { User } from "firebase/auth";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { db, firebaseConfigured } from "@/lib/firebase";

export type TripExpense = {
    id: string;
    name: string;
    amountCents: number;
};

export type Trip = {
    id: string;
    userId: string;
    month: string;
    name: string;
    budgetCents: number;
    expenses: TripExpense[];
};

const tripMoney = new Intl.NumberFormat("en-HK", { style: "currency", currency: "HKD" });
const formatTripMoney = (amountCents: number) => tripMoney.format(amountCents / 100);
const tripMonthPath = (month: string) => {
    const monthName = new Intl.DateTimeFormat("en-GB", { month: "long" }).format(new Date(`${month}-01T12:00:00`)).toLowerCase();
    return `/${month.slice(0, 4)}/${monthName}`;
};

export default function TripManager({ user, month, tripId = "", mode = "month", onTripsChange }: {
    user: User | null;
    month: string;
    tripId?: string;
    mode?: "hidden" | "month" | "detail";
    onTripsChange?: (trips: Trip[]) => void;
}) {
    const router = useRouter();
    const [trips, setTrips] = useState<Trip[]>([]);
    const [showTripForm, setShowTripForm] = useState(false);
    const [editingBudgetId, setEditingBudgetId] = useState("");
    const [budgetDraft, setBudgetDraft] = useState("");
    const [savingTripId, setSavingTripId] = useState("");
    const [removingTripId, setRemovingTripId] = useState("");
    const [error, setError] = useState("");
    const [message, setMessage] = useState("");

    const cacheKey = `financials:trips:${user?.uid ?? "demo"}`;
    const monthTrips = trips.filter((trip) => trip.month === month);

    useEffect(() => {
        if (!db || !user) {
            if (firebaseConfigured) return;
            const cachedTrips = window.localStorage.getItem(cacheKey);
            if (cachedTrips) {
                try {
                    startTransition(() => setTrips(JSON.parse(cachedTrips) as Trip[]));
                } catch {
                    window.localStorage.removeItem(cacheKey);
                }
            }
            return;
        }

        const cachedTrips = window.localStorage.getItem(cacheKey);
        if (cachedTrips) {
            try {
                startTransition(() => setTrips(JSON.parse(cachedTrips) as Trip[]));
            } catch {
                window.localStorage.removeItem(cacheKey);
            }
        }

        const tripsQuery = query(collection(db, "trips"), where("userId", "==", user.uid));
        return onSnapshot(tripsQuery, { includeMetadataChanges: true }, (snapshot) => {
            const savedTrips = snapshot.docs.map((item) => {
                const data = item.data();
                return {
                    ...data,
                    id: item.id,
                    expenses: Array.isArray(data.expenses) ? data.expenses as TripExpense[] : [],
                } as Trip;
            });
            setTrips((current) => {
                if (savedTrips.length === 0 && current.length > 0 && snapshot.metadata.fromCache) return current;
                window.localStorage.setItem(cacheKey, JSON.stringify(savedTrips));
                return savedTrips;
            });
            setError("");
        }, (snapshotError) => {
            setError(`Could not load trips: ${snapshotError.message}`);
        });
    }, [cacheKey, user]);

    useEffect(() => {
        onTripsChange?.(trips);
    }, [onTripsChange, trips]);

    const saveTrip = async (trip: Trip) => {
        setSavingTripId(trip.id);
        setError("");
        setMessage("");
        try {
            if (firebaseConfigured && (!db || !user)) throw new Error("Sign in before saving trips.");
            if (db && user) {
                await setDoc(doc(db, "trips", trip.id), { ...trip, updatedAt: new Date().toISOString() });
            }
            setTrips((current) => {
                const next = current.some((item) => item.id === trip.id)
                    ? current.map((item) => item.id === trip.id ? trip : item)
                    : [...current, trip];
                window.localStorage.setItem(cacheKey, JSON.stringify(next));
                return next;
            });
            return true;
        } catch (saveError) {
            setError(saveError instanceof Error ? saveError.message : "Could not save this trip.");
            return false;
        } finally {
            setSavingTripId("");
        }
    };

    const createTrip = async (event: React.FormEvent<HTMLFormElement>) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const name = String(values.get("trip-name") ?? "").trim();
        const budgetInput = String(values.get("trip-budget") ?? "").trim();
        const budget = Number(budgetInput);
        if (!name || !budgetInput || !Number.isFinite(budget) || budget <= 0) {
            setError("Enter a trip name and a positive budget.");
            return;
        }

        const trip: Trip = {
            id: `${user?.uid ?? "demo"}_${crypto.randomUUID()}`,
            userId: user?.uid ?? "demo",
            month,
            name,
            budgetCents: Math.round(budget * 100),
            expenses: [],
        };
        if (await saveTrip(trip)) {
            form.reset();
            setShowTripForm(false);
            setMessage("Trip added.");
        }
    };

    const addExpense = async (event: React.FormEvent<HTMLFormElement>, trip: Trip) => {
        event.preventDefault();
        const form = event.currentTarget;
        const values = new FormData(form);
        const name = String(values.get("expense-name") ?? "").trim();
        const amountInput = String(values.get("expense-amount") ?? "").trim();
        const amount = Number(amountInput);
        if (!name || !amountInput || !Number.isFinite(amount) || amount < 0) {
            setError("Enter an expense name and a valid non-negative amount.");
            return;
        }

        const saved = await saveTrip({
            ...trip,
            expenses: [...trip.expenses, { id: crypto.randomUUID(), name, amountCents: Math.round(amount * 100) }],
        });
        if (saved) {
            form.reset();
            setMessage(`Expense added to ${trip.name}.`);
        }
    };

    const updateBudget = async (event: React.FormEvent<HTMLFormElement>, trip: Trip) => {
        event.preventDefault();
        const values = new FormData(event.currentTarget);
        const budgetInput = String(values.get("trip-budget-edit") ?? "").trim();
        const budget = Number(budgetInput);
        if (!budgetInput || !Number.isFinite(budget) || budget <= 0) {
            setError("Enter a positive trip budget.");
            return;
        }

        if (await saveTrip({ ...trip, budgetCents: Math.round(budget * 100) })) {
            setEditingBudgetId("");
            setMessage("Trip budget updated.");
        }
    };

    const removeExpense = async (trip: Trip, expenseId: string) => {
        setMessage("");
        await saveTrip({ ...trip, expenses: trip.expenses.filter((expense) => expense.id !== expenseId) });
    };

    const removeTrip = async (trip: Trip) => {
        if (!window.confirm(`Remove ${trip.name} and all its expenses?`)) return;
        setRemovingTripId(trip.id);
        setError("");
        setMessage("");
        try {
            if (firebaseConfigured && (!db || !user)) throw new Error("Sign in before removing trips.");
            if (db && user) await deleteDoc(doc(db, "trips", trip.id));
            setTrips((current) => {
                const next = current.filter((item) => item.id !== trip.id);
                window.localStorage.setItem(cacheKey, JSON.stringify(next));
                return next;
            });
            if (mode === "detail") router.push(tripMonthPath(trip.month));
            setMessage("Trip removed.");
        } catch (removeError) {
            setError(removeError instanceof Error ? removeError.message : "Could not remove this trip.");
        } finally {
            setRemovingTripId("");
        }
    };

    if (mode === "hidden") return null;

    const visibleTrips = mode === "detail" ? trips.filter((trip) => trip.id === tripId) : monthTrips;

    return (
        <section className="border border-[#20251f]/15 bg-[#fbfaf7] p-5 sm:p-7" aria-labelledby="trips-heading">
            <div className="flex flex-wrap items-start justify-between gap-4">
                <div>
                    {mode === "detail" && <Link className="text-xs font-semibold uppercase tracking-[0.12em] text-[#65715e] hover:text-[#bf5b3f]" href={tripMonthPath(month)}>Back to {new Intl.DateTimeFormat("en-GB", { month: "long" }).format(new Date(`${month}-01T12:00:00`))}</Link>}
                    <p className="mt-3 text-xs font-semibold uppercase tracking-[0.16em] text-[#65715e]">{mode === "detail" ? "Trip details" : "Travel budgets"}</p>
                    <h2 id="trips-heading" className="mt-2 text-2xl font-semibold">{mode === "detail" ? visibleTrips[0]?.name ?? "Trip not found" : "Trips"}</h2>
                    {mode === "month" && <p className="mt-1 text-sm text-[#65715e]">Track each trip’s expenses against its own budget.</p>}
                </div>
                {mode === "month" && <button
                    type="button"
                    className="bg-[#20251f] px-4 py-2 text-sm font-semibold text-[#fbfaf7] disabled:opacity-50"
                    onClick={() => setShowTripForm((shown) => !shown)}
                    disabled={firebaseConfigured && !user}
                >
                    {showTripForm ? "Cancel" : "+ Add a trip"}
                </button>}
            </div>

            {mode === "month" && firebaseConfigured && !user && <p className="mt-4 text-sm text-[#65715e]">Sign in to manage trips.</p>}
            {mode === "month" && showTripForm && (
                <form className="mt-5 grid gap-4 border-t border-[#20251f]/10 pt-5 sm:grid-cols-[minmax(0,1fr)_12rem_auto] sm:items-end" onSubmit={createTrip}>
                    <label className="block text-sm font-semibold">
                        Trip name
                        <input name="trip-name" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="text" placeholder="Weekend in Taipei" required />
                    </label>
                    <label className="block text-sm font-semibold">
                        Trip budget
                        <span className="mt-1 block text-xs font-normal text-[#65715e]">HKD</span>
                        <input name="trip-budget" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="number" min="0.01" step="0.01" inputMode="decimal" placeholder="0.00" required />
                    </label>
                    <button className="bg-[#4f8271] px-4 py-2 text-sm font-semibold text-white disabled:opacity-50" type="submit" disabled={Boolean(savingTripId)}>
                        {savingTripId ? "Saving..." : "Create trip"}
                    </button>
                </form>
            )}

            {error && <p role="alert" className="mt-4 text-sm text-[#bf5b3f]">{error}</p>}
            {message && <p role="status" className="mt-4 text-sm text-[#4f8271]">{message}</p>}

            <div className="mt-5 space-y-4">
                {visibleTrips.map((trip) => {
                    const spentCents = trip.expenses.reduce((total, expense) => total + expense.amountCents, 0);
                    const varianceCents = trip.budgetCents - spentCents;
                    return (
                        <article key={trip.id} className="border border-[#20251f]/15 p-4 sm:p-5">
                            <div className="flex flex-wrap items-start justify-between gap-3">
                                <div className="min-w-0">
                                    <h3 className="break-words text-lg font-semibold">{mode === "month" ? <Link href={`${tripMonthPath(trip.month)}/trips/${encodeURIComponent(trip.id)}`} className="hover:text-[#bf5b3f]">{trip.name}</Link> : trip.name}</h3>
                                    <p className={`mt-1 text-sm font-semibold ${varianceCents < 0 ? "text-[#bf5b3f]" : "text-[#4f8271]"}`}>
                                        {varianceCents < 0
                                            ? `Over budget by ${formatTripMoney(Math.abs(varianceCents))}`
                                            : varianceCents > 0
                                                ? `Under budget by ${formatTripMoney(varianceCents)}`
                                                : "On budget"}
                                    </p>
                                </div>
                                <button
                                    type="button"
                                    className="shrink-0 text-xs font-semibold text-[#bf5b3f] disabled:opacity-50"
                                    onClick={() => void removeTrip(trip)}
                                    disabled={Boolean(removingTripId)}
                                >
                                    {removingTripId === trip.id ? "Removing..." : "Remove trip"}
                                </button>
                            </div>

                            <div className="mt-4 grid gap-3 border-y border-[#20251f]/10 py-3 text-sm sm:grid-cols-3">
                                <div><p className="text-[#65715e]">Budget</p><p className="mt-1 font-semibold tabular-nums">{formatTripMoney(trip.budgetCents)}</p></div>
                                <div><p className="text-[#65715e]">Trip expenses</p><p className="mt-1 font-semibold tabular-nums">{formatTripMoney(spentCents)}</p></div>
                                <div><p className="text-[#65715e]">Remaining</p><p className={`mt-1 font-semibold tabular-nums ${varianceCents < 0 ? "text-[#bf5b3f]" : "text-[#20251f]"}`}>{formatTripMoney(varianceCents)}</p></div>
                            </div>

                            {editingBudgetId === trip.id ? (
                                <form className="mt-4 flex flex-wrap items-end gap-3" onSubmit={(event) => void updateBudget(event, trip)}>
                                    <label className="block flex-1 text-sm font-semibold">
                                        Update trip budget
                                        <input name="trip-budget-edit" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="number" min="0.01" step="0.01" inputMode="decimal" value={budgetDraft} onChange={(event) => setBudgetDraft(event.target.value)} required />
                                    </label>
                                    <button className="bg-[#20251f] px-4 py-2 text-sm font-semibold text-[#fbfaf7] disabled:opacity-50" type="submit" disabled={Boolean(savingTripId)}>{savingTripId === trip.id ? "Saving..." : "Save budget"}</button>
                                    <button className="px-2 py-2 text-sm font-semibold text-[#65715e]" type="button" onClick={() => setEditingBudgetId("")}>Cancel</button>
                                </form>
                            ) : (
                                <button className="mt-3 text-xs font-semibold text-[#65715e] hover:text-[#bf5b3f]" type="button" onClick={() => { setBudgetDraft(String(trip.budgetCents / 100)); setEditingBudgetId(trip.id); }}>
                                    Edit trip budget
                                </button>
                            )}

                            <form className="mt-4 grid gap-3 border-t border-[#20251f]/10 pt-4 sm:grid-cols-[minmax(0,1fr)_10rem_auto] sm:items-end" onSubmit={(event) => void addExpense(event, trip)}>
                                <label className="block text-sm font-semibold">
                                    Expense
                                    <input name="expense-name" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="text" placeholder="Hotel, meals, transport..." required />
                                </label>
                                <label className="block text-sm font-semibold">
                                    Amount
                                    <span className="mt-1 block text-xs font-normal text-[#65715e]">HKD</span>
                                    <input name="expense-amount" className="mt-2 w-full border border-[#20251f]/15 bg-transparent px-3 py-2 font-normal" type="number" min="0" step="0.01" inputMode="decimal" placeholder="0.00" required />
                                </label>
                                <button className="border border-[#20251f]/20 px-4 py-2 text-sm font-semibold disabled:opacity-50" type="submit" disabled={Boolean(savingTripId)}>
                                    {savingTripId === trip.id ? "Saving..." : "Add expense"}
                                </button>
                            </form>

                            {trip.expenses.length > 0 ? (
                                <ul className="mt-4 divide-y divide-[#20251f]/10 border-t border-[#20251f]/10">
                                    {trip.expenses.map((expense) => (
                                        <li key={expense.id} className="flex items-center justify-between gap-4 py-3 text-sm">
                                            <span className="min-w-0 break-words">{expense.name}</span>
                                            <span className="flex shrink-0 items-center gap-4">
                                                <span className="font-semibold tabular-nums">{formatTripMoney(expense.amountCents)}</span>
                                                <button className="text-xs font-semibold text-[#bf5b3f] disabled:opacity-50" type="button" onClick={() => void removeExpense(trip, expense.id)} disabled={Boolean(savingTripId)} aria-label={`Remove ${expense.name}`}>
                                                    Remove
                                                </button>
                                            </span>
                                        </li>
                                    ))}
                                </ul>
                            ) : (
                                <p className="mt-4 text-sm text-[#65715e]">No expenses added to this trip yet.</p>
                            )}
                        </article>
                    );
                })}
                {visibleTrips.length === 0 && <p className="border-t border-[#20251f]/10 pt-4 text-sm text-[#65715e]">{mode === "detail" ? "This trip could not be found." : "No trips added for this month."}</p>}
            </div>
        </section>
    );
}
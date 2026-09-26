"use client";

import { useEffect, useState } from "react";
import {
  createUserWithEmailAndPassword,
  onAuthStateChanged,
  signInWithEmailAndPassword,
  type User,
} from "firebase/auth";
import { auth } from "@/lib/firebase";

export default function FirebaseProvider({ children }: Readonly<{ children: React.ReactNode }>) {
  const [user, setUser] = useState<User | null>(null);
  const [loading, setLoading] = useState(Boolean(auth));
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [isSignUp, setIsSignUp] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    if (!auth) {
      return;
    }

    return onAuthStateChanged(auth, (nextUser) => {
    setUser(nextUser);
    setLoading(false);
    });
  }, []);

  if (!auth) {
    return children;
  }

  const configuredAuth = auth;

  if (loading) {
    return null;
  }

  if (user) {
    return children;
  }

  const handleSubmit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError("");

    try {
      if (isSignUp) {
        await createUserWithEmailAndPassword(configuredAuth, email, password);
      } else {
        await signInWithEmailAndPassword(configuredAuth, email, password);
      }
    } catch {
      setError(isSignUp ? "Could not create this account." : "Email or password is incorrect.");
    }
  };

  return (
    <div className="min-h-screen bg-[#f4f1ea] px-6 py-8 text-[#20251f] sm:px-10">
      <div className="mx-auto max-w-md border border-[#20251f]/15 bg-[#fbfaf7] p-8 shadow-[8px_8px_0_#d9dfd1]">
        <p className="text-xs font-semibold uppercase tracking-[0.28em] text-[#65715e]">Financials</p>
        <h1 className="mt-4 text-3xl font-semibold">{isSignUp ? "Create your account" : "Welcome back"}</h1>
        <p className="mt-2 text-sm text-[#65715e]">Your transactions stay inside your Firebase project.</p>
        <form className="mt-8 space-y-4" onSubmit={handleSubmit}>
          <input className="w-full border border-[#20251f]/15 bg-transparent px-4 py-3 outline-none" type="email" placeholder="Email" value={email} onChange={(event) => setEmail(event.target.value)} required />
          <input className="w-full border border-[#20251f]/15 bg-transparent px-4 py-3 outline-none" type="password" placeholder="Password" value={password} onChange={(event) => setPassword(event.target.value)} minLength={6} required />
          {error && <p className="text-sm text-[#bf5b3f]">{error}</p>}
          <button className="w-full bg-[#20251f] px-4 py-3 text-sm font-semibold text-[#fbfaf7]" type="submit">
            {isSignUp ? "Sign up" : "Sign in"}
          </button>
        </form>
        <button className="mt-5 text-sm text-[#65715e] underline" type="button" onClick={() => setIsSignUp(!isSignUp)}>
          {isSignUp ? "Already have an account? Sign in" : "Need an account? Sign up"}
        </button>
      </div>
    </div>
  );
}
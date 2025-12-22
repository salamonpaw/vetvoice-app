"use client";

import React, { useEffect, useMemo, useState } from "react";

type Props = {
  children: React.ReactNode;
};

/**
 * PoC auth gate: login + PIN.
 * Uwaga: to nie jest produkcyjne bezpieczeństwo.
 */
export default function AuthGate({ children }: Props) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(false);

  const [err, setErr] = useState("");

  // W PoC możesz trzymać to na sztywno.
  // Jak zechcesz lepiej: przeniesiemy do env (NEXT_PUBLIC_AUTH_LOGIN / NEXT_PUBLIC_AUTH_PIN)
  const AUTH_LOGIN = "alk@alk.pl";
  const AUTH_PIN = "Test123";

  const storage = useMemo(() => {
    if (typeof window === "undefined") return null;
    return remember ? window.localStorage : window.sessionStorage;
  }, [remember]);

  useEffect(() => {
    // sprawdź istniejącą sesję (najpierw localStorage, potem sessionStorage)
    try {
      const tokenLocal = window.localStorage.getItem("vv_auth");
      const tokenSession = window.sessionStorage.getItem("vv_auth");
      if (tokenLocal === "1" || tokenSession === "1") {
        setAuthed(true);
      }
    } catch {}
    setReady(true);
  }, []);

  function logout() {
    try {
      window.localStorage.removeItem("vv_auth");
      window.sessionStorage.removeItem("vv_auth");
    } catch {}
    setAuthed(false);
    setLogin("");
    setPin("");
    setErr("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");

    const l = login.trim();
    const p = pin;

    if (!l || !p) {
      setErr("Podaj login i PIN.");
      return;
    }

    if (l !== AUTH_LOGIN || p !== AUTH_PIN) {
      setErr("Nieprawidłowy login lub PIN.");
      return;
    }

    try {
      // zapis sesji
      storage?.setItem("vv_auth", "1");
    } catch {}

    setAuthed(true);
  }

  if (!ready) {
    return <div className="min-h-screen bg-slate-50" />;
  }

  if (authed) {
    // Mały pasek u góry (opcjonalny, ale UX-owo wygodny)
    return (
      <div className="space-y-3">
        <div className="flex items-center justify-end">
          <button
            onClick={logout}
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
            title="Wyloguj"
          >
            Wyloguj
          </button>
        </div>
        {children}
      </div>
    );
  }

  return (
    <div className="min-h-[70vh] flex items-center justify-center">
      <div className="w-full max-w-sm rounded-2xl border border-slate-200 bg-white p-6 shadow-sm">
        <div className="text-lg font-semibold tracking-tight">Zaloguj się</div>
        <div className="mt-1 text-sm text-slate-600">VetVoice (PoC)</div>

        {err && (
          <div className="mt-4 rounded-xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
            {err}
          </div>
        )}

        <form onSubmit={onSubmit} className="mt-4 space-y-3">
          <label className="grid gap-1">
            <span className="text-sm font-medium text-slate-900">Login</span>
            <input
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="np. alk@alk.pl"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"
              autoComplete="username"
            />
          </label>

          <label className="grid gap-1">
            <span className="text-sm font-medium text-slate-900">PIN</span>
            <input
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••••"
              className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"
              type="password"
              autoComplete="current-password"
            />
          </label>

          <label className="flex items-center gap-2 text-sm text-slate-700 select-none">
            <input
              type="checkbox"
              checked={remember}
              onChange={(e) => setRemember(e.target.checked)}
            />
            Zapamiętaj mnie
          </label>

          <button
            type="submit"
            className="w-full rounded-xl bg-slate-900 px-4 py-2.5 text-sm font-medium text-white hover:bg-slate-800"
          >
            Zaloguj
          </button>
        </form>
      </div>
    </div>
  );
}

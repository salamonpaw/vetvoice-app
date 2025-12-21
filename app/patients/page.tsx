"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId, USER_TS_VERSION } from "@/lib/firebase/user";

type Patient = {
  id: string;
  name?: string;
  species?: string;
  breed?: string | null;
  ownerName?: string | null;
};

export default function PatientsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [patients, setPatients] = useState<Patient[]>([]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError("");

        const clinicId = await getMyClinicId();

        const q = query(
          collection(db, "patients"),
          where("clinicId", "==", clinicId),
          orderBy("createdAt", "desc")
        );

        const snap = await getDocs(q);
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setPatients(rows as Patient[]);
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="text-lg font-semibold tracking-tight">Pacjenci</div>

        <Link
          href="/patients/new"
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
        >
          Dodaj pacjenta
        </Link>
      </div>

      <div className="text-xs text-slate-500">user.ts version: {USER_TS_VERSION}</div>

      {/* Loading / Error */}
      {loading && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">
          Ładowanie…
        </div>
      )}

      {error && !loading && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-sm">
          <div className="font-semibold">Błąd</div>
          <div className="mt-1 whitespace-pre-wrap">{error}</div>
        </div>
      )}

      {/* Empty */}
      {!loading && !error && patients.length === 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold text-slate-900">Brak pacjentów</div>
          <div className="mt-1 text-sm text-slate-600">Dodaj pierwszego pacjenta, aby rozpocząć pracę.</div>
        </div>
      )}

      {/* List */}
      {!loading && !error && patients.length > 0 && (
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <div className="text-sm font-semibold text-slate-900">Lista pacjentów</div>
          <div className="mt-1 text-xs text-slate-500">Kliknij pacjenta, aby przejść do karty i badań.</div>

          <div className="mt-4 grid gap-2">
            {patients.map((p) => {
              const name = (p.name || "").trim() || "Bez imienia";
              const species = (p.species || "").trim() || "nieznany gatunek";
              const breed = (p.breed || "").toString().trim();
              const ownerName = (p.ownerName || "").toString().trim();

              return (
                <Link
                  key={p.id}
                  href={`/patients/${p.id}`}
                  className={[
                    "group block rounded-2xl border border-slate-200 bg-white p-4",
                    "hover:bg-slate-50 hover:border-slate-300",
                    "focus:outline-none focus:ring-2 focus:ring-slate-200",
                    "transition",
                  ].join(" ")}
                >
                  <div className="flex items-start justify-between gap-4">
                    <div className="min-w-0">
                      <div className="text-base font-semibold text-slate-900">{name}</div>

                      <div className="mt-1 text-sm text-slate-600">
                        {species}
                        {breed ? ` • ${breed}` : ""}
                      </div>

                      {ownerName ? (
                        <div className="mt-2 text-sm text-slate-600">
                          <span className="text-slate-500">Właściciel:</span> {ownerName}
                        </div>
                      ) : null}
                    </div>

                    <div className="text-slate-400 group-hover:text-slate-600 transition">→</div>
                  </div>
                </Link>
              );
            })}
          </div>
        </section>
      )}
    </div>
  );
}

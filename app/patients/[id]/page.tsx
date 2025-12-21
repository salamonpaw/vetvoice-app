"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { collection, doc, getDoc, getDocs, orderBy, query, Timestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

type Patient = {
  id: string;
  clinicId: string;
  name?: string;
  species?: string;
  breed?: string | null;
  ownerName?: string | null;
};

type ExamListItem = {
  id: string;
  type?: string;
  status?: string;
  createdAt?: Timestamp | null;
};

function statusLabel(status?: string) {
  const s = (status || "draft").toLowerCase();
  if (s === "in_progress") return "w trakcie";
  if (s === "done") return "zakończone";
  return "szkic";
}

function statusBadgeClass(status?: string) {
  const s = (status || "draft").toLowerCase();

  const base =
    "inline-flex items-center rounded-full border px-2.5 py-1 text-xs font-semibold whitespace-nowrap";

  if (s === "in_progress") {
    return `${base} border-amber-200 bg-amber-50 text-amber-800`;
  }
  if (s === "done") {
    return `${base} border-green-200 bg-green-50 text-green-800`;
  }
  return `${base} border-slate-200 bg-slate-50 text-slate-700`;
}

export default function PatientDetailsPage() {
  const params = useParams<{ id: string | string[] }>();

  const patientId = useMemo(() => {
    const raw = params?.id;
    if (!raw) return "";
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const [patient, setPatient] = useState<Patient | null>(null);

  const [examsLoading, setExamsLoading] = useState(false);
  const [examsError, setExamsError] = useState<string>("");
  const [exams, setExams] = useState<ExamListItem[]>([]);

  useEffect(() => {
    if (!patientId) return;

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError("");
        setPatient(null);

        setExamsLoading(true);
        setExamsError("");
        setExams([]);

        const clinicId = await getMyClinicId();
        if (cancelled) return;

        // 1) Pacjent
        const patientRef = doc(db, "patients", patientId);
        const patientSnap = await getDoc(patientRef);

        if (!patientSnap.exists()) {
          setError("Nie znaleziono pacjenta.");
          return;
        }

        const p = patientSnap.data() as any;

        if (p?.clinicId && p.clinicId !== clinicId) {
          setError("Brak dostępu do tego pacjenta (inna klinika).");
          return;
        }

        setPatient({
          id: patientSnap.id,
          clinicId: p?.clinicId,
          name: p?.name,
          species: p?.species,
          breed: p?.breed ?? null,
          ownerName: p?.ownerName ?? null,
        });

        // 2) Badania
        const examsQ = query(collection(db, "patients", patientId, "exams"), orderBy("createdAt", "desc"));
        const examsSnap = await getDocs(examsQ);
        if (cancelled) return;

        const examRows = examsSnap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            type: data?.type,
            status: data?.status,
            createdAt: (data?.createdAt as Timestamp) ?? null,
          } satisfies ExamListItem;
        });

        setExams(examRows);
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setExamsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const examNewHref = patientId ? `/patients/${patientId}/exams/new` : "/patients";

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <Link href="/patients" className="text-sm text-slate-600 hover:text-slate-900">
            ← Wróć
          </Link>
          <div className="text-lg font-semibold tracking-tight">Karta pacjenta</div>
        </div>

        <Link
          href={examNewHref}
          className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
        >
          Rozpocznij badanie
        </Link>
      </div>

      {/* Alerts */}
      {loading && (
        <div className="rounded-2xl border border-slate-200 bg-white p-4 text-sm text-slate-700 shadow-sm">Ładowanie…</div>
      )}
      {error && !loading && (
        <div className="rounded-2xl border border-red-200 bg-red-50 p-4 text-sm text-red-800 shadow-sm">
          <div className="font-semibold">Błąd</div>
          <div className="mt-1">{error}</div>
        </div>
      )}

      {!loading && !error && patient && (
        <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
          {/* Patient card */}
          <section className="lg:col-span-2 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="text-sm font-semibold text-slate-900">Pacjent</div>

            <div className="mt-3">
              <div className="text-xl font-semibold tracking-tight">{patient.name?.trim() || "Bez imienia"}</div>

              <div className="mt-1 text-sm text-slate-600">
                {(patient.species?.trim() || "nieznany gatunek") +
                  (patient.breed?.toString().trim() ? ` • ${patient.breed.toString().trim()}` : "")}
              </div>

              {patient.ownerName?.toString().trim() ? (
                <div className="mt-3 text-sm text-slate-600">
                  <span className="text-slate-500">Właściciel:</span> {patient.ownerName.toString().trim()}
                </div>
              ) : null}

              <div className="mt-4 rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs text-slate-700">
                <div className="text-slate-500">ID</div>
                <div className="mt-1 font-mono break-all">{patient.id}</div>
              </div>
            </div>
          </section>

          {/* Exams */}
          <section className="lg:col-span-3 rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold text-slate-900">Badania</div>
                <div className="mt-1 text-xs text-slate-500">Kliknij badanie, aby wejść do nagrania i raportu.</div>
              </div>
            </div>

            {examsLoading && <div className="mt-4 text-sm text-slate-600">Ładowanie badań…</div>}
            {examsError && !examsLoading && (
              <div className="mt-4 rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
                <div className="font-semibold">Błąd</div>
                <div className="mt-1">{examsError}</div>
              </div>
            )}

            {!examsLoading && !examsError && exams.length === 0 && (
              <div className="mt-4 rounded-2xl border border-slate-200 bg-slate-50 p-4">
                <div className="font-semibold text-slate-900">Brak badań</div>
                <div className="mt-1 text-sm text-slate-600">
                  Utwórz pierwsze badanie, aby rozpocząć dokumentowanie wizyty.
                </div>
              </div>
            )}

            {!examsLoading && !examsError && exams.length > 0 && (
              <div className="mt-4 grid gap-2">
                {exams.map((ex) => (
                  <Link
                    key={ex.id}
                    href={`/patients/${patientId}/exams/${ex.id}`}
                    className={[
                      "group block rounded-2xl border border-slate-200 bg-white p-4",
                      "hover:bg-slate-50 hover:border-slate-300",
                      "focus:outline-none focus:ring-2 focus:ring-slate-200",
                      "transition",
                    ].join(" ")}
                  >
                    <div className="flex items-start justify-between gap-4">
                      <div className="min-w-0">
                        <div className="text-base font-semibold text-slate-900">{(ex.type || "Badanie").toString()}</div>

                        <div className="mt-2 flex flex-wrap items-center gap-2">
                          <span className={statusBadgeClass(ex.status)}>{statusLabel(ex.status)}</span>

                          <span className="text-xs text-slate-500">
                            {ex.createdAt ? ex.createdAt.toDate().toLocaleString() : ""}
                          </span>
                        </div>
                      </div>

                      <div className="text-slate-400 group-hover:text-slate-600 transition">→</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

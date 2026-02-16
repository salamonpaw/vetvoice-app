"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";

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

type ExamGroup = {
  key: string;
  title: string;
  items: ExamListItem[];
  newestMs: number;
};

function statusLabel(status?: string) {
  const s = (status || "draft").toLowerCase();
  if (s === "in_progress") return "w trakcie";
  if (s === "done") return "zakończone";
  return "robocze";
}

function statusBadgeClass(status?: string) {
  const s = (status || "draft").toLowerCase();
  if (s === "in_progress") return "border-amber-200 bg-amber-50 text-amber-800";
  if (s === "done") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function examTimeMs(exam: ExamListItem) {
  const t = exam.createdAt as any;
  if (!t) return 0;
  if (typeof t.toMillis === "function") return t.toMillis();
  if (typeof t.toDate === "function") return t.toDate().getTime();
  return 0;
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

        const examsQ = query(
          collection(db, "patients", patientId, "exams"),
          orderBy("createdAt", "desc")
        );
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

  const groupedExams = useMemo<ExamGroup[]>(() => {
    const map = new Map<string, ExamListItem[]>();
    for (const exam of exams) {
      const raw = ((exam.type as string) || (exam as any).title || "").trim();
      const key = raw || "Inne";
      const list = map.get(key) ?? [];
      list.push(exam);
      map.set(key, list);
    }

    const groups: ExamGroup[] = Array.from(map.entries()).map(
      ([key, items]) => {
        const sorted = [...items].sort((a, b) => examTimeMs(b) - examTimeMs(a));
        return {
          key,
          title: key,
          items: sorted,
          newestMs: examTimeMs(sorted[0] ?? { id: "" }),
        };
      }
    );

    groups.sort((a, b) => b.newestMs - a.newestMs);
    return groups;
  }, [exams]);

  return (
    <div className="space-y-6">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="flex items-center gap-3">
          <Button variant="ghost" size="sm" asChild>
            <Link href="/patients">← Wróć</Link>
          </Button>
          <div>
            <h1 className="text-xl font-semibold text-slate-900">
              Karta pacjenta
            </h1>
            <p className="text-sm text-slate-500">
              Dane pacjenta i lista badań.
            </p>
          </div>
        </div>

        <Button asChild>
          <Link href={examNewHref}>Rozpocznij badanie</Link>
        </Button>
      </div>

      {loading && (
        <Card>
          <CardContent className="p-4 text-sm text-slate-600">
            Ładowanie…
          </CardContent>
        </Card>
      )}

      {error && !loading && (
        <Card className="border-red-200 bg-red-50">
          <CardContent className="p-4 text-sm text-red-800">
            <div className="font-semibold">Błąd</div>
            <div className="mt-1">{error}</div>
          </CardContent>
        </Card>
      )}

      {!loading && !error && patient && (
        <div className="space-y-6">
          <Card>
            <CardHeader className="pb-2">
              <CardTitle>Pacjent</CardTitle>
            </CardHeader>
            <CardContent className="grid gap-3 sm:grid-cols-2">
              <div>
                <div className="text-lg font-semibold text-slate-900">
                  {patient.name?.trim() || "Bez imienia"}
                </div>
                <div className="text-sm text-slate-600">
                  {(patient.species?.trim() || "nieznany gatunek") +
                    (patient.breed?.toString().trim()
                      ? ` • ${patient.breed.toString().trim()}`
                      : "")}
                </div>
                {patient.ownerName?.toString().trim() ? (
                  <div className="mt-2 text-sm text-slate-600">
                    <span className="text-slate-500">Właściciel:</span>{" "}
                    {patient.ownerName.toString().trim()}
                  </div>
                ) : null}
              </div>
              <div>
                <div className="text-xs text-slate-500">ID</div>
                <div className="mt-1 break-all rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-xs font-mono text-slate-700">
                  {patient.id}
                </div>
              </div>
            </CardContent>
          </Card>

          <div className="space-y-4">
            {examsLoading && (
              <Card>
                <CardContent className="p-4 text-sm text-slate-600">
                  Ładowanie badań…
                </CardContent>
              </Card>
            )}

            {examsError && !examsLoading && (
              <Card className="border-red-200 bg-red-50">
                <CardContent className="p-4 text-sm text-red-800">
                  <div className="font-semibold">Błąd</div>
                  <div className="mt-1">{examsError}</div>
                </CardContent>
              </Card>
            )}

            {!examsLoading && !examsError && groupedExams.length === 0 && (
              <Card>
                <CardHeader className="pb-2">
                  <CardTitle>Brak badań</CardTitle>
                </CardHeader>
                <CardContent className="flex flex-col gap-3 text-sm text-slate-600">
                  Utwórz pierwsze badanie, aby rozpocząć dokumentowanie wizyty.
                  <div>
                    <Button asChild size="sm">
                      <Link href={examNewHref}>Rozpocznij badanie</Link>
                    </Button>
                  </div>
                </CardContent>
              </Card>
            )}

            {!examsLoading &&
              !examsError &&
              groupedExams.map((group) => (
                <Card key={group.key}>
                  <CardHeader className="pb-2">
                    <div className="flex flex-wrap items-center gap-2">
                      <CardTitle>{group.title}</CardTitle>
                      <span className="text-xs text-slate-500">
                        • {group.items.length}
                      </span>
                    </div>
                  </CardHeader>
                  <CardContent className="pt-0">
                    <div className="divide-y divide-slate-200">
                      {group.items.map((ex) => {
                        const dateText = ex.createdAt
                          ? ex.createdAt.toDate().toLocaleString("pl-PL")
                          : "—";
                        const examTitle = ((ex.type as string) || (ex as any).title || "Badanie").toString();
                        return (
                          <Link
                            key={ex.id}
                            href={`/patients/${patientId}/exams/${ex.id}`}
                            className="group flex w-full items-center justify-between gap-3 px-2 py-3 text-left transition hover:bg-slate-50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-300"
                          >
                            <div className="min-w-0 flex-1">
                              <div className="text-sm font-semibold text-slate-900">
                                {examTitle}
                              </div>
                              <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-500 sm:hidden">
                                <Badge
                                  className={statusBadgeClass(ex.status)}
                                  variant="outline"
                                >
                                  {statusLabel(ex.status)}
                                </Badge>
                                <span>{dateText}</span>
                              </div>
                            </div>

                            <div className="hidden items-center gap-3 sm:flex">
                              <Badge
                                className={statusBadgeClass(ex.status)}
                                variant="outline"
                              >
                                {statusLabel(ex.status)}
                              </Badge>
                              <span className="text-xs text-slate-500">
                                {dateText}
                              </span>
                              <span className="text-slate-400">→</span>
                            </div>
                          </Link>
                        );
                      })}
                    </div>
                  </CardContent>
                </Card>
              ))}
          </div>
        </div>
      )}
    </div>
  );
}

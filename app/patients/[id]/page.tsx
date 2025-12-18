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

function statusChipStyle(status?: string): React.CSSProperties {
  const s = (status || "draft").toLowerCase();
  const base: React.CSSProperties = {
    display: "inline-flex",
    alignItems: "center",
    gap: 6,
    padding: "4px 8px",
    borderRadius: 999,
    fontSize: 12,
    fontWeight: 800,
    border: "1px solid rgba(255,255,255,0.18)",
    background: "rgba(255,255,255,0.06)",
    opacity: 0.95,
    whiteSpace: "nowrap",
  };

  if (s === "in_progress") {
    return {
      ...base,
      border: "1px solid rgba(255,255,255,0.32)",
      background: "rgba(255,255,255,0.10)",
    };
  }

  if (s === "done") {
    return {
      ...base,
      border: "1px solid rgba(255,255,255,0.28)",
      background: "rgba(255,255,255,0.08)",
      opacity: 0.9,
    };
  }

  // draft
  return base;
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

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Karta pacjenta</h1>
        <Link href="/patients">← Wróć</Link>
      </div>

      {loading && <p>Ładowanie...</p>}
      {error && !loading && <p style={{ color: "tomato" }}>Błąd: {error}</p>}

      {!loading && !error && patient && (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          {/* Dane pacjenta */}
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 800 }}>
              {patient.name?.trim() || "Bez imienia"}
            </div>

            <div style={{ marginTop: 6, opacity: 0.85 }}>
              {(patient.species?.trim() || "nieznany gatunek") +
                (patient.breed?.toString().trim()
                  ? ` • ${patient.breed.toString().trim()}`
                  : "")}
            </div>

            {patient.ownerName?.toString().trim() ? (
              <div style={{ marginTop: 6, fontSize: 12, opacity: 0.75 }}>
                Właściciel: {patient.ownerName.toString().trim()}
              </div>
            ) : null}

            <div style={{ marginTop: 10, fontSize: 12, opacity: 0.6 }}>
              ID: {patient.id}
            </div>
          </div>

          {/* Badania */}
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: 12,
              }}
            >
              <h2 style={{ margin: 0, fontSize: 16 }}>Badania</h2>

              <Link
                href={examNewHref}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "rgba(255,255,255,0.10)",
                  textDecoration: "none",
                  color: "inherit",
                  whiteSpace: "nowrap",
                }}
              >
                ➕ Rozpocznij badanie
              </Link>
            </div>

            {examsLoading && <p style={{ marginTop: 12 }}>Ładowanie badań...</p>}
            {examsError && !examsLoading && (
              <p style={{ marginTop: 12, color: "tomato" }}>Błąd: {examsError}</p>
            )}

            {!examsLoading && !examsError && exams.length === 0 && (
              <div style={{ marginTop: 12, opacity: 0.85 }}>
                <div style={{ fontWeight: 700 }}>Brak badań</div>
                <div style={{ marginTop: 4, fontSize: 13, opacity: 0.8 }}>
                  Utwórz pierwsze badanie, aby rozpocząć dokumentowanie wizyty.
                </div>
              </div>
            )}

            {!examsLoading && !examsError && exams.length > 0 && (
              <div style={{ marginTop: 12, display: "grid", gap: 8 }}>
                {exams.map((ex) => (
                  <Link
                    key={ex.id}
                    href={`/patients/${patientId}/exams/${ex.id}`}
                    style={{
                      display: "block",
                      padding: 10,
                      borderRadius: 10,
                      border: "1px solid rgba(255,255,255,0.16)",
                      background: "rgba(255,255,255,0.05)",
                      textDecoration: "none",
                      color: "inherit",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                      <div style={{ display: "grid", gap: 6 }}>
                        <div style={{ fontWeight: 900 }}>
                          {(ex.type || "Badanie").toString()}
                        </div>

                        <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
                          <span style={statusChipStyle(ex.status)}>
                            {statusLabel(ex.status)}
                          </span>

                          <span style={{ fontSize: 12, opacity: 0.75 }}>
                            {ex.createdAt ? ex.createdAt.toDate().toLocaleString() : ""}
                          </span>
                        </div>
                      </div>

                      <div style={{ opacity: 0.6, whiteSpace: "nowrap" }}>→</div>
                    </div>
                  </Link>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

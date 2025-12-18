"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { doc, getDoc, updateDoc, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

type ExamStatus = "draft" | "in_progress" | "done" | string;

type Exam = {
  id: string;
  clinicId: string;
  patientId: string;
  type: string;
  status: ExamStatus;
};

function firstParam(v: string | string[] | undefined) {
  if (!v) return "";
  return Array.isArray(v) ? v[0] : v;
}

function formatMs(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const m = Math.floor(totalSec / 60);
  const s = totalSec % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return `${mm}:${ss}`;
}

export default function ExamDetailsPage() {
  const params = useParams<Record<string, string | string[]>>();

  const patientId = useMemo(() => firstParam(params?.id), [params]);
  const examId = useMemo(() => firstParam(params?.examId ?? params?.examsId), [params]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [exam, setExam] = useState<Exam | null>(null);

  const [savingStatus, setSavingStatus] = useState<ExamStatus | null>(null);

  // --- UI nagrywania (na razie bez MediaRecorder)
  const [recState, setRecState] = useState<"idle" | "recording" | "paused" | "stopped">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const tickRef = useRef<number | null>(null);
  const startedAtRef = useRef<number | null>(null);
  const accumulatedRef = useRef<number>(0);

  function stopTicker() {
    if (tickRef.current) {
      window.clearInterval(tickRef.current);
      tickRef.current = null;
    }
  }

  function startTicker() {
    stopTicker();
    tickRef.current = window.setInterval(() => {
      const now = Date.now();
      const startedAt = startedAtRef.current ?? now;
      setElapsedMs(accumulatedRef.current + (now - startedAt));
    }, 250);
  }

  function uiStart() {
    accumulatedRef.current = 0;
    startedAtRef.current = Date.now();
    setElapsedMs(0);
    setRecState("recording");
    startTicker();
  }

  function uiPause() {
    const now = Date.now();
    const startedAt = startedAtRef.current;
    if (startedAt) accumulatedRef.current += now - startedAt;
    startedAtRef.current = null;
    setRecState("paused");
    stopTicker();
  }

  function uiResume() {
    startedAtRef.current = Date.now();
    setRecState("recording");
    startTicker();
  }

  function uiStop() {
    const now = Date.now();
    const startedAt = startedAtRef.current;
    if (startedAt) accumulatedRef.current += now - startedAt;
    startedAtRef.current = null;
    setElapsedMs(accumulatedRef.current);
    setRecState("stopped");
    stopTicker();
  }

  useEffect(() => {
    return () => stopTicker();
  }, []);

  // --- wczytanie badania
  useEffect(() => {
    let cancelled = false;

    (async () => {
      setLoading(true);
      setError("");
      setExam(null);

      if (!patientId || !examId) {
        setLoading(false);
        setError("Brak parametrów w URL (patientId lub examId).");
        return;
      }

      try {
        const clinicId = await getMyClinicId();
        if (cancelled) return;

        const ref = doc(db, "patients", patientId, "exams", examId);
        const snap = await getDoc(ref);

        if (!snap.exists()) {
          setError("Nie znaleziono badania.");
          return;
        }

        const data = snap.data() as any;

        if (data?.clinicId && data.clinicId !== clinicId) {
          setError("Brak dostępu do tego badania (inna klinika).");
          return;
        }

        setExam({
          id: snap.id,
          clinicId: data?.clinicId,
          patientId: data?.patientId,
          type: data?.type || "—",
          status: data?.status || "draft",
        });
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [patientId, examId]);

  async function setStatus(nextStatus: ExamStatus) {
    if (!patientId || !examId) return;
    if (!exam) return;
    if (savingStatus) return;

    try {
      setSavingStatus(nextStatus);
      setError("");

      const ref = doc(db, "patients", patientId, "exams", examId);
      await updateDoc(ref, {
        status: nextStatus,
        updatedAt: serverTimestamp(),
      });

      setExam((prev) => (prev ? { ...prev, status: nextStatus } : prev));

      // UX: jeśli ktoś zakończył badanie, wyłączamy UI nagrywania
      if (nextStatus === "done") {
        uiStop();
      }
      if (nextStatus === "draft") {
        // reset UI
        stopTicker();
        accumulatedRef.current = 0;
        startedAtRef.current = null;
        setElapsedMs(0);
        setRecState("idle");
      }
    } catch (e: any) {
      console.error(e);
      setError(e?.message || String(e));
    } finally {
      setSavingStatus(null);
    }
  }

  const backHref = patientId ? `/patients/${patientId}` : "/patients";
  const recordingEnabled = exam?.status === "in_progress";

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 820 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Badanie</h1>
        <Link href={backHref}>← Wróć do pacjenta</Link>
      </div>

      {loading && <p>Ładowanie...</p>}
      {error && !loading && <p style={{ color: "tomato" }}>Błąd: {error}</p>}

      {!loading && !error && exam && (
        <div style={{ marginTop: 16, display: "grid", gap: 12 }}>
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              display: "grid",
              gap: 8,
            }}
          >
            <div style={{ fontSize: 18, fontWeight: 900 }}>{exam.type}</div>
            <div style={{ opacity: 0.85 }}>
              Status: <b>{exam.status}</b>
            </div>
            <div style={{ fontSize: 12, opacity: 0.65 }}>
              Exam ID: {exam.id} • Patient ID: {exam.patientId}
            </div>
          </div>

          {/* Status */}
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              display: "grid",
              gap: 10,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16 }}>Sterowanie statusem</h2>

            <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button
                type="button"
                disabled={!!savingStatus || exam.status === "in_progress"}
                onClick={() => setStatus("in_progress")}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "rgba(255,255,255,0.10)",
                  cursor: !!savingStatus || exam.status === "in_progress" ? "not-allowed" : "pointer",
                  opacity: !!savingStatus || exam.status === "in_progress" ? 0.6 : 1,
                }}
              >
                {savingStatus === "in_progress" ? "Ustawiam..." : "▶ Rozpocznij badanie"}
              </button>

              <button
                type="button"
                disabled={!!savingStatus || exam.status === "done"}
                onClick={() => setStatus("done")}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "rgba(255,255,255,0.10)",
                  cursor: !!savingStatus || exam.status === "done" ? "not-allowed" : "pointer",
                  opacity: !!savingStatus || exam.status === "done" ? 0.6 : 1,
                }}
              >
                {savingStatus === "done" ? "Ustawiam..." : "✓ Zakończ badanie"}
              </button>

              <button
                type="button"
                disabled={!!savingStatus || exam.status === "draft"}
                onClick={() => setStatus("draft")}
                style={{
                  padding: "10px 12px",
                  borderRadius: 10,
                  border: "1px solid rgba(255,255,255,0.22)",
                  background: "rgba(255,255,255,0.06)",
                  cursor: !!savingStatus || exam.status === "draft" ? "not-allowed" : "pointer",
                  opacity: !!savingStatus || exam.status === "draft" ? 0.6 : 0.9,
                }}
                title="Cofnij do szkicu"
              >
                ↩ Cofnij do draft
              </button>
            </div>

            <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>
              Nagrywanie będzie dostępne dopiero dla statusu <b>in_progress</b>.
            </p>
          </div>

          {/* Nagrywanie (UI) */}
          <div
            style={{
              padding: 12,
              borderRadius: 12,
              border: "1px solid rgba(255,255,255,0.18)",
              background: "rgba(255,255,255,0.06)",
              display: "grid",
              gap: 10,
            }}
          >
            <h2 style={{ margin: 0, fontSize: 16 }}>Nagrywanie</h2>

            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
              <div style={{ display: "grid", gap: 4 }}>
                <div style={{ fontSize: 28, fontWeight: 900 }}>{formatMs(elapsedMs)}</div>
                <div style={{ fontSize: 12, opacity: 0.75 }}>
                  Stan: <b>{recState}</b>
                  {!recordingEnabled ? " • (wymaga in_progress)" : ""}
                </div>
              </div>

              <div style={{ display: "flex", gap: 10, flexWrap: "wrap", justifyContent: "flex-end" }}>
                <button
                  type="button"
                  disabled={!recordingEnabled || recState === "recording"}
                  onClick={() => {
                    if (recState === "paused") uiResume();
                    else uiStart();
                  }}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.10)",
                    cursor: !recordingEnabled || recState === "recording" ? "not-allowed" : "pointer",
                    opacity: !recordingEnabled || recState === "recording" ? 0.6 : 1,
                  }}
                >
                  {recState === "paused" ? "▶ Wznów" : "⏺ Start"}
                </button>

                <button
                  type="button"
                  disabled={!recordingEnabled || recState !== "recording"}
                  onClick={uiPause}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.06)",
                    cursor: !recordingEnabled || recState !== "recording" ? "not-allowed" : "pointer",
                    opacity: !recordingEnabled || recState !== "recording" ? 0.6 : 0.95,
                  }}
                >
                  ⏸ Pauza
                </button>

                <button
                  type="button"
                  disabled={!recordingEnabled || (recState !== "recording" && recState !== "paused")}
                  onClick={uiStop}
                  style={{
                    padding: "10px 12px",
                    borderRadius: 10,
                    border: "1px solid rgba(255,255,255,0.22)",
                    background: "rgba(255,255,255,0.06)",
                    cursor:
                      !recordingEnabled || (recState !== "recording" && recState !== "paused")
                        ? "not-allowed"
                        : "pointer",
                    opacity:
                      !recordingEnabled || (recState !== "recording" && recState !== "paused") ? 0.6 : 0.95,
                  }}
                >
                  ⏹ Stop
                </button>
              </div>
            </div>

            <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>
              To jest szkielet UI. Następny etap: MediaRecorder + zapis pliku (Storage) i metadanych do Firestore.
            </p>
          </div>
        </div>
      )}
    </div>
  );
}

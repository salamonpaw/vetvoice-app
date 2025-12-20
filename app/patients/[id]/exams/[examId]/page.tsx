"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

type ExamStatus = "draft" | "in_progress" | "done";

type ExamDoc = {
  clinicId: string;
  patientId: string;
  type: string;
  status: ExamStatus;
  createdAt?: any;
  updatedAt?: any;

  transcript?: string;
  transcriptRaw?: string;

  analysis?: {
    sections?: {
      reason?: string | null;
      findings?: string | null;
      conclusions?: string | null;
      recommendations?: string | null;
    };
  };
  analysisMissing?: {
    reason?: boolean;
    findings?: boolean;
    conclusions?: boolean;
    recommendations?: boolean;
  };
  analysisMeta?: any;

  report?: string;

  recording?: {
    storage: "local" | "firebase";
    localPath?: string;
    absolutePath?: string;
    durationMs: number;
    mimeType: string;
    size: number;
    savedAt?: any;
    expiresAt?: any;
  };
};

type PipelineStep = "idle" | "transcribing" | "analyzing" | "generating" | "done" | "error";

function fmtMs(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function statusLabel(s: ExamStatus) {
  return s === "draft" ? "Szkic" : s === "in_progress" ? "W trakcie" : "Zakończone";
}

function typeLabel(t?: string) {
  return t || "Badanie";
}

function addDaysISO(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

async function readJsonOrText(res: Response) {
  const contentType = res.headers.get("content-type") || "";
  const text = await res.text();

  if (contentType.includes("application/json")) {
    try {
      return { kind: "json" as const, json: JSON.parse(text), text };
    } catch {
      return { kind: "text" as const, json: null, text };
    }
  }

  return { kind: "text" as const, json: null, text };
}

function pipelineLabel(step: PipelineStep) {
  switch (step) {
    case "idle":
      return "—";
    case "transcribing":
      return "Transkrypcja…";
    case "analyzing":
      return "Analiza (LLM)…";
    case "generating":
      return "Generowanie raportu…";
    case "done":
      return "Gotowe ✅";
    case "error":
      return "Błąd ❌";
  }
}

export default function ExamPage() {
  const router = useRouter();
  const params = useParams<{ id: string; examId: string }>();

  const patientIdFromParams = Array.isArray(params?.id) ? params.id[0] : params?.id;
  const examId = Array.isArray(params?.examId) ? params.examId[0] : params?.examId;

  const [loading, setLoading] = useState(true);
  const [savingAudio, setSavingAudio] = useState(false);
  const [transcribing, setTranscribing] = useState(false);

  const [exam, setExam] = useState<ExamDoc | null>(null);
  const [clinicId, setClinicId] = useState("");

  const [pipelineStep, setPipelineStep] = useState<PipelineStep>("idle");
  const [pipelineMsg, setPipelineMsg] = useState("");

  // MediaRecorder state
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef(0);
  const elapsedBeforePauseRef = useRef(0);

  const [recState, setRecState] = useState<"idle" | "recording" | "paused" | "stopped">("idle");
  const [elapsedMs, setElapsedMs] = useState(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState("");
  const [recordedMime, setRecordedMime] = useState("audio/webm");

  const [err, setErr] = useState("");
  const [okMsg, setOkMsg] = useState("");
  const [showRaw, setShowRaw] = useState(false);

  // Raport
  const [generatingReport, setGeneratingReport] = useState(false);
  const [savingReport, setSavingReport] = useState(false);
  const [reportDraft, setReportDraft] = useState("");
  const [reportDirty, setReportDirty] = useState(false);

  // IMPORTANT: ref do natychmiastowego “dirty” (eliminuje race: setState vs load())
  const reportDirtyRef = useRef(false);

  const examRef = useMemo(() => {
    if (!patientIdFromParams || !examId) return null;
    return doc(db, "patients", patientIdFromParams, "exams", examId);
  }, [patientIdFromParams, examId]);

  const canRecord = exam?.status === "in_progress";
  const hasLocalRecording = !!exam?.recording?.localPath;
  const hasTranscript = !!exam?.transcript;
  const transcriptToShow = showRaw ? exam?.transcriptRaw : exam?.transcript;

  const missing = exam?.analysisMissing;
  const hasAnyAnalysis = !!exam?.analysis?.sections || !!exam?.analysisMissing;

  // timer tick
  useEffect(() => {
    if (recState !== "recording") return;

    const t = window.setInterval(() => {
      setElapsedMs(elapsedBeforePauseRef.current + (Date.now() - startedAtRef.current));
    }, 250);

    return () => window.clearInterval(t);
  }, [recState]);

  // cleanup object URL
  useEffect(() => {
    return () => {
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
  }, [recordedUrl]);

  // cleanup stream on unmount
  useEffect(() => {
    return () => {
      tryStopTracks();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function tryStopTracks() {
    try {
      mediaStreamRef.current?.getTracks()?.forEach((t) => t.stop());
    } catch {}
    mediaStreamRef.current = null;
  }

  function getCidFromStateOrExam(e?: ExamDoc | null) {
    return clinicId || e?.clinicId || "demo-clinic";
  }

  async function fetchFreshExam(): Promise<ExamDoc | null> {
    if (!examRef) return null;
    const snap = await getDoc(examRef);
    return snap.exists() ? (snap.data() as ExamDoc) : null;
  }

  async function load() {
    if (!examRef) return;
    setLoading(true);
    setErr("");
    setOkMsg("");

    try {
      const cid = await getMyClinicId();
      setClinicId(cid);

      const snap = await getDoc(examRef);
      const data = snap.exists() ? (snap.data() as ExamDoc) : null;

      setExam(data);

      // NIE NADPISUJ raportu jeśli user zaczął edycję / pipeline już wstawił draft
      // Uwaga: używamy ref, żeby uniknąć race condition (setReportDirty(true) vs load()).
      if (!reportDirtyRef.current) {
        setReportDraft(data?.report || "");
      }
    } catch (e: any) {
      setErr(e?.message || "Błąd ładowania");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [examRef]);

  function pickSupportedMime(): string {
    const candidates = ["audio/webm;codecs=opus", "audio/webm", "audio/ogg;codecs=opus", "audio/ogg"];
    for (const c of candidates) {
      // @ts-ignore
      if (typeof MediaRecorder !== "undefined" && MediaRecorder.isTypeSupported?.(c)) return c;
    }
    return "audio/webm";
  }

  async function startRecording() {
    setErr("");
    setOkMsg("");

    if (!canRecord) {
      setErr("Nagrywanie dostępne tylko w statusie: W trakcie.");
      return;
    }

    if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    setRecordedBlob(null);
    setRecordedUrl("");
    setElapsedMs(0);
    chunksRef.current = [];
    elapsedBeforePauseRef.current = 0;

    try {
      const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      mediaStreamRef.current = stream;

      const mime = pickSupportedMime();
      setRecordedMime(mime);

      const mr = new MediaRecorder(stream, { mimeType: mime } as any);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) chunksRef.current.push(e.data);
      };

      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mime });
        setRecordedBlob(blob);
        setRecordedUrl(URL.createObjectURL(blob));
        setRecState("stopped");
        tryStopTracks();
      };

      startedAtRef.current = Date.now();
      setRecState("recording");
      mr.start(250);
    } catch (e: any) {
      tryStopTracks();
      setRecState("idle");
      setErr(
        e?.name === "NotAllowedError"
          ? "Brak zgody na mikrofon w przeglądarce."
          : e?.message ?? "Nie udało się uruchomić nagrywania."
      );
    }
  }

  async function pauseRecording() {
    setErr("");
    setOkMsg("");

    const mr = mediaRecorderRef.current;
    if (!mr) return;

    try {
      if (mr.state === "recording") {
        mr.pause();
        elapsedBeforePauseRef.current += Date.now() - startedAtRef.current;
        setElapsedMs(elapsedBeforePauseRef.current);
        setRecState("paused");
      }
    } catch (e: any) {
      setErr(e?.message ?? "Nie udało się wstrzymać nagrywania.");
    }
  }

  async function resumeRecording() {
    setErr("");
    setOkMsg("");

    const mr = mediaRecorderRef.current;
    if (!mr) return;

    try {
      if (mr.state === "paused") {
        mr.resume();
        startedAtRef.current = Date.now();
        setRecState("recording");
      }
    } catch (e: any) {
      setErr(e?.message ?? "Nie udało się wznowić nagrywania.");
    }
  }

  async function stopRecording() {
    setErr("");
    setOkMsg("");

    const mr = mediaRecorderRef.current;
    if (!mr) return;

    try {
      if (recState === "recording") {
        elapsedBeforePauseRef.current += Date.now() - startedAtRef.current;
      }
      setElapsedMs(elapsedBeforePauseRef.current);

      if (mr.state !== "inactive") mr.stop();
      mediaRecorderRef.current = null;
    } catch (e: any) {
      setErr(e?.message ?? "Nie udało się zatrzymać nagrywania.");
    }
  }

  async function saveRecordingLocal() {
    setErr("");
    setOkMsg("");

    if (!recordedBlob) {
      setErr("Brak nagrania do zapisania.");
      return;
    }
    if (!examRef || !patientIdFromParams || !examId) {
      setErr("Brak parametrów ścieżki (patientId/examId).");
      return;
    }
    if (!clinicId) {
      setErr("Brak clinicId (spróbuj odświeżyć stronę).");
      return;
    }

    setSavingAudio(true);
    try {
      const form = new FormData();
      form.append("file", recordedBlob, "recording.webm");
      form.append("clinicId", clinicId);
      form.append("patientId", patientIdFromParams);
      form.append("examId", examId);
      form.append("durationMs", String(elapsedMs));

      const res = await fetch("/api/recordings", { method: "POST", body: form });
      const parsed = await readJsonOrText(res);
      const json = (parsed.kind === "json" ? parsed.json : null) as any;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 400)}`);
      }

      await updateDoc(examRef, {
        recording: {
          storage: "local",
          localPath: json.relativePath,
          absolutePath: json.absolutePath,
          durationMs: elapsedMs,
          mimeType: recordedBlob.type || recordedMime,
          size: recordedBlob.size,
          savedAt: serverTimestamp(),
          expiresAt: addDaysISO(30),
        },
        updatedAt: serverTimestamp(),
        status: "in_progress",
      });

      await load();

      // reset po zapisie
      setRecState("idle");
      setElapsedMs(0);
      setRecordedBlob(null);
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      setRecordedUrl("");
      chunksRef.current = [];
      elapsedBeforePauseRef.current = 0;

      setOkMsg("✅ Nagranie zapisane lokalnie i podpięte do badania.");
    } catch (e: any) {
      setErr(e?.message || "Błąd zapisu");
      setOkMsg("");
    } finally {
      setSavingAudio(false);
    }
  }

  async function transcribeNow() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }
    if (!hasLocalRecording) {
      setErr("Brak lokalnego nagrania do transkrypcji (localPath).");
      return;
    }

    setTranscribing(true);
    try {
      const res = await fetch("/api/exams/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: patientIdFromParams, examId }),
      });

      const parsed = await readJsonOrText(res);
      const json = (parsed.kind === "json" ? parsed.json : null) as any;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 400)}`);
      }

      await load();
      setOkMsg("✅ Transkrypcja gotowa");
    } catch (e: any) {
      setErr(e?.message || "Błąd transkrypcji");
      setOkMsg("");
    } finally {
      setTranscribing(false);
    }
  }

  async function analyzeNow() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }

    // UWAGA: nie blokuj się na exam?.transcript ze starego state
    const fresh = await fetchFreshExam();
    if (!fresh?.transcript || !fresh.transcript.trim()) {
      setErr("Brak transkrypcji — analiza wymaga transkrypcji.");
      return;
    }

    const cid = getCidFromStateOrExam(fresh);

    const res = await fetch("/api/exams/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clinicId: cid, patientId: patientIdFromParams, examId }),
    });

    const parsed = await readJsonOrText(res);
    const json = (parsed.kind === "json" ? parsed.json : null) as any;

    if (!res.ok || !json?.ok) {
      throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 400)}`);
    }

    await load();
  }

  async function generateReportNow() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }

    setGeneratingReport(true);
    try {
      // bierz fresh (unikasz problemu “1 klik nic / 2 klik działa”)
      const fresh = await fetchFreshExam();
      const cid = getCidFromStateOrExam(fresh);

      const res = await fetch("/api/exams/generate-report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ clinicId: cid, patientId: patientIdFromParams, examId }),
      });

      const parsed = await readJsonOrText(res);
      const json = (parsed.kind === "json" ? parsed.json : null) as any;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 800)}`);
      }

      // Backend może zwracać reportPreview (Twoja wersja) albo report (jeśli dodasz)
      const maybeReport =
        (typeof json?.report === "string" && json.report.trim() ? json.report : "") ||
        (typeof json?.reportPreview === "string" && json.reportPreview.trim() ? json.reportPreview : "");

      if (maybeReport) {
        setReportDraft(maybeReport);

        // kluczowe: ustaw ref natychmiast, zanim zrobimy load()
        reportDirtyRef.current = true;
        setReportDirty(true); // (stan UI)
      }

      await load();
      setOkMsg("✅ Raport wygenerowany");
    } catch (e: any) {
      setErr(e?.message || "Błąd generowania raportu");
      setOkMsg("");
    } finally {
      setGeneratingReport(false);
    }
  }

  async function runAutoReportPipeline() {
    setErr("");
    setOkMsg("");
    setPipelineMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }

    try {
      let fresh = await fetchFreshExam();
      if (!fresh) throw new Error("Brak badania (nie znaleziono dokumentu w Firestore).");

      // 1) Transkrypcja (jeśli brak)
      if (!fresh.transcript || !fresh.transcript.trim()) {
        if (!fresh.recording?.localPath) {
          throw new Error("Brak transkrypcji i brak lokalnego nagrania (recording.localPath) — nie da się kontynuować.");
        }

        setPipelineStep("transcribing");
        setTranscribing(true);

        const res = await fetch("/api/exams/transcribe", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ patientId: patientIdFromParams, examId }),
        });

        const parsed = await readJsonOrText(res);
        const json = (parsed.kind === "json" ? parsed.json : null) as any;

        if (!res.ok || !json?.ok) {
          throw new Error(json?.error || `Transkrypcja: HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 400)}`);
        }

        await load();
        fresh = await fetchFreshExam();
        if (!fresh?.transcript || !fresh.transcript.trim()) {
          throw new Error("Transkrypcja nie została zapisana (sprawdź /api/exams/transcribe oraz logi serwera).");
        }
      }

      // 2) Analiza LLM (jeśli brak)
      if (!fresh.analysis?.sections) {
        setPipelineStep("analyzing");
        await analyzeNow();

        fresh = await fetchFreshExam();
        if (!fresh?.analysis?.sections) {
          throw new Error("Analiza nie została zapisana (sprawdź /api/exams/analyze).");
        }
      }

      // 3) Raport
      setPipelineStep("generating");
      await generateReportNow();

      // Final refresh (dla kompletności)
      await load();

      setPipelineStep("done");
      setPipelineMsg("Gotowe ✅");
    } catch (e: any) {
      setPipelineStep("error");
      setPipelineMsg(e?.message || "Błąd pipeline");
      setErr(e?.message || "Błąd pipeline");
      setOkMsg("");
    } finally {
      setTranscribing(false);
    }
  }

  async function saveReport() {
    setErr("");
    setOkMsg("");

    if (!examRef) {
      setErr("Brak referencji do badania.");
      return;
    }

    setSavingReport(true);
    try {
      await updateDoc(examRef, {
        report: reportDraft,
        updatedAt: serverTimestamp(),
      });

      // po zapisie raport nie jest “dirty”
      reportDirtyRef.current = false;
      setReportDirty(false);

      await load();
      setOkMsg("✅ Raport zapisany");
    } catch (e: any) {
      setErr(e?.message || "Błąd zapisu raportu");
      setOkMsg("");
    } finally {
      setSavingReport(false);
    }
  }

  async function setInProgress() {
    setErr("");
    setOkMsg("");
    if (!examRef) return;

    try {
      await updateDoc(examRef, {
        status: "in_progress",
        updatedAt: serverTimestamp(),
      });
      await load();
      setOkMsg("✅ Status ustawiony na: W trakcie");
    } catch (e: any) {
      setErr(e?.message || "Nie udało się zmienić statusu badania.");
    }
  }

  if (loading) return <div className="p-6">Ładowanie…</div>;
  if (!exam) return <div className="p-6">Brak badania</div>;

  const uiLocked =
    savingAudio ||
    transcribing ||
    generatingReport ||
    savingReport ||
    (pipelineStep !== "idle" && pipelineStep !== "done" && pipelineStep !== "error");

  const canStart = canRecord && !uiLocked && recState === "idle";
  const canPause = canRecord && !uiLocked && recState === "recording";
  const canResume = canRecord && !uiLocked && recState === "paused";
  const canStop = canRecord && !uiLocked && (recState === "recording" || recState === "paused");
  const canSave = !!recordedBlob && !uiLocked;

  const backPid = exam?.patientId || patientIdFromParams;

  return (
    <div className="p-6 space-y-6">
      {err && <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">{err}</div>}
      {okMsg && <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">{okMsg}</div>}

      {/* HEADER */}
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xl font-semibold">{typeLabel(exam.type)}</div>
          <div className="mt-1 text-sm opacity-70">
            Patient: <span className="font-mono">{patientIdFromParams}</span> • Exam:{" "}
            <span className="font-mono">{examId}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full border px-3 py-1 text-xs">{statusLabel(exam.status)}</span>

          {exam.status !== "in_progress" && (
            <button className="rounded-lg border px-3 py-2 text-sm" onClick={setInProgress} title="Odblokowuje nagrywanie">
              Ustaw: W trakcie
            </button>
          )}

          <button
            className="rounded-lg border px-3 py-2 text-sm"
            onClick={() => {
              if (!backPid) {
                setErr("Nie mogę wrócić — brak patientId.");
                return;
              }
              router.push(`/patients/${backPid}`);
            }}
          >
            Wróć do pacjenta
          </button>
        </div>
      </div>

      {/* NAGRYWANIE */}
      <section className="rounded-2xl border p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold">Nagrywanie</div>
          <div className="text-sm font-mono">{fmtMs(elapsedMs)}</div>
        </div>

        {!canRecord && (
          <div className="text-xs opacity-70">
            Nagrywanie dostępne tylko dla statusu: <b>W trakcie</b>.
          </div>
        )}

        <div className="flex flex-wrap gap-2 items-center">
          <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={!canStart} onClick={startRecording}>
            Start
          </button>

          <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={!canPause} onClick={pauseRecording}>
            Pauza
          </button>

          <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={!canResume} onClick={resumeRecording}>
            Wznów
          </button>

          <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={!canStop} onClick={stopRecording}>
            Stop
          </button>
        </div>

        {recordedUrl && (
          <div className="space-y-2">
            <div className="text-xs opacity-70">Podgląd lokalny (po Stop):</div>
            <audio controls src={recordedUrl} className="w-full" />
            <div className="text-xs opacity-70">
              MIME: <span className="font-mono">{recordedMime}</span> • Rozmiar:{" "}
              <span className="font-mono">{recordedBlob?.size ?? 0}</span> B
            </div>
          </div>
        )}

        <div className="pt-2">
          <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" disabled={!canSave} onClick={saveRecordingLocal}>
            {savingAudio ? "Zapisuję lokalnie…" : "Zapisz nagranie (lokalnie)"}
          </button>
        </div>
      </section>

      {/* NAGRANIE LOKALNE */}
      {hasLocalRecording && (
        <section className="rounded-2xl border p-4 space-y-4">
          <div className="text-sm font-semibold">Nagranie zapisane lokalnie</div>

          <audio controls className="w-full" src={`/api/recordings/file?path=${encodeURIComponent(exam.recording!.localPath!)}`} />

          <div className="rounded-lg border p-3 text-xs space-y-1">
            <div>
              Path: <span className="font-mono break-all">{exam.recording!.localPath}</span>
            </div>
            {exam.recording?.expiresAt && (
              <div>
                Retencja do: <span className="font-mono">{String(exam.recording.expiresAt)}</span>
              </div>
            )}
          </div>
        </section>
      )}

      {/* TRANSKRYPCJA */}
      {(hasLocalRecording || hasTranscript) && (
        <section className="rounded-2xl border p-4 space-y-4">
          <div className="text-sm font-semibold">Transkrypcja</div>

          <div className="flex items-center gap-2">
            <button className="rounded-lg border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setShowRaw(false)} disabled={!exam.transcript}>
              Czyste
            </button>

            <button className="rounded-lg border px-3 py-1 text-xs disabled:opacity-50" onClick={() => setShowRaw(true)} disabled={!exam.transcriptRaw}>
              Surowe
            </button>
          </div>

          {hasLocalRecording && (
            <div className="flex flex-wrap gap-2 items-center">
              <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={transcribeNow} disabled={uiLocked}>
                {transcribing ? "Transkrybuję…" : "Transkrybuj"}
              </button>
            </div>
          )}

          {transcriptToShow ? (
            <pre className="whitespace-pre-wrap rounded-lg border p-3 text-xs">{transcriptToShow}</pre>
          ) : (
            <div className="text-sm opacity-70">Brak transkrypcji — kliknij „Transkrybuj”.</div>
          )}
        </section>
      )}

      {/* RAPORT */}
      <section className="rounded-2xl border p-4 space-y-4">
        <div className="text-sm font-semibold">Raport</div>

        <div className="flex flex-wrap gap-2 items-center">
          <button
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            onClick={runAutoReportPipeline}
            disabled={uiLocked || (!hasLocalRecording && !exam?.transcript && !exam?.analysis?.sections)}
            title={!hasLocalRecording && !exam?.transcript && !exam?.analysis?.sections ? "Najpierw nagraj i zapisz nagranie lokalnie" : ""}
          >
            {pipelineStep !== "idle" && pipelineStep !== "done" && pipelineStep !== "error"
              ? pipelineLabel(pipelineStep)
              : "Generuj raport"}
          </button>

          <button className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50" onClick={saveReport} disabled={uiLocked}>
            {savingReport ? "Zapisuję…" : "Zapisz"}
          </button>

          <button
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            onClick={transcribeNow}
            disabled={uiLocked || !hasLocalRecording}
            title={!hasLocalRecording ? "Brak lokalnego nagrania" : "Wymusza ponowną transkrypcję"}
          >
            Wymuś transkrypcję
          </button>

          <button
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            onClick={analyzeNow}
            disabled={uiLocked || !exam?.transcript}
            title={!exam?.transcript ? "Brak transkrypcji" : "Wymusza ponowną analizę LLM"}
          >
            Wymuś analizę
          </button>
        </div>

        <div className="text-xs opacity-80">
          <span className="font-semibold">Pipeline:</span> {pipelineLabel(pipelineStep)}
          {pipelineMsg ? ` — ${pipelineMsg}` : ""}
        </div>

        {hasAnyAnalysis && (
          <div className="rounded-lg border p-3 text-xs space-y-1">
            <div className="font-semibold">Kompletność (LLM):</div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border px-2 py-0.5">Powód: {missing?.reason ? "❌" : "✅"}</span>
              <span className="rounded-full border px-2 py-0.5">Opis: {missing?.findings ? "❌" : "✅"}</span>
              <span className="rounded-full border px-2 py-0.5">Wnioski: {missing?.conclusions ? "❌" : "✅"}</span>
              <span className="rounded-full border px-2 py-0.5">Zalecenia: {missing?.recommendations ? "❌" : "✅"}</span>
            </div>
          </div>
        )}

        <textarea
          className="w-full rounded-lg border p-3 text-sm min-h-[240px]"
          value={reportDraft}
          onChange={(e) => {
            setReportDraft(e.target.value);
            reportDirtyRef.current = true;
            setReportDirty(true);
          }}
          placeholder="Tu pojawi się raport. Możesz go edytować ręcznie."
        />
      </section>
    </div>
  );
}

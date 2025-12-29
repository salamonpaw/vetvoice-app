"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import { doc, getDoc, serverTimestamp, updateDoc } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

type ExamStatus = "draft" | "in_progress" | "done";

type TranscriptQuality = {
  score: number; // 0..100
  flags: string[];
  metrics?: any;
};

type ExamDoc = {
  clinicId: string;
  patientId: string;
  type: string;
  status: ExamStatus;
  createdAt?: any;
  updatedAt?: any;

  transcript?: string;
  transcriptRaw?: string;

  transcriptQuality?: TranscriptQuality;

  transcriptMeta?: {
    modelUsed?: string;
    language?: string;
    engine?: string;

    audioLocalPath?: string;
    audioWasPreprocessed?: boolean;

    qualityScore?: number;
    qualityFlags?: string[];

    [k: string]: any;
  };

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

    preprocessedLocalPath?: string;
    preprocessMeta?: any;

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
      return "Analiza…";
    case "generating":
      return "Raport…";
    case "done":
      return "Gotowe ✅";
    case "error":
      return "Błąd ❌";
  }
}

function tone(kind: "neutral" | "ok" | "warn" | "bad") {
  switch (kind) {
    case "ok":
      return "border-green-200 bg-green-50 text-green-800";
    case "warn":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "bad":
      return "border-red-200 bg-red-50 text-red-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function stepTone(done: boolean, active: boolean, blocked: boolean) {
  if (done) return tone("ok");
  if (active) return tone("warn");
  if (blocked) return tone("bad");
  return tone("neutral");
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

  // NEW: preprocessing state
  const [preprocessing, setPreprocessing] = useState(false);

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

  // Import nagrania
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importRunPipeline, setImportRunPipeline] = useState(false);

  const examRef = useMemo(() => {
    if (!patientIdFromParams || !examId) return null;
    return doc(db, "patients", patientIdFromParams, "exams", examId);
  }, [patientIdFromParams, examId]);

  const hasLocalRecording = !!exam?.recording?.localPath;
  const hasTranscript = !!exam?.transcript;
  const transcriptToShow = showRaw ? exam?.transcriptRaw : exam?.transcript;

  const missing = exam?.analysisMissing;
  const hasAnyAnalysis = !!exam?.analysis?.sections || !!exam?.analysisMissing;

  // NEW: quality from either transcriptQuality or transcriptMeta fallback
  const qualityScore =
    typeof exam?.transcriptQuality?.score === "number"
      ? exam.transcriptQuality.score
      : typeof exam?.transcriptMeta?.qualityScore === "number"
      ? exam.transcriptMeta.qualityScore
      : null;

  const qualityFlags =
    (Array.isArray(exam?.transcriptQuality?.flags) && exam!.transcriptQuality!.flags) ||
    (Array.isArray(exam?.transcriptMeta?.qualityFlags) && exam!.transcriptMeta!.qualityFlags) ||
    [];

  const isQualityLow = typeof qualityScore === "number" && qualityScore < 75;
  const wasPreprocessed = Boolean(exam?.transcriptMeta?.audioWasPreprocessed);

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

  async function ensureInProgressBeforeRecording() {
    if (!examRef) return;

    if (exam?.status !== "in_progress") {
      await updateDoc(examRef, {
        status: "in_progress",
        updatedAt: serverTimestamp(),
      });
      const fresh = await fetchFreshExam();
      if (fresh) setExam(fresh);
    }
  }

  async function startRecording() {
    setErr("");
    setOkMsg("");

    if (!examRef) {
      setErr("Brak referencji do badania.");
      return;
    }

    try {
      await ensureInProgressBeforeRecording();
    } catch (e: any) {
      setErr(e?.message || "Nie udało się ustawić badania jako: W trakcie.");
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

      setRecState("idle");
      setElapsedMs(0);
      setRecordedBlob(null);
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
      setRecordedUrl("");
      chunksRef.current = [];
      elapsedBeforePauseRef.current = 0;

      setOkMsg("✅ Nagranie zapisane.");
    } catch (e: any) {
      setErr(e?.message || "Błąd zapisu");
      setOkMsg("");
    } finally {
      setSavingAudio(false);
    }
  }

  async function importRecordingFile() {
    setErr("");
    setOkMsg("");

    if (!importFile) {
      setErr("Wybierz plik audio do importu.");
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

    // blokujemy w trakcie innych akcji
    if (importing || savingAudio || transcribing || generatingReport || savingReport) return;

    setImporting(true);
    try {
      await ensureInProgressBeforeRecording();

      const form = new FormData();
      form.append("file", importFile, importFile.name || "import-audio");
      form.append("clinicId", clinicId);
      form.append("patientId", patientIdFromParams);
      form.append("examId", examId);
      // nie znamy durationMs przy imporcie bez dekodowania audio — zostawiamy 0
      form.append("durationMs", "0");

      const res = await fetch("/api/recordings", { method: "POST", body: form });
      const parsed = await readJsonOrText(res);
      const json = (parsed.kind === "json" ? parsed.json : null) as any;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 800)}`);
      }

      await updateDoc(examRef, {
        recording: {
          storage: "local",
          localPath: json.relativePath,
          absolutePath: json.absolutePath,
          durationMs: 0,
          mimeType: importFile.type || json.mimeType || "application/octet-stream",
          size: importFile.size,
          savedAt: serverTimestamp(),
          expiresAt: addDaysISO(30),
        },
        updatedAt: serverTimestamp(),
        status: "in_progress",
      });

      setImportFile(null);

      await load();
      setOkMsg("✅ Nagranie zaimportowane.");

      if (importRunPipeline) {
        await runAutoReportPipeline();
      }
    } catch (e: any) {
      setErr(e?.message || "Błąd importu nagrania");
      setOkMsg("");
    } finally {
      setImporting(false);
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

  async function preprocessAndRetranscribe() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }
    if (!hasLocalRecording) {
      setErr("Brak lokalnego nagrania do preprocessingu (recording.localPath).");
      return;
    }

    if (importing || savingAudio || transcribing || generatingReport || savingReport) return;

    setPreprocessing(true);
    try {
      // 1) preprocess audio
      const pRes = await fetch("/api/exams/preprocess-audio", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ patientId: patientIdFromParams, examId }),
      });

      const pParsed = await readJsonOrText(pRes);
      const pJson = (pParsed.kind === "json" ? pParsed.json : null) as any;

      if (!pRes.ok || !pJson?.ok) {
        throw new Error(
          pJson?.error ||
            `Preprocess: HTTP ${pRes.status} ${pRes.statusText}\n${pParsed.text.slice(0, 800)}`
        );
      }

      // 2) transcribe using preprocessed
      const tRes = await fetch("/api/exams/transcribe", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          patientId: patientIdFromParams,
          examId,
          usePreprocessed: true,
        }),
      });

      const tParsed = await readJsonOrText(tRes);
      const tJson = (tParsed.kind === "json" ? tParsed.json : null) as any;

      if (!tRes.ok || !tJson?.ok) {
        throw new Error(
          tJson?.error ||
            `Transkrypcja: HTTP ${tRes.status} ${tRes.statusText}\n${tParsed.text.slice(0, 800)}`
        );
      }

      await load();
      setOkMsg("✅ Oczyszczono nagranie i wykonano ponowną transkrypcję.");
    } catch (e: any) {
      setErr(e?.message || "Błąd preprocessingu/transkrypcji");
      setOkMsg("");
    } finally {
      setPreprocessing(false);
    }
  }

  async function analyzeNow() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }

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
    setOkMsg("✅ Analiza gotowa");
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

      const maybeReport =
        (typeof json?.report === "string" && json.report.trim() ? json.report : "") ||
        (typeof json?.reportPreview === "string" && json.reportPreview.trim() ? json.reportPreview : "");

      if (maybeReport) {
        setReportDraft(maybeReport);
        reportDirtyRef.current = true;
        setReportDirty(true);
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

      if (!fresh.transcript || !fresh.transcript.trim()) {
        if (!fresh.recording?.localPath) {
          throw new Error("Brak transkrypcji i brak lokalnego nagrania (recording.localPath).");
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
          throw new Error("Transkrypcja nie została zapisana (sprawdź /api/exams/transcribe).");
        }
      }

      if (!fresh.analysis?.sections) {
        setPipelineStep("analyzing");
        await analyzeNow();

        fresh = await fetchFreshExam();
        if (!fresh?.analysis?.sections) {
          throw new Error("Analiza nie została zapisana (sprawdź /api/exams/analyze).");
        }
      }

      setPipelineStep("generating");
      await generateReportNow();

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

  if (loading) return <div className="p-6">Ładowanie…</div>;
  if (!exam) return <div className="p-6">Brak badania</div>;

  const uiLocked =
    savingAudio ||
    transcribing ||
    generatingReport ||
    savingReport ||
    importing ||
    preprocessing ||
    (pipelineStep !== "idle" && pipelineStep !== "done" && pipelineStep !== "error");

  const canStart = !uiLocked && recState === "idle";
  const canPause = !uiLocked && recState === "recording";
  const canResume = !uiLocked && recState === "paused";
  const canStop = !uiLocked && (recState === "recording" || recState === "paused");
  const canSave = !!recordedBlob && !uiLocked;

  const backPid = exam?.patientId || patientIdFromParams;

  // quiet stepper states
  const stepRecordingDone = !!exam?.recording?.localPath;
  const stepTranscriptDone = !!exam?.transcript?.trim();
  const stepAnalysisDone = !!exam?.analysis?.sections;
  const stepReportDone = !!exam?.report?.trim() || (!!reportDraft.trim() && reportDirtyRef.current);

  const activeRec = recState === "recording" || recState === "paused";
  const activeTranscribe = pipelineStep === "transcribing" || transcribing;
  const activeAnalyze = pipelineStep === "analyzing";
  const activeReport = pipelineStep === "generating" || generatingReport;

  const transBlocked = !stepRecordingDone;
  const analyzeBlocked = !stepTranscriptDone;
  const reportBlocked = !stepAnalysisDone;

  const pipelineTone =
    pipelineStep === "error"
      ? tone("bad")
      : pipelineStep === "done"
      ? tone("ok")
      : pipelineStep === "idle"
      ? tone("neutral")
      : tone("warn");

  const qualityTone =
    typeof qualityScore === "number"
      ? qualityScore < 60
        ? tone("bad")
        : qualityScore < 75
        ? tone("warn")
        : tone("ok")
      : tone("neutral");

  return (
    <div className="space-y-5">
      {/* Alerts */}
      {(err || okMsg) && (
        <div className="space-y-2">
          {err && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <div className="font-semibold">Błąd</div>
              <div className="mt-1 whitespace-pre-wrap">{err}</div>
              {pipelineMsg ? <div className="mt-2 text-xs text-red-700">Pipeline: {pipelineMsg}</div> : null}
            </div>
          )}
          {okMsg && (
            <div className="rounded-2xl border border-green-200 bg-green-50 p-3 text-sm text-green-900">
              <div className="font-semibold">OK</div>
              <div className="mt-1 whitespace-pre-wrap">{okMsg}</div>
            </div>
          )}
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <div className="text-xl font-semibold tracking-tight">{typeLabel(exam.type)}</div>
          <div className="mt-1 text-xs text-slate-500">
            Patient: <span className="font-mono">{patientIdFromParams}</span> • Exam: <span className="font-mono">{examId}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-xs ${tone(exam.status === "done" ? "ok" : "neutral")}`}>
            Status: {exam.status === "draft" ? "Szkic" : exam.status === "in_progress" ? "W trakcie" : "Zakończone"}
          </span>

          <button
            className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50"
            onClick={() => {
              if (!backPid) {
                setErr("Nie mogę wrócić — brak patientId.");
                return;
              }
              router.push(`/patients/${backPid}`);
            }}
          >
            Wróć
          </button>
        </div>
      </div>

      {/* Quiet Stepper */}
      <div className="rounded-2xl border border-slate-200 bg-white px-4 py-3 shadow-sm">
        <div className="flex flex-wrap items-center gap-2">
          <span className={`rounded-full border px-2.5 py-1 text-xs ${stepTone(stepRecordingDone, activeRec, false)}`}>Nagranie</span>
          <span className={`rounded-full border px-2.5 py-1 text-xs ${stepTone(stepTranscriptDone, activeTranscribe, transBlocked)}`}>Transkrypcja</span>
          <span className={`rounded-full border px-2.5 py-1 text-xs ${stepTone(stepAnalysisDone, activeAnalyze, analyzeBlocked)}`}>Analiza</span>
          <span className={`rounded-full border px-2.5 py-1 text-xs ${stepTone(stepReportDone, activeReport, reportBlocked)}`}>Raport</span>

          {hasAnyAnalysis && (
            <div className="ml-1 flex flex-wrap items-center gap-1 text-xs text-slate-500">
              <span className="ml-1">• Kompletność:</span>
              <span className={`rounded-full border px-2 py-0.5 ${missing?.reason ? tone("bad") : tone("ok")}`}>Powód</span>
              <span className={`rounded-full border px-2 py-0.5 ${missing?.findings ? tone("bad") : tone("ok")}`}>Opis</span>
              <span className={`rounded-full border px-2 py-0.5 ${missing?.conclusions ? tone("bad") : tone("ok")}`}>Wnioski</span>
              <span className={`rounded-full border px-2 py-0.5 ${missing?.recommendations ? tone("bad") : tone("ok")}`}>Zalecenia</span>
            </div>
          )}
        </div>
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-5">
        {/* Left: one Process card */}
        <div className="lg:col-span-2">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-5">
            <div className="flex items-start justify-between gap-3">
              <div>
                <div className="text-sm font-semibold">Proces</div>
                <div className="mt-1 text-xs text-slate-500">Nagranie → transkrypcja → analiza → raport</div>
              </div>

              <button
                className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                onClick={runAutoReportPipeline}
                disabled={uiLocked || (!hasLocalRecording && !exam?.transcript && !exam?.analysis?.sections)}
                title={!hasLocalRecording && !exam?.transcript && !exam?.analysis?.sections ? "Najpierw dodaj nagranie" : ""}
              >
                {pipelineStep !== "idle" && pipelineStep !== "done" && pipelineStep !== "error"
                  ? pipelineLabel(pipelineStep)
                  : "Generuj raport"}
              </button>
            </div>

            {/* Recording */}
            <div className="space-y-3">
              <div className="flex items-center justify-between">
                <div className="text-sm font-semibold">Nagrywanie</div>
                <div className="text-sm font-mono text-slate-700">{fmtMs(elapsedMs)}</div>
              </div>

              <div className="flex flex-wrap gap-2 items-center">
                <button
                  className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                  disabled={!canStart}
                  onClick={startRecording}
                >
                  Start
                </button>

                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                  disabled={!canPause}
                  onClick={pauseRecording}
                >
                  Pauza
                </button>

                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                  disabled={!canResume}
                  onClick={resumeRecording}
                >
                  Wznów
                </button>

                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                  disabled={!canStop}
                  onClick={stopRecording}
                >
                  Stop
                </button>
              </div>

              {recordedUrl && (
                <div className="space-y-2">
                  <audio controls src={recordedUrl} className="w-full" />
                  <div className="text-xs text-slate-500">
                    MIME: <span className="font-mono">{recordedMime}</span> • Rozmiar:{" "}
                    <span className="font-mono">{recordedBlob?.size ?? 0}</span> B
                  </div>
                </div>
              )}

              <div className="pt-1">
                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                  disabled={!canSave}
                  onClick={saveRecordingLocal}
                >
                  {savingAudio ? "Zapisuję…" : "Zapisz nagranie"}
                </button>
                <div className="mt-2 text-xs text-slate-500">Zapis lokalny jest wymagany do transkrypcji (localPath).</div>
              </div>
            </div>

            {/* Import */}
            <div className="space-y-3">
              <div className="text-sm font-semibold">Import nagrania</div>
              <div className="text-xs text-slate-500">
                Wgraj gotowy plik audio (mp3, m4a, wav, ogg, webm). Zostanie zapisany lokalnie i podpięty do badania.
              </div>

              <div className="grid gap-2">
                <input
                  type="file"
                  accept="audio/*"
                  disabled={uiLocked}
                  onChange={(e) => {
                    const f = e.target.files?.[0] || null;
                    setImportFile(f);
                  }}
                  className="block w-full text-sm file:mr-3 file:rounded-xl file:border file:border-slate-200 file:bg-white file:px-3 file:py-2 file:text-sm file:hover:bg-slate-50"
                />

                <label className="flex items-center gap-2 text-sm text-slate-700 select-none">
                  <input
                    type="checkbox"
                    checked={importRunPipeline}
                    onChange={(e) => setImportRunPipeline(e.target.checked)}
                    disabled={uiLocked}
                  />
                  Po imporcie uruchom pipeline (transkrypcja → analiza → raport)
                </label>

                <div className="flex items-center gap-2">
                  <button
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    disabled={uiLocked || !importFile}
                    onClick={importRecordingFile}
                  >
                    {importing ? "Importuję…" : "Wgraj do badania"}
                  </button>

                  {importFile ? (
                    <div className="text-xs text-slate-500 truncate">
                      Wybrano: <span className="font-mono">{importFile.name}</span> • {Math.round(importFile.size / 1024)} KB
                    </div>
                  ) : (
                    <div className="text-xs text-slate-500">Nie wybrano pliku</div>
                  )}
                </div>
              </div>
            </div>

            {/* Local file */}
            {hasLocalRecording && (
              <div className="space-y-2">
                <div className="text-sm font-semibold">Plik nagrania</div>
                <audio
                  controls
                  className="w-full"
                  src={`/api/recordings/file?path=${encodeURIComponent(exam.recording!.localPath!)}`}
                />
                <div className="rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs">
                  <div>
                    Path: <span className="font-mono break-all">{exam.recording!.localPath}</span>
                  </div>

                  {exam.recording?.preprocessedLocalPath ? (
                    <div className="mt-2">
                      Clean: <span className="font-mono break-all">{exam.recording.preprocessedLocalPath}</span>
                    </div>
                  ) : null}
                </div>
              </div>
            )}

            {/* Transcript */}
            {(hasLocalRecording || hasTranscript) && (
              <div className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <div className="text-sm font-semibold">Transkrypcja</div>

                  <div className="flex items-center gap-1.5">
                    <button
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        !showRaw ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                      }`}
                      onClick={() => setShowRaw(false)}
                      disabled={!exam.transcript}
                      type="button"
                    >
                      Czyste
                    </button>
                    <button
                      className={`rounded-full border px-2 py-0.5 text-xs ${
                        showRaw ? "bg-slate-900 text-white border-slate-900" : "bg-white text-slate-700 border-slate-200"
                      }`}
                      onClick={() => setShowRaw(true)}
                      disabled={!exam.transcriptRaw}
                      type="button"
                    >
                      Surowe
                    </button>
                  </div>
                </div>

                <div className="flex flex-wrap gap-2 items-center">
                  <button
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    onClick={transcribeNow}
                    disabled={uiLocked || !hasLocalRecording}
                    title={!hasLocalRecording ? "Brak lokalnego nagrania" : ""}
                  >
                    {transcribing ? "Transkrybuję…" : "Transkrybuj"}
                  </button>

                  <button
                    className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                    onClick={analyzeNow}
                    disabled={uiLocked || !exam?.transcript}
                    title={!exam?.transcript ? "Brak transkrypcji" : ""}
                  >
                    Analizuj
                  </button>

                  {typeof qualityScore === "number" && (
                    <span
                      className={`rounded-full border px-2.5 py-1 text-xs ${qualityTone}`}
                      title={qualityFlags.length ? `Flagi: ${qualityFlags.join(", ")}` : ""}
                    >
                      Jakość: {qualityScore}/100{wasPreprocessed ? " • po czyszczeniu" : ""}
                    </span>
                  )}

                  {isQualityLow && (
                    <button
                      className="rounded-xl bg-slate-900 px-3 py-2 text-sm text-white hover:bg-slate-800 disabled:opacity-50"
                      disabled={uiLocked || preprocessing || !hasLocalRecording}
                      onClick={preprocessAndRetranscribe}
                      title="Odszumianie + normalizacja głośności + ponowna transkrypcja"
                    >
                      {preprocessing ? "Oczyszczam…" : "Oczyść i ponów"}
                    </button>
                  )}

                  <span className={`ml-auto rounded-full border px-2.5 py-1 text-xs ${pipelineTone}`}>
                    Pipeline: {pipelineLabel(pipelineStep)}
                  </span>
                </div>

                {transcriptToShow ? (
                  <pre className="whitespace-pre-wrap rounded-xl border border-slate-200 bg-slate-50 p-3 text-xs max-h-[280px] overflow-auto">
                    {transcriptToShow}
                  </pre>
                ) : (
                  <div className="text-sm text-slate-500">Brak transkrypcji — kliknij „Transkrybuj”.</div>
                )}
              </div>
            )}
          </section>
        </div>

        {/* Right: Report */}
        <div className="lg:col-span-3">
          <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-md space-y-3">
            <div className="flex items-center justify-between gap-2">
              <div>
                <div className="text-sm font-semibold">Raport</div>
                <div className="mt-1 text-xs text-slate-500">Edytuj ręcznie i zapisz do badania.</div>
              </div>

              <div className="flex items-center gap-2">
                <span className={`rounded-full border px-2.5 py-1 text-xs ${pipelineTone}`}>{pipelineLabel(pipelineStep)}</span>

                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                  onClick={saveReport}
                  disabled={uiLocked}
                >
                  {savingReport ? "Zapisuję…" : "Zapisz"}
                </button>

                <button
                  className="rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm hover:bg-slate-50 disabled:opacity-50"
                  onClick={generateReportNow}
                  disabled={uiLocked}
                  title="Generuj raport z aktualnej analizy"
                >
                  {generatingReport ? "Generuję…" : "Odśwież"}
                </button>
              </div>
            </div>

            <textarea
              className="w-full rounded-xl border border-slate-200 bg-white p-3 text-sm min-h-[460px] focus:outline-none focus:ring-2 focus:ring-slate-200"
              value={reportDraft}
              onChange={(e) => {
                setReportDraft(e.target.value);
                reportDirtyRef.current = true;
                setReportDirty(true);
              }}
              placeholder="Tu pojawi się raport. Możesz go edytować ręcznie."
            />

            <div className="text-xs text-slate-500 flex items-center justify-between">
              <span>{reportDirty ? "Masz niezapisane zmiany." : "—"}</span>
              <span className="font-mono">{reportDraft.length} znaków</span>
            </div>
          </section>
        </div>
      </div>
    </div>
  );
}

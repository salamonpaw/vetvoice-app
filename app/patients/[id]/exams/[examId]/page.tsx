"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useParams, useRouter } from "next/navigation";

import {
  Alert,
  Box,
  Checkbox,
  Chip,
  FormControlLabel,
  Grid,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";
import SectionCard from "@/app/_components/SectionCard";
import { PrimaryButton, SecondaryButton } from "@/app/_components/Buttons";
import AutoAwesomeOutlinedIcon from "@mui/icons-material/AutoAwesomeOutlined";
import DescriptionOutlinedIcon from "@mui/icons-material/DescriptionOutlined";
import MicOutlinedIcon from "@mui/icons-material/MicOutlined";
import CloudUploadOutlinedIcon from "@mui/icons-material/CloudUploadOutlined";
import GraphicEqOutlinedIcon from "@mui/icons-material/GraphicEqOutlined";
import FolderOutlinedIcon from "@mui/icons-material/FolderOutlined";
import ContentCopyOutlinedIcon from "@mui/icons-material/ContentCopyOutlined";
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

type PipelineStep =
  | "idle"
  | "transcribing"
  | "facts"
  | "impression"
  | "analyzing"
  | "generating"
  | "done"
  | "error";

const DEFAULT_SANITIZE = true;
const DEFAULT_USE_LLM_IN_REPORT = false;

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

async function postJSON(url: string, body: any) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const parsed = await readJsonOrText(res);
  const json = (parsed.kind === "json" ? parsed.json : null) as any;

  if (!res.ok || !json?.ok) {
    const msg =
      json?.error ||
      json?.warning ||
      `HTTP ${res.status} ${res.statusText}\n${(parsed.text || "").slice(0, 800)}`;

    throw new Error(msg);
  }

  return json;
}

function pipelineLabel(step: PipelineStep) {
  switch (step) {
    case "idle":
      return "—";
    case "transcribing":
      return "Transkrypcja…";
    case "facts":
      return "Fakty…";
    case "impression":
      return "Impresja…";
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

function stepChipColor(done: boolean, active: boolean, blocked: boolean) {
  if (done) return "success";
  if (active) return "warning";
  if (blocked) return "error";
  return "default";
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
  const [showTranscriptSection, setShowTranscriptSection] = useState(false);

  // Raport
  const [generatingReport, setGeneratingReport] = useState(false);
  const [savingReport, setSavingReport] = useState(false);
  const [reportDraft, setReportDraft] = useState("");
  const [reportDirty, setReportDirty] = useState(false);

  const reportDirtyRef = useRef(false);

  // Import nagrania
  const [importFile, setImportFile] = useState<File | null>(null);
  const [importing, setImporting] = useState(false);
  const [importRunPipeline, setImportRunPipeline] = useState(false);

  // Delete
  const [deletingExam, setDeletingExam] = useState(false);

  const examRef = useMemo(() => {
    if (!patientIdFromParams || !examId) return null;
    return doc(db, "patients", patientIdFromParams, "exams", examId);
  }, [patientIdFromParams, examId]);

  const hasLocalRecording = !!exam?.recording?.localPath;
  const hasTranscript = !!exam?.transcript;
  const transcriptToShow = showRaw ? exam?.transcriptRaw : exam?.transcript;

  const missing = exam?.analysisMissing;
  const hasAnyAnalysis = !!exam?.analysis?.sections || !!exam?.analysisMissing;

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

  useEffect(() => {
    if (recState !== "recording") return;

    const t = window.setInterval(() => {
      setElapsedMs(elapsedBeforePauseRef.current + (Date.now() - startedAtRef.current));
    }, 250);

    return () => window.clearInterval(t);
  }, [recState]);

  useEffect(() => {
    return () => {
      if (recordedUrl) URL.revokeObjectURL(recordedUrl);
    };
  }, [recordedUrl]);

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

      // normalnie nie nadpisujemy jeśli user edytuje...
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

    if (importing || savingAudio || transcribing || generatingReport || savingReport) return;

    setImporting(true);
    try {
      await ensureInProgressBeforeRecording();

      const form = new FormData();
      form.append("file", importFile, importFile.name || "import-audio");
      form.append("clinicId", clinicId);
      form.append("patientId", patientIdFromParams);
      form.append("examId", examId);
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
      await postJSON("/api/exams/transcribe", { patientId: patientIdFromParams, examId });

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
      await postJSON("/api/exams/preprocess-audio", {
        patientId: patientIdFromParams,
        examId,
      });

      await postJSON("/api/exams/transcribe", {
        patientId: patientIdFromParams,
        examId,
        usePreprocessed: true,
      });

      await load();
      setOkMsg("✅ Oczyszczono nagranie i wykonano ponowną transkrypcję.");
    } catch (e: any) {
      setErr(e?.message || "Błąd preprocessingu/transkrypcji");
      setOkMsg("");
    } finally {
      setPreprocessing(false);
    }
  }

  // Analiza teraz robi: extract-facts + extract-impression + analyze(sanitize)
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

    try {
      setPipelineStep("facts");
      await postJSON("/api/exams/extract-facts", { patientId: patientIdFromParams, examId });

      setPipelineStep("impression");
      await postJSON("/api/exams/extract-impression", { patientId: patientIdFromParams, examId });

      setPipelineStep("analyzing");
      const cid = getCidFromStateOrExam(fresh);

      await postJSON("/api/exams/analyze", {
        clinicId: cid,
        patientId: patientIdFromParams,
        examId,
        sanitize: DEFAULT_SANITIZE,
      });

      await load();
      setOkMsg("✅ Analiza gotowa");
    } catch (e: any) {
      const msg = e?.message || "Błąd analizy";

      // Soft-fail: timeout / abort -> nie zabijaj UI
      const looksLikeTimeout =
        typeof msg === "string" &&
        (msg.toLowerCase().includes("timeout") ||
          msg.toLowerCase().includes("przekroczono") ||
          msg.toLowerCase().includes("abort"));

      if (looksLikeTimeout) {
        setErr("");
        setOkMsg(`⚠ Analiza nie zdążyła się zakończyć: ${msg}\nUżywam poprzednich danych (jeśli istnieją).`);
        await load();
        return;
      }

      setErr(msg);
      setOkMsg("");
      throw e;
    } finally {
      if (pipelineStep !== "error") setPipelineStep("idle");
    }
  }

  // Odśwież raport: generate-report-v2 (sanitize + useLLM)
  async function generateReportNow() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }

    setGeneratingReport(true);
    try {
      const freshBefore = await fetchFreshExam();
      const cid = getCidFromStateOrExam(freshBefore);

      await postJSON("/api/exams/generate-report-v2", {
        clinicId: cid,
        patientId: patientIdFromParams,
        examId,
        sanitize: DEFAULT_SANITIZE,
        useLLM: DEFAULT_USE_LLM_IN_REPORT,
      });

      await load();
      const freshAfter = await fetchFreshExam();

      const fullReport = (freshAfter?.report || "").toString();
      setReportDraft(fullReport);

      reportDirtyRef.current = false;
      setReportDirty(false);

      setOkMsg("✅ Raport wygenerowany (v2, nadpisano draft)");
    } catch (e: any) {
      setErr(e?.message || "Błąd generowania raportu");
      setOkMsg("");
    } finally {
      setGeneratingReport(false);
    }
  }

  // Pipeline v2: transcribe -> facts -> impression -> analyze -> report-v2
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
          throw new Error("Brak transkrypcji i brak lokalnego nagrania (recording.localPath).");
        }

        setPipelineStep("transcribing");
        setTranscribing(true);

        await postJSON("/api/exams/transcribe", { patientId: patientIdFromParams, examId });

        await load();
        fresh = await fetchFreshExam();
        if (!fresh?.transcript || !fresh.transcript.trim()) {
          throw new Error("Transkrypcja nie została zapisana (sprawdź /api/exams/transcribe).");
        }
      }

      // 2) Facts
      setPipelineStep("facts");
      await postJSON("/api/exams/extract-facts", { patientId: patientIdFromParams, examId });

      // 3) Impression
      setPipelineStep("impression");
      await postJSON("/api/exams/extract-impression", { patientId: patientIdFromParams, examId });

      // 4) Analyze
      setPipelineStep("analyzing");
      const cid = getCidFromStateOrExam(fresh);
      await postJSON("/api/exams/analyze", {
        clinicId: cid,
        patientId: patientIdFromParams,
        examId,
        sanitize: DEFAULT_SANITIZE,
      });

      // 5) Report v2
      setPipelineStep("generating");
      await postJSON("/api/exams/generate-report-v2", {
        clinicId: cid,
        patientId: patientIdFromParams,
        examId,
        sanitize: DEFAULT_SANITIZE,
        useLLM: DEFAULT_USE_LLM_IN_REPORT,
      });

      await load();

      const freshAfter = await fetchFreshExam();
      const fullReport = (freshAfter?.report || "").toString();
      if (fullReport) {
        setReportDraft(fullReport);
        reportDirtyRef.current = false;
        setReportDirty(false);
      }

      setPipelineStep("done");
      setPipelineMsg("Gotowe ✅");
      setOkMsg("✅ Pipeline v2 zakończony");
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

  async function deleteExamNow() {
    setErr("");
    setOkMsg("");

    if (!patientIdFromParams || !examId) {
      setErr("Brak patientId/examId.");
      return;
    }

    const confirm1 = window.confirm("Czy na pewno usunąć to badanie? Tej operacji nie da się cofnąć.");
    if (!confirm1) return;

    const deleteFiles = window.confirm(
      "Usunąć też lokalne pliki nagrania (z dysku serwera/dev)?\n\nOK = usuń też pliki\nAnuluj = usuń tylko dokument w Firestore"
    );

    setDeletingExam(true);
    try {
      const cid = getCidFromStateOrExam(exam);

      const res = await fetch("/api/exams/delete", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          clinicId: cid,
          patientId: patientIdFromParams,
          examId,
          deleteLocalFiles: deleteFiles,
        }),
      });

      const parsed = await readJsonOrText(res);
      const json = (parsed.kind === "json" ? parsed.json : null) as any;

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || `HTTP ${res.status} ${res.statusText}\n${parsed.text.slice(0, 800)}`);
      }

      setOkMsg("✅ Badanie usunięte");
      router.push(`/patients/${patientIdFromParams}`);
    } catch (e: any) {
      setErr(e?.message || "Błąd usuwania badania");
      setOkMsg("");
    } finally {
      setDeletingExam(false);
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
    deletingExam ||
    (pipelineStep !== "idle" && pipelineStep !== "done" && pipelineStep !== "error");

  const canStart = !uiLocked && recState === "idle";
  const canPause = !uiLocked && recState === "recording";
  const canResume = !uiLocked && recState === "paused";
  const canStop = !uiLocked && (recState === "recording" || recState === "paused");
  const canSave = !!recordedBlob && !uiLocked;

  const backPid = exam?.patientId || patientIdFromParams;

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

  return (
    <Stack spacing={3}>
      {(err || okMsg) && (
        <Stack spacing={1.5}>
          {err && (
            <Alert severity="error">
              <Box>
                <Typography fontWeight={600}>Błąd</Typography>
                <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                  {err}
                </Typography>
                {pipelineMsg ? (
                  <Typography variant="caption" color="error" sx={{ mt: 1, display: "block" }}>
                    Pipeline: {pipelineMsg}
                  </Typography>
                ) : null}
              </Box>
            </Alert>
          )}
          {okMsg && (
            <Alert severity="success">
              <Box>
                <Typography fontWeight={600}>OK</Typography>
                <Typography variant="body2" sx={{ whiteSpace: "pre-wrap" }}>
                  {okMsg}
                </Typography>
              </Box>
            </Alert>
          )}
        </Stack>
      )}

      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="space-between"
        alignItems={{ sm: "center" }}
      >
        <Box>
          <Typography variant="h5" fontWeight={700}>
            {typeLabel(exam.type)}
          </Typography>
          <Typography variant="caption" color="text.secondary">
            Patient: <Box component="span" sx={{ fontFamily: "monospace" }}>{patientIdFromParams}</Box> • Exam:{" "}
            <Box component="span" sx={{ fontFamily: "monospace" }}>{examId}</Box>
          </Typography>
        </Box>

        <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
          <Chip
            size="small"
            label={`Status: ${exam.status === "draft" ? "Szkic" : exam.status === "in_progress" ? "W trakcie" : "Zakończone"}`}
            color={exam.status === "done" ? "success" : exam.status === "in_progress" ? "warning" : "default"}
            variant="outlined"
          />

          <SecondaryButton
            size="small"
            onClick={() => {
              if (!backPid) {
                setErr("Nie mogę wrócić — brak patientId.");
                return;
              }
              router.push(`/patients/${backPid}`);
            }}
          >
            Wróć
          </SecondaryButton>

          <SecondaryButton
            color="error"
            size="small"
            onClick={deleteExamNow}
            disabled={uiLocked}
            title="Usuń badanie"
          >
            {deletingExam ? "Usuwam…" : "Usuń"}
          </SecondaryButton>
        </Stack>
      </Stack>

      <Paper variant="outlined" sx={{ px: 3, py: 2 }}>
        <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
          <Chip
            size="small"
            label="Nagranie"
            variant="outlined"
            color={stepChipColor(stepRecordingDone, activeRec, false)}
          />
          <Chip
            size="small"
            label="Transkrypcja"
            variant="outlined"
            color={stepChipColor(stepTranscriptDone, activeTranscribe, transBlocked)}
          />
          <Chip
            size="small"
            label="Analiza"
            variant="outlined"
            color={stepChipColor(stepAnalysisDone, activeAnalyze, analyzeBlocked)}
          />
          <Chip
            size="small"
            label="Raport"
            variant="outlined"
            color={stepChipColor(stepReportDone, activeReport, reportBlocked)}
          />

          {hasAnyAnalysis && (
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Typography variant="caption" color="text.secondary">
                • Kompletność:
              </Typography>
              <Chip
                size="small"
                label="Powód"
                color={missing?.reason ? "error" : "success"}
                variant="outlined"
              />
              <Chip
                size="small"
                label="Opis"
                color={missing?.findings ? "error" : "success"}
                variant="outlined"
              />
              <Chip
                size="small"
                label="Wnioski"
                color={missing?.conclusions ? "error" : "success"}
                variant="outlined"
              />
              <Chip
                size="small"
                label="Zalecenia"
                color={missing?.recommendations ? "error" : "success"}
                variant="outlined"
              />
            </Stack>
          )}
        </Stack>
      </Paper>

      <SectionCard
        title="Proces badania"
        subtitle="Nagranie, import i plik nagrania w jednym miejscu."
        icon={<AutoAwesomeOutlinedIcon />}
        actions={
          <PrimaryButton
            size="small"
            onClick={runAutoReportPipeline}
            disabled={uiLocked || (!hasLocalRecording && !exam?.transcript && !exam?.analysis?.sections)}
            title={
              !hasLocalRecording && !exam?.transcript && !exam?.analysis?.sections
                ? "Najpierw dodaj nagranie"
                : ""
            }
          >
            {pipelineStep !== "idle" && pipelineStep !== "done" && pipelineStep !== "error"
              ? pipelineLabel(pipelineStep)
              : "Generuj raport"}
          </PrimaryButton>
        }
      >
        <Grid container spacing={3} alignItems="stretch">
          <Grid item xs={12} md={6} sx={{ display: "flex" }}>
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: "background.default",
                minHeight: { xs: 260, md: 300 },
                height: "100%",
                width: "100%",
                flex: 1,
              }}
            >
              <Stack spacing={2}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <MicOutlinedIcon fontSize="small" />
                  <Typography fontWeight={600}>Nagrywanie</Typography>
                </Stack>
                <Typography variant="body2" sx={{ fontFamily: "monospace" }}>
                  {fmtMs(elapsedMs)}
                </Typography>

                <Stack direction="row" spacing={1} flexWrap="wrap">
                  <PrimaryButton size="small" disabled={!canStart} onClick={startRecording}>
                    Start
                  </PrimaryButton>
                  <SecondaryButton size="small" disabled={!canPause} onClick={pauseRecording}>
                    Pauza
                  </SecondaryButton>
                  <SecondaryButton size="small" disabled={!canResume} onClick={resumeRecording}>
                    Wznów
                  </SecondaryButton>
                  <SecondaryButton size="small" disabled={!canStop} onClick={stopRecording}>
                    Stop
                  </SecondaryButton>
                </Stack>

                {recordedUrl && (
                  <Stack spacing={1}>
                    <audio controls src={recordedUrl} className="w-full" />
                    <Typography variant="caption" color="text.secondary">
                      MIME: <span className="font-mono">{recordedMime}</span> • Rozmiar:{" "}
                      <span className="font-mono">{recordedBlob?.size ?? 0}</span> B
                    </Typography>
                  </Stack>
                )}

                <Stack spacing={1}>
                  <SecondaryButton size="small" disabled={!canSave} onClick={saveRecordingLocal}>
                    {savingAudio ? "Zapisuję…" : "Zapisz nagranie"}
                  </SecondaryButton>
                  <Typography variant="caption" color="text.secondary">
                    Zapis lokalny jest wymagany do transkrypcji.
                  </Typography>
                </Stack>
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} md={6} sx={{ display: "flex" }}>
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: "background.default",
                minHeight: { xs: 260, md: 300 },
                height: "100%",
                width: "100%",
                flex: 1,
              }}
            >
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <FolderOutlinedIcon fontSize="small" />
                  <Typography fontWeight={600}>Plik nagrania</Typography>
                </Stack>
                {hasLocalRecording ? (
                  <>
                    <audio
                      controls
                      className="w-full"
                      src={`/api/recordings/file?path=${encodeURIComponent(exam.recording!.localPath!)}`}
                    />
                    <Stack direction="row" spacing={1} alignItems="center">
                      <Typography
                        variant="caption"
                        color="text.secondary"
                        sx={{
                          fontFamily: "monospace",
                          whiteSpace: "nowrap",
                          overflow: "hidden",
                          textOverflow: "ellipsis",
                          flex: 1,
                        }}
                      >
                        {exam.recording!.localPath}
                      </Typography>
                      <SecondaryButton
                        size="small"
                        onClick={async () => {
                          try {
                            await navigator.clipboard.writeText(
                              exam.recording!.localPath
                            );
                            setOkMsg("Skopiowano ścieżkę nagrania.");
                          } catch {}
                        }}
                        startIcon={<ContentCopyOutlinedIcon fontSize="small" />}
                      >
                        Kopiuj
                      </SecondaryButton>
                    </Stack>
                    {exam.recording?.preprocessedLocalPath ? (
                      <Typography variant="caption" color="text.secondary">
                        Plik oczyszczony zapisany.
                      </Typography>
                    ) : null}
                  </>
                ) : (
                  <Typography variant="caption" color="text.secondary">
                    Brak nagrania.
                  </Typography>
                )}
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} md={6} sx={{ display: "flex" }}>
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: "background.default",
                minHeight: { xs: 260, md: 300 },
                height: "100%",
                width: "100%",
                flex: 1,
              }}
            >
              <Stack spacing={2}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <CloudUploadOutlinedIcon fontSize="small" />
                  <Typography fontWeight={600}>Import nagrania</Typography>
                </Stack>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  Wgraj gotowy plik audio (mp3, m4a, wav, ogg, webm). Zostanie zapisany lokalnie i podpięty do badania.
                </Typography>

                <Stack spacing={1.5}>
                  <SecondaryButton component="label" size="small" disabled={uiLocked}>
                    Wybierz plik audio
                    <input
                      type="file"
                      accept="audio/*"
                      hidden
                      onChange={(e) => {
                        const f = e.target.files?.[0] || null;
                        setImportFile(f);
                      }}
                    />
                  </SecondaryButton>

                  <FormControlLabel
                    control={
                      <Checkbox
                        checked={importRunPipeline}
                        onChange={(e) => setImportRunPipeline(e.target.checked)}
                        disabled={uiLocked}
                      />
                    }
                    label="Automatycznie uruchom generowanie raportu"
                  />

                  <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
                    <SecondaryButton
                      size="small"
                      disabled={uiLocked || !importFile}
                      onClick={importRecordingFile}
                    >
                      {importing ? "Importuję…" : "Wgraj do badania"}
                    </SecondaryButton>

                    <Typography variant="caption" color="text.secondary">
                      {importFile
                        ? `Wybrano: ${importFile.name} • ${Math.round(importFile.size / 1024)} KB`
                        : "Nie wybrano pliku"}
                    </Typography>
                  </Stack>
                </Stack>
              </Stack>
            </Paper>
          </Grid>

          <Grid item xs={12} md={6} sx={{ display: "flex" }}>
            <Paper
              variant="outlined"
              sx={{
                p: 2,
                bgcolor: "background.default",
                minHeight: { xs: 260, md: 300 },
                height: "100%",
                width: "100%",
                flex: 1,
              }}
            >
              <Stack spacing={1.5}>
                <Stack direction="row" spacing={1} alignItems="center">
                  <GraphicEqOutlinedIcon fontSize="small" />
                  <Typography fontWeight={600}>Transkrypcja</Typography>
                </Stack>
                <Typography
                  variant="caption"
                  color="text.secondary"
                  sx={{
                    display: "-webkit-box",
                    WebkitLineClamp: 2,
                    WebkitBoxOrient: "vertical",
                    overflow: "hidden",
                  }}
                >
                  Włącz podgląd transkrypcji w osobnej sekcji.
                </Typography>
                <SecondaryButton
                  size="small"
                  onClick={() => setShowTranscriptSection((v) => !v)}
                >
                  {showTranscriptSection ? "Ukryj transkrypcję" : "Zobacz transkrypcję"}
                </SecondaryButton>
              </Stack>
            </Paper>
          </Grid>
        </Grid>
      </SectionCard>

      {showTranscriptSection && (hasLocalRecording || hasTranscript) && (
        <SectionCard
          title="Transkrypcja"
          subtitle="Czysta / surowa transkrypcja oraz narzędzia analizy."
          icon={<GraphicEqOutlinedIcon />}
          sx={{ width: "100%" }}
        >
          <Stack spacing={2}>
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <PrimaryButton
                size="small"
                onClick={transcribeNow}
                disabled={uiLocked || !hasLocalRecording}
                title={!hasLocalRecording ? "Brak lokalnego nagrania" : ""}
              >
                {transcribing ? "Transkrybuję…" : "Transkrybuj"}
              </PrimaryButton>

              <SecondaryButton
                size="small"
                onClick={analyzeNow}
                disabled={uiLocked || !exam?.transcript}
                title={!exam?.transcript ? "Brak transkrypcji" : ""}
              >
                Analizuj (v2)
              </SecondaryButton>

              <SecondaryButton
                size="small"
                variant={!showRaw ? "contained" : "outlined"}
                onClick={() => setShowRaw(false)}
                disabled={!exam.transcript}
              >
                Czyste
              </SecondaryButton>
              <SecondaryButton
                size="small"
                variant={showRaw ? "contained" : "outlined"}
                onClick={() => setShowRaw(true)}
                disabled={!exam.transcriptRaw}
              >
                Surowe
              </SecondaryButton>

              {typeof qualityScore === "number" && (
                <Chip
                  size="small"
                  label={`Jakość: ${qualityScore}/100${wasPreprocessed ? " • po czyszczeniu" : ""}`}
                  variant="outlined"
                  color={qualityScore < 60 ? "error" : qualityScore < 75 ? "warning" : "success"}
                />
              )}

              {isQualityLow && (
                <PrimaryButton
                  size="small"
                  disabled={uiLocked || preprocessing || !hasLocalRecording}
                  onClick={preprocessAndRetranscribe}
                  title="Odszumianie + normalizacja głośności + ponowna transkrypcja"
                >
                  {preprocessing ? "Oczyszczam…" : "Oczyść i ponów"}
                </PrimaryButton>
              )}
            </Stack>

            {transcriptToShow ? (
              <Paper
                variant="outlined"
                sx={{ p: 2, bgcolor: "background.default", maxHeight: 260, overflow: "auto" }}
              >
                <Typography variant="caption" sx={{ whiteSpace: "pre-wrap" }}>
                  {transcriptToShow}
                </Typography>
              </Paper>
            ) : (
              <Typography variant="body2" color="text.secondary">
                Brak transkrypcji — kliknij „Transkrybuj”.
              </Typography>
            )}
          </Stack>
        </SectionCard>
      )}

      <SectionCard
        title="Raport"
        subtitle="Edytuj ręcznie i zapisz do badania."
        icon={<DescriptionOutlinedIcon />}
        sx={{ width: "100%" }}
      >
        <Stack spacing={2}>
          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ sm: "center" }}
          >
            <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
              <Chip size="small" label={pipelineLabel(pipelineStep)} variant="outlined" />
              <PrimaryButton size="small" onClick={saveReport} disabled={uiLocked}>
                {savingReport ? "Zapisuję…" : "Zapisz"}
              </PrimaryButton>
              <SecondaryButton
                size="small"
                onClick={generateReportNow}
                disabled={uiLocked}
                title="Generuj raport v2 na nowo i nadpisz draft"
              >
                {generatingReport ? "Generuję…" : "Odśwież (v2)"}
              </SecondaryButton>
            </Stack>
          </Stack>

          <TextField
            multiline
            minRows={20}
            value={reportDraft}
            onChange={(e) => {
              setReportDraft(e.target.value);
              reportDirtyRef.current = true;
              setReportDirty(true);
            }}
            placeholder="Tu pojawi się raport. Możesz go edytować ręcznie."
            fullWidth
          />

          <Stack direction="row" justifyContent="space-between" alignItems="center">
            <Typography variant="caption" color="text.secondary">
              {reportDirty ? "Masz niezapisane zmiany." : "—"}
            </Typography>
            <Typography variant="caption" sx={{ fontFamily: "monospace" }}>
              {reportDraft.length} znaków
            </Typography>
          </Stack>

          <Stack direction={{ xs: "column", sm: "row" }} spacing={2} alignItems="center">
            <PrimaryButton size="medium">
              Pobierz badanie (PDF/DOCX)
            </PrimaryButton>
            <SecondaryButton size="medium">
              Eksportuj do Klinika XP
            </SecondaryButton>
          </Stack>
        </Stack>
      </SectionCard>
    </Stack>
  );
}

"use client";

import React, { useEffect, useMemo, useRef, useState } from "react";
import { useRouter, useParams } from "next/navigation";

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
  report?: string;
  recording?: {
    storage: "local" | "firebase";
    localPath?: string; // relativePath z API
    absolutePath?: string; // tylko PoC (opcjonalnie)
    durationMs: number;
    mimeType: string;
    size: number;
    savedAt?: any;
    expiresAt?: any; // pod retencję
  };
};

function fmtMs(ms: number) {
  const totalSec = Math.floor(ms / 1000);
  const mm = String(Math.floor(totalSec / 60)).padStart(2, "0");
  const ss = String(totalSec % 60).padStart(2, "0");
  return `${mm}:${ss}`;
}

function statusLabel(s: ExamStatus) {
  switch (s) {
    case "draft":
      return "Szkic";
    case "in_progress":
      return "W trakcie";
    case "done":
      return "Zakończone";
  }
}

function typeLabel(t?: string) {
  return t || "Badanie";
}

function addDaysISO(days: number) {
  const d = new Date();
  d.setDate(d.getDate() + days);
  return d.toISOString();
}

export default function ExamPage() {
  const router = useRouter();
  const params = useParams<{ id: string; examId: string }>();

  const patientIdRaw = params?.id;
  const examIdRaw = params?.examId;

  const patientId = Array.isArray(patientIdRaw) ? patientIdRaw[0] : patientIdRaw;
  const examId = Array.isArray(examIdRaw) ? examIdRaw[0] : examIdRaw;

  const [loading, setLoading] = useState(true);
  const [savingStatus, setSavingStatus] = useState(false);

  const [exam, setExam] = useState<ExamDoc | null>(null);
  const [clinicId, setClinicId] = useState<string>("");

  // ---- MediaRecorder state ----
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const mediaStreamRef = useRef<MediaStream | null>(null);
  const chunksRef = useRef<BlobPart[]>([]);
  const startedAtRef = useRef<number>(0);
  const elapsedBeforePauseRef = useRef<number>(0);

  const [recState, setRecState] = useState<
    "idle" | "recording" | "paused" | "stopped"
  >("idle");
  const [elapsedMs, setElapsedMs] = useState<number>(0);
  const [recordedBlob, setRecordedBlob] = useState<Blob | null>(null);
  const [recordedUrl, setRecordedUrl] = useState<string>("");
  const [recordedMime, setRecordedMime] = useState<string>("audio/webm");

  const [savingAudio, setSavingAudio] = useState(false);
  const [err, setErr] = useState<string>("");
  const [okMsg, setOkMsg] = useState<string>("");

  const canRecord = exam?.status === "in_progress";

  const examRef = useMemo(() => {
    if (!patientId || !examId) return null;
    return doc(db, "patients", patientId, "exams", examId);
  }, [patientId, examId]);

  // timer tick
  useEffect(() => {
    if (recState !== "recording") return;

    const t = window.setInterval(() => {
      const now = Date.now();
      const ms = elapsedBeforePauseRef.current + (now - startedAtRef.current);
      setElapsedMs(ms);
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

  function pickSupportedMime(): string {
    const candidates = [
      "audio/webm;codecs=opus",
      "audio/webm",
      "audio/ogg;codecs=opus",
      "audio/ogg",
    ];
    for (const c of candidates) {
      // @ts-ignore
      if (
        typeof MediaRecorder !== "undefined" &&
        MediaRecorder.isTypeSupported?.(c)
      )
        return c;
    }
    return "audio/webm";
  }

  async function load() {
    if (!examRef || !patientId || !examId) return;

    setLoading(true);
    setErr("");
    setOkMsg("");
    try {
      const myClinicId = await getMyClinicId();
      setClinicId(myClinicId);

      const snap = await getDoc(examRef);
      if (!snap.exists()) {
        setErr("Nie znaleziono badania.");
        setExam(null);
      } else {
        const data = snap.data() as ExamDoc;
        setExam(data);
      }
    } catch (e: any) {
      setErr(e?.message ?? "Błąd ładowania badania.");
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    if (!patientId || !examId) return;
    load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [patientId, examId, examRef]);

  async function setStatus(next: ExamStatus) {
    if (!exam || !examRef) return;
    setSavingStatus(true);
    setErr("");
    setOkMsg("");
    try {
      await updateDoc(examRef, {
        status: next,
        updatedAt: serverTimestamp(),
      });
      setExam({ ...exam, status: next });
    } catch (e: any) {
      setErr(e?.message ?? "Nie udało się zmienić statusu.");
    } finally {
      setSavingStatus(false);
    }
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

      const mimeType = pickSupportedMime();
      setRecordedMime(mimeType);

      const mr = new MediaRecorder(stream, { mimeType } as any);
      mediaRecorderRef.current = mr;

      mr.ondataavailable = (ev) => {
        if (ev.data && ev.data.size > 0) chunksRef.current.push(ev.data);
      };

      mr.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: mimeType });
        setRecordedBlob(blob);
        const url = URL.createObjectURL(blob);
        setRecordedUrl(url);
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
        const now = Date.now();
        elapsedBeforePauseRef.current += now - startedAtRef.current;
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
      const now = Date.now();
      if (recState === "recording") {
        elapsedBeforePauseRef.current += now - startedAtRef.current;
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
    if (!patientId || !examId || !examRef) {
      setErr("Brak parametrów ścieżki (patientId/examId).");
      return;
    }

    setSavingAudio(true);
    try {
      const cid = clinicId || exam?.clinicId || (await getMyClinicId());

      const form = new FormData();
      form.append("file", recordedBlob, "recording.webm");
      form.append("clinicId", cid);
      form.append("patientId", patientId);
      form.append("examId", examId);
      form.append("durationMs", String(elapsedMs));

      const res = await fetch("/api/recordings", {
        method: "POST",
        body: form,
      });

      const json = await res.json();

      if (!res.ok || !json?.ok) {
        throw new Error(json?.error || "Nie udało się zapisać nagrania lokalnie.");
      }

      // retencja 30 dni (metadane)
      const expiresAtISO = addDaysISO(30);

      await updateDoc(examRef, {
        recording: {
          storage: "local",
          localPath: json.relativePath,
          absolutePath: json.absolutePath, // PoC only (możesz usunąć później)
          durationMs: elapsedMs,
          mimeType: recordedBlob.type || recordedMime,
          size: recordedBlob.size,
          savedAt: serverTimestamp(),
          // w PoC trzymamy ISO do czytelności, docelowo można Timestamp
          expiresAt: expiresAtISO,
        },
        updatedAt: serverTimestamp(),
      });

      setExam((prev) =>
        prev
          ? {
              ...prev,
              recording: {
                storage: "local",
                localPath: json.relativePath,
                absolutePath: json.absolutePath,
                durationMs: elapsedMs,
                mimeType: recordedBlob.type || recordedMime,
                size: recordedBlob.size,
                savedAt: null,
                expiresAt: expiresAtISO as any,
              },
            }
          : prev
      );

      setOkMsg("✅ Nagranie zapisane lokalnie na dysku serwera i podpięte do badania.");
    } catch (e: any) {
      setErr(e?.message ?? "Błąd zapisu nagrania lokalnie.");
    } finally {
      setSavingAudio(false);
    }
  }

  if (!patientId || !examId) {
    return (
      <div className="p-6 space-y-3">
        <div className="text-lg font-semibold">Badanie</div>
        <div className="text-sm opacity-70">Ładowanie parametrów routingu…</div>
      </div>
    );
  }

  if (loading) {
    return (
      <div className="p-6">
        <div className="text-sm opacity-70">Ładowanie badania…</div>
      </div>
    );
  }

  if (!exam) {
    return (
      <div className="p-6 space-y-3">
        <div className="text-lg font-semibold">Badanie</div>
        {err && (
          <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
            {err}
          </div>
        )}
        <button
          className="rounded-lg border px-3 py-2 text-sm"
          onClick={() => router.push(`/patients/${patientId}`)}
        >
          Wróć do pacjenta
        </button>
      </div>
    );
  }

  return (
    <div className="p-6 space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div>
          <div className="text-xl font-semibold">{typeLabel(exam.type)}</div>
          <div className="mt-1 text-sm opacity-70">
            Patient: <span className="font-mono">{patientId}</span> • Exam:{" "}
            <span className="font-mono">{examId}</span>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="rounded-full border px-3 py-1 text-xs">
            {statusLabel(exam.status)}
          </span>
          <button
            className="rounded-lg border px-3 py-2 text-sm"
            onClick={() => router.push(`/patients/${patientId}`)}
          >
            Wróć do pacjenta
          </button>
        </div>
      </div>

      {err && (
        <div className="rounded-lg border border-red-300 bg-red-50 p-3 text-sm text-red-700">
          {err}
        </div>
      )}
      {okMsg && (
        <div className="rounded-lg border border-green-300 bg-green-50 p-3 text-sm text-green-800">
          {okMsg}
        </div>
      )}

      <section className="rounded-2xl border p-4 space-y-3">
        <div className="text-sm font-semibold">Status badania</div>
        <div className="flex flex-wrap gap-2">
          <button
            disabled={savingStatus || exam.status === "draft"}
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => setStatus("draft")}
          >
            Ustaw: szkic
          </button>
          <button
            disabled={savingStatus || exam.status === "in_progress"}
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => setStatus("in_progress")}
          >
            Ustaw: w trakcie
          </button>
          <button
            disabled={savingStatus || exam.status === "done"}
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            onClick={() => setStatus("done")}
          >
            Ustaw: zakończone
          </button>
        </div>
        <div className="text-xs opacity-70">
          Nagrywanie jest aktywne tylko gdy status = <b>W trakcie</b>.
        </div>
      </section>

      <section className="rounded-2xl border p-4 space-y-4">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-semibold">Nagrywanie</div>
          <div className="text-sm font-mono">{fmtMs(elapsedMs)}</div>
        </div>

        <div className="flex flex-wrap gap-2 items-center">
          <button
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            disabled={!canRecord || recState === "recording" || savingAudio}
            onClick={startRecording}
          >
            Start
          </button>

          {recState === "recording" ? (
            <button
              className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
              disabled={!canRecord || savingAudio}
              onClick={pauseRecording}
            >
              Pauza
            </button>
          ) : (
            <button
              className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
              disabled={!canRecord || recState !== "paused" || savingAudio}
              onClick={resumeRecording}
            >
              Wznów
            </button>
          )}

          <button
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            disabled={
              !canRecord ||
              (recState !== "recording" && recState !== "paused") ||
              savingAudio
            }
            onClick={stopRecording}
          >
            Stop
          </button>

          <button
            className="rounded-lg border px-3 py-2 text-sm disabled:opacity-50"
            disabled={!recordedBlob || savingAudio}
            onClick={saveRecordingLocal}
          >
            {savingAudio ? "Zapisuję lokalnie…" : "Zapisz nagranie (lokalnie)"}
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

        {exam.recording?.storage === "local" && exam.recording?.localPath && (
         <div className="space-y-3">
           <div className="text-xs opacity-70">Nagranie zapisane lokalnie:</div>

           <audio
             controls
             className="w-full"
             src={`/api/recordings/file?path=${encodeURIComponent(
               exam.recording.localPath
             )}`}
           />

           <div className="rounded-lg border p-3 text-xs space-y-1">
             <div>
               Path:{" "}
               <span className="font-mono break-all">
                {exam.recording.localPath}
               </span>
              </div>
              {exam.recording.expiresAt && (
                <div>
                 Retencja do:{" "}
                <span className="font-mono">
                 {String(exam.recording.expiresAt)}
                </span>
               </div>
           )}
         </div>
        </div>
        )}

      </section>
    </div>
  );
}

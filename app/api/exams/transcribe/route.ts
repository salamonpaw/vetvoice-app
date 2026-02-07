export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import os from "os";
import fs from "fs/promises";
import { existsSync } from "fs";
import { spawn } from "child_process";
import crypto from "crypto";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

/* ================== helpers ================== */

function getRequiredEnv(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`Missing env ${name}`);
  return v;
}

function safeInt(v: string | undefined, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function safeFloat(v: string | undefined, def: number) {
  const n = Number(v);
  return Number.isFinite(n) ? n : def;
}

function nowIso() {
  return new Date().toISOString();
}

function preview(s: string, max = 800) {
  const x = (s ?? "").toString();
  return x.length <= max ? x : x.slice(0, max) + "…";
}

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

/** Postprocess — czyści timestampy i porządkuje tekst. */
function postprocessTranscript(raw: string) {
  const lines = (raw || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);

  const cleaned = lines
    .map((l) => {
      // [00:00.000 --> 00:03.000] tekst
      l = l.replace(
        /^\[\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*\]\s*/g,
        ""
      );

      // 00:00:03.120 --> 00:00:06.500
      l = l.replace(
        /^\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*-->\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*/g,
        ""
      );

      // (00:03) / [00:03] / 00:03 na początku
      l = l.replace(/^\(?\s*\d{1,2}:\d{2}(?::\d{2})?(?:\.\d{1,3})?\s*\)?\s*/g, "");

      // linie numerów (SRT)
      if (/^\d+\s*$/.test(l)) return "";

      return l.trim();
    })
    .filter(Boolean)
    .join("\n");

  return cleaned.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/** Medyczna autokorekta STT (deterministyczna, bez LLM). */
type Replace = string | ((match: string, ...args: any[]) => string);

function medicalCorrections(input: string) {
  let s = (input || "").toString();

  const rules: Array<[RegExp, Replace]> = [
    // echogeniczność
    [/\behebryczno(?:ść|s[cć])\b/giu, "echogeniczność"],
    [/\bechogoniczno(?:ść|s[cć])\b/giu, "echogeniczność"],
    [/\becho\s*gęsto(?:ść|s[cć])\b/giu, "echogeniczność"],

    // miedniczka / nerka / śledziona
    [/\bmilniczk[ai]\b/giu, "miedniczka"],
    [/\bnierk[ai]\b/giu, (m: string) => (m.toLowerCase().endsWith("a") ? "nerka" : "nerki")],
    [/\bśledzon[ay]\b/giu, "śledziona"],

    // doppler
    [/\bdople(?:ż|z)e\b/giu, "Doppler"],
    [/\bdopler(?:em|ze|a|u|y)?\b/giu, "Doppler"],

    // cień akustyczny
    [/\bcieniak(?:\s+użytkow(?:y|a|e))?\b/giu, "cień akustyczny"],

    // jajniki / krezkowe
    [/\bwiejnik(?:i|ów|ach|ami)?\b/giu, "jajniki"],
    [/\bkreskow(?:e|ych|ymi|ego|a)\b/giu, "krezkowe"],

    // pęcherz moczowy
    [/\bpęcharz\b/giu, "pęcherz"],
    [/\bpęcherz\s+mocow(?:y|a|e)\b/giu, "pęcherz moczowy"],

    // ropomacicze / piometra
    [/\bpiometr(?:a|y|ze|ą)?\b/giu, "piometra"],
    [/\bpyometra\b/giu, "piometra"],

    // angio-TK
    [/\bangioteka\b/giu, "angio-TK"],
    [/\bangio\s*teka\b/giu, "angio-TK"],

    // drobne korekty
    [/\bzróżnicowanie\s+korowo\s*[- ]\s*rdzeniow(?:e|a|y)\b/giu, "zróżnicowanie korowo-rdzeniowe"],
    [/\bniepogrubia(?:łe|ła|ły)\b/giu, "niepogrubiałe"],
    [/\bwywiatował\b/giu, "wymiotował"],
  ];

  for (const [rx, repl] of rules) {
    s = s.replace(rx, repl as any);
  }

  return s.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

/* ===================== Transcript quality scoring ===================== */

type TranscriptQuality = {
  score: number; // 0..100
  flags: string[];
  metrics: {
    tokenCount: number;
    unknownTokenRatio: number; // 0..1
    repetitionScore: number; // 0..1
    organHitCount: number; // 0..7
    organHitRatio: number; // 0..1
    suspiciousBigramCount: number;
    rawLength: number;
    cleanLength: number;
  };
};

function computeTranscriptQuality(transcriptClean: string, transcriptRaw: string): TranscriptQuality {
  const flags: string[] = [];

  const clean = (transcriptClean || "").trim();
  const raw = (transcriptRaw || "").trim();

  if (!clean) {
    return {
      score: 0,
      flags: ["EMPTY_TRANSCRIPT"],
      metrics: {
        tokenCount: 0,
        unknownTokenRatio: 1,
        repetitionScore: 1,
        organHitCount: 0,
        organHitRatio: 0,
        suspiciousBigramCount: 0,
        rawLength: raw.length,
        cleanLength: 0,
      },
    };
  }

  const tokens = clean
    .toLowerCase()
    .replace(/[“”„"]/g, '"')
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokenCount = tokens.length;

  const filler = new Set([
    "spokojnie","super","dobrze","tak","no","witam","już","chwila","ok","idealnie","proszę","leżymy","leż","ładnie","brawo",
  ]);

  let repeatPairs = 0;
  let adjacentRepeats = 0;
  for (let i = 1; i < tokens.length; i++) {
    const prev = tokens[i - 1];
    const cur = tokens[i];
    if (cur === prev && !filler.has(cur)) adjacentRepeats++;
    if (i >= 2) {
      const prev2 = tokens[i - 2];
      if (cur === prev2 && !filler.has(cur)) repeatPairs++;
    }
  }

  const repetitionScore = Math.min(1, (adjacentRepeats + repeatPairs) / Math.max(1, tokenCount));
  if (repetitionScore > 0.1) flags.push("MANY_REPETITIONS");
  if (repetitionScore > 0.22) flags.push("HEAVY_REPETITIONS");

  const vowels = /[aeiouyąęó]/;
  const isWeirdToken = (t: string) => {
    if (t.length <= 2) return false;
    if (t.length >= 20) return true;
    if (/^\p{L}+$/u.test(t) && !vowels.test(t)) return true;
    if (/(wty|tsym|rzq|xq|qq|jjj)/.test(t)) return true;
    return false;
  };

  const weirdCount = tokens.reduce((acc, t) => acc + (isWeirdToken(t) ? 1 : 0), 0);
  const unknownTokenRatio = tokenCount > 0 ? weirdCount / tokenCount : 1;

  if (unknownTokenRatio > 0.06) flags.push("MANY_UNKNOWN_TOKENS");
  if (unknownTokenRatio > 0.12) flags.push("HEAVY_UNKNOWN_TOKENS");

  const organPatterns: Array<[string, RegExp]> = [
    ["liver", /\bwątroba\b/u],
    ["gb", /\bpęcherzyk\b[\s\S]{0,40}\bż[óo]łciow/u],
    ["spleen", /\bśledziona\b/u],
    ["kidneys", /\bnerk[ai]\b|\bnerki\b/u],
    ["bladder", /\bpęcherz\b.*\bmoczow/u],
    ["intestines", /\bjelit\w*/u],
    ["pancreas", /\btrzustk\w*/u],
  ];

  const cleanLower = clean.toLowerCase();
  const organHitCount = organPatterns.reduce((acc, [, rx]) => acc + (rx.test(cleanLower) ? 1 : 0), 0);
  const organHitRatio = organHitCount / organPatterns.length;

  if (organHitCount <= 2) flags.push("LOW_ORGAN_COVERAGE");
  if (organHitCount <= 1) flags.push("VERY_LOW_ORGAN_COVERAGE");

  const suspiciousPatterns: RegExp[] = [
    /\bmocznik\s+(powiększon|wypełnion|ścian)/u,
    /\bws?g\b/u,
    /\bszóstk[ai]\b/u,
    /\bżujic\b/u,
    /\bpręg\s+żółciow/u,
  ];

  let suspiciousBigramCount = 0;
  for (const rx of suspiciousPatterns) {
    if (rx.test(cleanLower)) suspiciousBigramCount++;
  }
  if (suspiciousBigramCount >= 1) flags.push("SUSPICIOUS_TERMS");
  if (suspiciousBigramCount >= 3) flags.push("MANY_SUSPICIOUS_TERMS");

  const organComponent = organHitRatio;
  const unknownComponent = 1 - Math.min(1, unknownTokenRatio * 6);
  const repetitionComponent = 1 - Math.min(1, repetitionScore * 2.5);
  const lengthComponent = Math.min(1, clean.length / 600);

  const weighted =
    0.45 * organComponent +
    0.25 * unknownComponent +
    0.20 * repetitionComponent +
    0.10 * lengthComponent;

  const score = Math.round(100 * Math.max(0, Math.min(1, weighted)));

  if (score < 60) flags.push("QUALITY_LOW");
  else if (score < 75) flags.push("QUALITY_MEDIUM");
  else flags.push("QUALITY_GOOD");

  if (clean.length < 120) flags.push("VERY_SHORT_TRANSCRIPT");

  return {
    score,
    flags: Array.from(new Set(flags)),
    metrics: {
      tokenCount,
      unknownTokenRatio,
      repetitionScore,
      organHitCount,
      organHitRatio,
      suspiciousBigramCount,
      rawLength: raw.length,
      cleanLength: clean.length,
    },
  };
}

/* ================== firebase ================== */

async function getAdminDb() {
  if (!getApps().length) {
    const relPath = getRequiredEnv("FIREBASE_SERVICE_ACCOUNT_PATH");
    const abs = path.isAbsolute(relPath) ? relPath : path.join(process.cwd(), relPath);
    const json = JSON.parse(await fs.readFile(abs, "utf8"));
    initializeApp({ credential: cert(json) });
  }
  return getFirestore();
}

/* ================== stt runner ================== */

type SttRunResult = {
  ok: boolean;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  transcriptRaw: string;
  transcript: string;
  quality: TranscriptQuality;

  // DEBUG
  tmpDir: string;
  filesPreview: string[];
  argsPreview: string[];
};

async function runMlxWhisper(opts: {
  audioAbsPath: string;
  tmpRootId: string;
  model: string;
  lang: string;
  timeoutMs: number;
  bestOf: number;
  temperature: number;
  initialPrompt?: string;
  bin: string;

  conditionOnPreviousText: boolean;
  compressionRatioThreshold: number;
  noSpeechThreshold: number;
}): Promise<SttRunResult> {
  const tmpDir = path.join(os.tmpdir(), `vetvoice-stt-${opts.tmpRootId}-${Date.now()}`);
  await fs.mkdir(tmpDir, { recursive: true });

  const args: string[] = [
    opts.audioAbsPath,
    "--task", "transcribe",
    "--model", opts.model,
    "--language", opts.lang,
    "--output-format", "txt",
    "--output-dir", tmpDir,
    "--temperature", String(opts.temperature),
    "--best-of", String(opts.bestOf),

    // anty-loop / cisza
    "--condition-on-previous-text", opts.conditionOnPreviousText ? "True" : "False",
    "--compression-ratio-threshold", String(opts.compressionRatioThreshold),
    "--no-speech-threshold", String(opts.noSpeechThreshold),
  ];

  if (opts.initialPrompt && opts.initialPrompt.trim().length > 0) {
    args.push("--initial-prompt", opts.initialPrompt.trim());
  }

  let stdout = "";
  let stderr = "";

  const child = spawn(opts.bin, args, {
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      HF_HUB_OFFLINE: "1",
      TRANSFORMERS_OFFLINE: "1",
      HF_DATASETS_OFFLINE: "1",
    },
  });

  child.stdout?.on("data", (d) => (stdout += d.toString()));
  child.stderr?.on("data", (d) => (stderr += d.toString()));

  const exit = await Promise.race([
    new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((res) =>
      child.on("close", (code, signal) => res({ code, signal }))
    ),
    new Promise<{ code: null; signal: "SIGKILL" }>((res) =>
      setTimeout(() => {
        try { child.kill("SIGKILL"); } catch {}
        res({ code: null, signal: "SIGKILL" });
      }, opts.timeoutMs)
    ),
  ]);

  const files = await fs.readdir(tmpDir).catch(() => []);
  const filesPreview = files.slice(0, 50);
  const txt = files.find((f) => f.endsWith(".txt"));

  let transcriptRaw = "";
  let transcript = "";

  if (txt) {
    transcriptRaw = (await fs.readFile(path.join(tmpDir, txt), "utf8")).toString().trim();
    transcript = postprocessTranscript(transcriptRaw);
    transcript = medicalCorrections(transcript);
  }

  const quality = computeTranscriptQuality(transcript, transcriptRaw);

  // sprzątanie (best effort) — UWAGA: usuwamy po readdir
  fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

  return {
    ok: !!txt && exit.signal !== "SIGKILL" && (exit.code === 0 || exit.code === null),
    exitCode: exit.code,
    signal: exit.signal,
    stdout,
    stderr,
    transcriptRaw,
    transcript,
    quality,
    tmpDir,
    filesPreview,
    argsPreview: args,
  };
}

/* ================== route ================== */

export async function POST(req: NextRequest) {
  const runId = crypto.randomUUID();
  const startedAt = nowIso();

  try {
    const body = await req.json();

    let patientId = (body.patientId ?? "").toString().trim();
    let examId = (body.examId ?? "").toString().trim();
    const docPath = (body.docPath ?? "").toString().trim();
    const force = (body.force ?? "auto").toString().trim() as "raw" | "auto" | "preprocessed";

    if (docPath) {
      const m = docPath.match(/^patients\/([^/]+)\/exams\/([^/]+)$/);
      if (!m) {
        return NextResponse.json(
          { ok: false, error: "Invalid docPath format. Expected patients/{pid}/exams/{eid}" },
          { status: 400 }
        );
      }
      patientId = m[1];
      examId = m[2];
    }

    if (!patientId || !examId) {
      return NextResponse.json({ ok: false, error: "Missing patientId or examId" }, { status: 400 });
    }

    const db = await getAdminDb();
    const examRefPath = `patients/${patientId}/exams/${examId}`;
    const examRef = db.doc(examRefPath);
    const snap = await examRef.get();

    if (!snap.exists) {
      return NextResponse.json({ ok: false, error: "Exam not found", examRefPath }, { status: 404 });
    }

    const exam = snap.data() as any;

    const recording = exam.recording || {};
    const originalRelPath: string | undefined = recording.localPath;
    const preprocessedRelPath: string | undefined = recording.preprocessedLocalPath;

    if (!originalRelPath) {
      return NextResponse.json({ ok: false, error: "Missing recording.localPath", examRefPath }, { status: 400 });
    }

    const mode =
      force === "preprocessed" && preprocessedRelPath ? "preprocessed" :
      force === "raw" ? "raw" :
      "raw";

    const chosenRelPath = mode === "preprocessed" ? preprocessedRelPath! : originalRelPath;
    const audioAbsPath = path.isAbsolute(chosenRelPath) ? chosenRelPath : path.join(process.cwd(), chosenRelPath);

    if (!(await fileExists(audioAbsPath)) || !existsSync(audioAbsPath)) {
      return NextResponse.json(
        { ok: false, error: "Audio file not found on disk", audioAbsPath, chosenRelPath, examRefPath },
        { status: 404 }
      );
    }

    const MLX = getRequiredEnv("MLX_WHISPER_BIN");
    const MODEL = getRequiredEnv("WHISPER_MODEL");

    // normalizacja: usuń końcowe kropki/spacje w języku (np. "pl.")
    const langRaw = (process.env.WHISPER_LANGUAGE || "pl").toString().trim().replace(/\.+$/g, "");
    const LANG = langRaw.length ? langRaw : "pl";

    const TIMEOUT_MS = safeInt(process.env.TRANSCRIBE_TIMEOUT_MS, 480_000);

    const BEST_OF_FAST = safeInt(process.env.TRANSCRIBE_BEST_OF, 1);
    const BEST_OF_RETRY = safeInt(process.env.TRANSCRIBE_BEST_OF_RETRY, 3);

    const TEMPERATURE = 0;
    const INITIAL_PROMPT = (process.env.WHISPER_INITIAL_PROMPT || "").toString().trim();

    // anty-loop / cisza
    const CONDITION_ON_PREV = (process.env.WHISPER_CONDITION_ON_PREVIOUS_TEXT || "false").toLowerCase() === "true";
    const COMP_RATIO = safeFloat(process.env.WHISPER_COMPRESSION_RATIO_THRESHOLD, 2.2);
    const NO_SPEECH = safeFloat(process.env.WHISPER_NO_SPEECH_THRESHOLD, 0.55);

    function boolTF(v: boolean) {
      return v ? "True" : "False";
}


    // Run 1
    const r1 = await runMlxWhisper({
      audioAbsPath,
      tmpRootId: `${examId}-${runId}-r1`,
      model: MODEL,
      lang: LANG,
      timeoutMs: TIMEOUT_MS,
      bestOf: BEST_OF_FAST,
      temperature: TEMPERATURE,
      initialPrompt: INITIAL_PROMPT,
      bin: MLX,
      conditionOnPreviousText: CONDITION_ON_PREV,
      compressionRatioThreshold: COMP_RATIO,
      noSpeechThreshold: NO_SPEECH,
    });

    let finalRun = r1;

    const shouldRetry =
      (r1.transcript.trim().length === 0 || r1.quality.score < 65 || r1.quality.flags.includes("QUALITY_LOW")) &&
      BEST_OF_RETRY > BEST_OF_FAST;

    if (shouldRetry) {
      const r2 = await runMlxWhisper({
        audioAbsPath,
        tmpRootId: `${examId}-${runId}-r2`,
        model: MODEL,
        lang: LANG,
        timeoutMs: TIMEOUT_MS,
        bestOf: BEST_OF_RETRY,
        temperature: TEMPERATURE,
        initialPrompt: INITIAL_PROMPT,
        bin: MLX,
        conditionOnPreviousText: CONDITION_ON_PREV,
        compressionRatioThreshold: COMP_RATIO,
        noSpeechThreshold: NO_SPEECH,
      });

      finalRun = r2.quality.score >= r1.quality.score ? r2 : r1;
    }

    const finishedAt = nowIso();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    if (!finalRun.transcriptRaw || finalRun.transcript.trim().length === 0) {
      // zapisz run info jako błąd
      await examRef.update({
        transcriptError: {
          at: nowIso(),
          message: "No transcript produced",
          exitCode: finalRun.exitCode,
          signal: finalRun.signal,
          stderrPreview: preview(finalRun.stderr, 3000),
          stdoutPreview: preview(finalRun.stdout, 1600),
          filesPreview: finalRun.filesPreview,
          tmpDir: finalRun.tmpDir,
          argsPreview: finalRun.argsPreview.slice(0, 60),
        },
        transcriptMeta: {
          lastRunId: runId,
          lastRunAt: nowIso(),
          model: MODEL,
          language: LANG,
          temperature: TEMPERATURE,
          bestOf: BEST_OF_FAST,
          bestOfRetry: BEST_OF_RETRY,
          initialPromptUsed: INITIAL_PROMPT ? true : false,
          conditionOnPreviousText: CONDITION_ON_PREV,
          compressionRatioThreshold: COMP_RATIO,
          noSpeechThreshold: NO_SPEECH,
          offline: true,
          bin: MLX,
          audioChosenPath: chosenRelPath,
          audioWasPreprocessed: mode === "preprocessed",
          durationMs,
        },
        updatedAt: FieldValue.serverTimestamp(),
      });

      return NextResponse.json(
        {
          ok: false,
          error: "No transcript produced",
          exitCode: finalRun.exitCode,
          signal: finalRun.signal,
          stderr: preview(finalRun.stderr, 3500),
          stdout: preview(finalRun.stdout, 1800),
          tmpDir: finalRun.tmpDir,
          filesPreview: finalRun.filesPreview,
          argsPreview: finalRun.argsPreview,
        },
        { status: 500 }
      );
    }

    const transcriptRaw = finalRun.transcriptRaw;
    const transcript = finalRun.transcript;
    const q = finalRun.quality;

    const alertLevel =
      q.score < 55 ? "critical" :
      q.score < 65 ? "warn" :
      q.score < 75 ? "info" :
      "ok";

    await examRef.update({
      transcriptRaw,
      transcript,
      transcribedAt: new Date(),
      transcriptQuality: q,
      transcriptMeta: {
        lastRunId: runId,
        lastRunAt: nowIso(),
        model: MODEL,
        language: LANG,
        temperature: TEMPERATURE,
        bestOf: BEST_OF_FAST,
        bestOfRetry: BEST_OF_RETRY,
        initialPromptUsed: INITIAL_PROMPT ? true : false,
        conditionOnPreviousText: CONDITION_ON_PREV,
        compressionRatioThreshold: COMP_RATIO,
        noSpeechThreshold: NO_SPEECH,
        offline: true,
        bin: MLX,
        audioChosenPath: chosenRelPath,
        audioWasPreprocessed: mode === "preprocessed",
        qualityScore: q.score,
        qualityFlags: q.flags,
        alertLevel,
        durationMs,
      },
      transcriptRuns: FieldValue.arrayUnion({
        runId,
        at: startedAt,
        finishedAt,
        durationMs,
        audioSource: mode,
        audioPathRel: chosenRelPath,
        audioAbsPath,
        model: MODEL,
        language: LANG,
        temperature: TEMPERATURE,
        bestOf: BEST_OF_FAST,
        bestOfRetry: BEST_OF_RETRY,
        initialPromptUsed: INITIAL_PROMPT ? true : false,
        conditionOnPreviousText: CONDITION_ON_PREV,
        compressionRatioThreshold: COMP_RATIO,
        noSpeechThreshold: NO_SPEECH,
        offline: true,
        exitCode: finalRun.exitCode,
        signal: finalRun.signal,
        stderrPreview: preview(finalRun.stderr, 900),
        stdoutPreview: preview(finalRun.stdout, 600),
        score: q.score,
        flags: q.flags,
        metrics: q.metrics,
        transcriptRawChars: transcriptRaw.length,
        transcriptChars: transcript.length,
      }),
      updatedAt: FieldValue.serverTimestamp(),
    });

    return NextResponse.json({
      ok: true,
      patientId,
      examId,
      audioUsed: chosenRelPath,
      audioSource: mode,
      transcriptPreview: preview(transcript, 900),
      qualityScore: q.score,
      qualityFlags: q.flags,
      alertLevel,
      sttMeta: {
        runId,
        model: MODEL,
        language: LANG,
        durationMs,
        offline: true,
        initialPromptUsed: INITIAL_PROMPT ? true : false,
        stderrPreview: preview(finalRun.stderr, 600),
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error", name: e?.name || "Error" },
      { status: 500 }
    );
  }
}

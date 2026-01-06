// app/api/exams/transcribe/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const MLX_WHISPER_BIN =
  process.env.MLX_WHISPER_BIN || `${process.env.HOME}/Library/Python/3.9/bin/mlx_whisper`;

const WHISPER_MODEL = process.env.WHISPER_MODEL || "mlx-community/whisper-large-v3-turbo";
const DEFAULT_LANGUAGE = process.env.WHISPER_LANGUAGE || "pl";
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 5 * 60 * 1000);

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

function runMlxWhisperTranscribe(audioAbsPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const cliArgs = [
      audioAbsPath,
      "--task",
      "transcribe",
      "--model",
      WHISPER_MODEL,
      "--language",
      DEFAULT_LANGUAGE,
      "--output-format",
      "txt",
    ];

    const child = spawn(MLX_WHISPER_BIN, cliArgs, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    });

    let stdout = "";
    let stderr = "";

    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`Transcription timeout after ${TRANSCRIBE_TIMEOUT_MS}ms`));
    }, TRANSCRIBE_TIMEOUT_MS);

    child.stdout.on("data", (d) => (stdout += d.toString()));
    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timeout);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timeout);

      const text = (stdout || "")
        .split("\n")
        .filter((line) => !line.startsWith("Args:"))
        .join("\n")
        .trim();

      // PoC: jeśli stdout ma treść, uznajemy sukces nawet przy code != 0
      if (text) return resolve(text);

      reject(new Error(`mlx_whisper failed (code=${code}). stderr:\n${stderr}\nstdout:\n${stdout}`));
    });
  });
}

/**
 * Postprocess — usuwa typowe timestampy i porządkuje tekst.
 */
function postprocessTranscript(raw: string) {
  const lines = raw
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

// ===================== Transcript quality scoring =====================

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

  // Powtórzenia — łagodzimy dla "uspokajaczy"
  const filler = new Set([
    "spokojnie",
    "super",
    "dobrze",
    "tak",
    "no",
    "witam",
    "już",
    "chwila",
    "ok",
    "idealnie",
    "proszę",
    "leżymy",
    "leż",
    "ładnie",
    "brawo",
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

  // Heurystyka "nie-słownikowych" tokenów
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

  // Obecność kluczowych narządów
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

  // Podejrzane terminy
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

  // Score
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

// ===================== runs saved in Firestore =====================

type TranscriptionRun = {
  runId: string;
  createdAt: Date;
  audioSource: "raw" | "preprocessed";
  audioPathRel: string;
  audioAbsPath: string;
  transcriptRaw: string;
  transcript: string;
  score: number;
  flags: string[];
  metrics: any;
  sttMeta: any;
};

async function fileExists(p: string) {
  try {
    await fs.access(p);
    return true;
  } catch {
    return false;
  }
}

function makeRunId(prefix: "raw" | "pre") {
  return `${prefix}-${new Date().toISOString().replace(/[:.]/g, "-")}`;
}

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId, force, usePreprocessed } = (await req.json()) as {
      patientId?: string;
      examId?: string;
      force?: "raw" | "auto" | "preprocessed";
      usePreprocessed?: boolean; // compatibility
    };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    // IMPORTANT: w tej wersji "auto" = RAW (żeby nie tracić czasu).
    // Preprocess uruchamiasz tylko force=preprocessed albo usePreprocessed=true.
    const mode = (usePreprocessed ? "preprocessed" : force || "auto") as "raw" | "auto" | "preprocessed";

    const adminDb = await getAdminDb();
    const examRef = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await examRef.get();

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;

    const originalRelPath: string | undefined = exam?.recording?.localPath;
    const preprocessedRelPath: string | undefined = exam?.recording?.preprocessedLocalPath;

    if (!originalRelPath) {
      return NextResponse.json(
        { error: "No recording path in exam (localPath missing)" },
        { status: 400 }
      );
    }

    const chosenRelPath =
      mode === "preprocessed" && preprocessedRelPath ? preprocessedRelPath : originalRelPath;

    const audioAbsPath = path.isAbsolute(chosenRelPath)
      ? chosenRelPath
      : path.join(process.cwd(), chosenRelPath);

    if (!(await fileExists(audioAbsPath))) {
      return NextResponse.json(
        { error: "Audio file not found on disk", audioAbsPath, chosenRelPath },
        { status: 404 }
      );
    }

    const runId = makeRunId(mode === "preprocessed" ? "pre" : "raw");
    const t0 = Date.now();

    const transcriptRaw = await runMlxWhisperTranscribe(audioAbsPath);
    const transcript = postprocessTranscript(transcriptRaw);
    const q = computeTranscriptQuality(transcript, transcriptRaw);

    const run: TranscriptionRun = {
      runId,
      createdAt: new Date(),
      audioSource: mode === "preprocessed" ? "preprocessed" : "raw",
      audioPathRel: chosenRelPath,
      audioAbsPath,
      transcriptRaw,
      transcript,
      score: q.score,
      flags: q.flags,
      metrics: q.metrics,
      sttMeta: {
        modelUsed: WHISPER_MODEL,
        language: DEFAULT_LANGUAGE,
        engine: "mlx-whisper",
        transcribeMs: Date.now() - t0,
      },
    };

    const decision =
      mode === "preprocessed" ? "preprocess_forced" :
      mode === "raw" ? "raw_forced" :
      "raw_only";

    const alertLevel =
      run.score < 55 ? "critical" :
      run.score < 65 ? "warn" :
      run.score < 75 ? "info" :
      "ok";

    await examRef.update({
      transcriptRaw: run.transcriptRaw,
      transcript: run.transcript,
      transcribedAt: new Date(),
      transcriptQuality: q,
      transcriptMeta: {
        modelUsed: WHISPER_MODEL,
        language: DEFAULT_LANGUAGE,
        engine: "mlx-whisper",
        audioChosenPath: chosenRelPath,
        audioWasPreprocessed: run.audioSource === "preprocessed",
        qualityScore: run.score,
        qualityFlags: run.flags,
        decision,
        alertLevel,
      },
      transcription: {
        version: "transcription-v1-lite",
        decision,
        activeRunId: run.runId,
        runs: { [run.runId]: run },
        updatedAt: new Date(),
      },
      updatedAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      patientId,
      examId,
      decision,
      alertLevel,
      transcriptPreview: (run.transcript || "").slice(0, 300),
      qualityScore: run.score,
      qualityFlags: run.flags,
      audioUsed: run.audioPathRel,
      audioAbsPathUsed: run.audioAbsPath,
      audioSource: run.audioSource,
    });
  } catch (err: any) {
    console.error("TRANSCRIBE ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

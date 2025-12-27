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

  const app =
    getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });

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

      reject(
        new Error(`mlx_whisper failed (code=${code}). stderr:\n${stderr}\nstdout:\n${stdout}`)
      );
    });
  });
}

/**
 * Część C: postprocess — usuwa typowe timestampy i porządkuje tekst.
 * Cel: transcript (czysty) + transcriptRaw (debug).
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

// ===================== Transcript quality scoring (Commit 1) =====================

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

/**
 * Minimalny, deterministyczny scoring jakości transkrypcji.
 * Cel:
 * - wykryć "szumy/bełkot" (dużo tokenów nie-słownikowych, powtórzeń),
 * - wykryć brak kluczowych narządów,
 * - dać prostą skalę pod alerty UI.
 *
 * To NIE jest ocena medyczna, tylko ocena czy tekst nadaje się jako wejście do raportu.
 */
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

  // Tokenizacja (stabilna, prosta)
  const tokens = clean
    .toLowerCase()
    .replace(/[“”„"]/g, '"')
    .replace(/[^\p{L}\p{N}\s-]+/gu, " ")
    .split(/\s+/)
    .filter(Boolean);

  const tokenCount = tokens.length;

  // 1) Powtórzenia — łagodzimy dla "uspokajaczy" (gabinet)
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

    // pomijamy powtórzenia fillerów
    if (cur === prev && !filler.has(cur)) adjacentRepeats++;

    if (i >= 2) {
      const prev2 = tokens[i - 2];
      if (cur === prev2 && !filler.has(cur)) repeatPairs++; // A B A
    }
  }

  // łagodniejsza metryka niż wcześniej (bez *2)
  const repetitionScore = Math.min(1, (adjacentRepeats + repeatPairs) / Math.max(1, tokenCount));

  if (repetitionScore > 0.10) flags.push("MANY_REPETITIONS");
  if (repetitionScore > 0.22) flags.push("HEAVY_REPETITIONS");

  // 2) Heurystyka "nie-słownikowych" tokenów (bełkot / zlepki)
  const vowels = /[aeiouyąęó]/;
  const isWeirdToken = (t: string) => {
    if (t.length <= 2) return false;
    if (t.length >= 20) return true;
    // brak samogłoski w tokenie z literami
    if (/^\p{L}+$/u.test(t) && !vowels.test(t)) return true;
    // podejrzane zlepki (częste w "bełkocie")
    if (/(wty|tsym|rzq|xq|qq|jjj)/.test(t)) return true;
    return false;
  };

  const weirdCount = tokens.reduce((acc, t) => acc + (isWeirdToken(t) ? 1 : 0), 0);
  const unknownTokenRatio = tokenCount > 0 ? weirdCount / tokenCount : 1;

  if (unknownTokenRatio > 0.06) flags.push("MANY_UNKNOWN_TOKENS");
  if (unknownTokenRatio > 0.12) flags.push("HEAVY_UNKNOWN_TOKENS");

  // 3) Obecność kluczowych narządów (heurystyka)
  const organPatterns: Array<[string, RegExp]> = [
    ["liver", /\bwątroba\b/u],
    ["gb", /\bpęcherzyk\b[\s\S]{0,40}\bż[óo]łciow/u],
    ["spleen", /\bśledziona\b/u],
    ["kidneys", /\bnerk[ai]|\bnerki\b/u],
    ["bladder", /\bpęcherz\b.*\bmoczow/u],
    ["intestines", /\bjelit\w*/u], // jelita/jelito/jelitach...
    ["pancreas", /\btrzustk\w*/u], // trzustka/trzustki...
  ];

  const cleanLower = clean.toLowerCase();
  const organHitCount = organPatterns.reduce((acc, [, rx]) => acc + (rx.test(cleanLower) ? 1 : 0), 0);
  const organHitRatio = organHitCount / organPatterns.length;

  if (organHitCount <= 2) flags.push("LOW_ORGAN_COVERAGE");
  if (organHitCount <= 1) flags.push("VERY_LOW_ORGAN_COVERAGE");

  // 4) Podejrzane terminy (sygnał ryzyka)
  const suspiciousPatterns: RegExp[] = [
    /\bmocznik\s+(powiększon|wypełnion|ścian)/u,
    /\bws?g\b/u, // WSG zamiast USG
    /\bszóstk[ai]\b/u, // "szóstka" zamiast trzustka
    /\bżujic\b/u,
    /\bpręg\s+żółciow/u,
  ];
  let suspiciousBigramCount = 0;
  for (const rx of suspiciousPatterns) {
    if (rx.test(cleanLower)) suspiciousBigramCount++;
  }
  if (suspiciousBigramCount >= 1) flags.push("SUSPICIOUS_TERMS");
  if (suspiciousBigramCount >= 3) flags.push("MANY_SUSPICIOUS_TERMS");

  // 5) Score 0..100 (ważone)
  const organComponent = organHitRatio; // 0..1
  const unknownComponent = 1 - Math.min(1, unknownTokenRatio * 6); // 0..1

  // BYŁO: repetitionScore * 4 (za mocno)
  const repetitionComponent = 1 - Math.min(1, repetitionScore * 2.5); // 0..1

  const lengthComponent = Math.min(1, clean.length / 600); // 0..1

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

// ============================================================================

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId } = (await req.json()) as {
      patientId?: string;
      examId?: string;
    };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();

    const examRef = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await examRef.get();

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;
    const localPath: string | undefined = exam?.recording?.localPath;

    if (!localPath) {
      return NextResponse.json({ error: "No recording.localPath in exam" }, { status: 400 });
    }

    const audioAbsPath = path.isAbsolute(localPath) ? localPath : path.join(process.cwd(), localPath);

    try {
      await fs.access(audioAbsPath);
    } catch {
      return NextResponse.json(
        { error: "Audio file not found on disk", audioAbsPath, localPath },
        { status: 404 }
      );
    }

    // --- C: raw + clean ---
    const transcriptRaw = await runMlxWhisperTranscribe(audioAbsPath);
    const transcript = postprocessTranscript(transcriptRaw);

    const transcriptQuality = computeTranscriptQuality(transcript, transcriptRaw);

    await examRef.update({
      transcriptRaw,
      transcript,
      transcribedAt: new Date(),
      transcriptQuality,
      transcriptMeta: {
        modelUsed: WHISPER_MODEL,
        language: DEFAULT_LANGUAGE,
        engine: "mlx-whisper",
        audioLocalPath: localPath,
        qualityScore: transcriptQuality.score,
        qualityFlags: transcriptQuality.flags,
      },
    });

    return NextResponse.json({
      ok: true,
      patientId,
      examId,
      transcriptPreview: transcript.slice(0, 300),
      qualityScore: transcriptQuality.score,
      qualityFlags: transcriptQuality.flags,
    });
  } catch (err: any) {
    console.error("TRANSCRIBE ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

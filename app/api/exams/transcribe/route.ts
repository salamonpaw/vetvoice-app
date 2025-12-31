// app/api/exams/transcribe/route.ts
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
    const LANG = (process.env.WHISPER_LANGUAGE || "pl").toString();
    const TIMEOUT_MS = safeInt(process.env.TRANSCRIBE_TIMEOUT_MS, 480_000);
    const BEST_OF = safeInt(process.env.TRANSCRIBE_BEST_OF, 3);
    const TEMPERATURE = 0;

    const tmpDir = path.join(os.tmpdir(), `vetvoice-stt-${examId}-${runId}`);
    await fs.mkdir(tmpDir, { recursive: true });

    const args = [
      audioAbsPath,
      "--task","transcribe",
      "--model", MODEL,
      "--language", LANG,
      "--output-format","txt",
      "--output-dir", tmpDir,
      "--temperature", String(TEMPERATURE),
      "--best-of", String(BEST_OF),
    ];

    let stdout = "";
    let stderr = "";

    const child = spawn(MLX, args, {
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
        }, TIMEOUT_MS)
      ),
    ]);

    const finishedAt = nowIso();
    const durationMs = new Date(finishedAt).getTime() - new Date(startedAt).getTime();

    const files = await fs.readdir(tmpDir).catch(() => []);
    const txt = files.find((f) => f.endsWith(".txt"));

    if (!txt) {
      // zapisz run info jako błąd
      await examRef.update({
        transcriptError: {
          at: nowIso(),
          message: "No transcript produced",
          exitCode: exit.code,
          signal: exit.signal,
          stderrPreview: preview(stderr, 1600),
          stdoutPreview: preview(stdout, 800),
        },
        transcriptMeta: {
          lastRunId: runId,
          lastRunAt: nowIso(),
          model: MODEL,
          language: LANG,
          temperature: TEMPERATURE,
          bestOf: BEST_OF,
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
          exitCode: exit.code,
          signal: exit.signal,
          stderr: preview(stderr, 1800),
          stdout: preview(stdout, 900),
        },
        { status: 500 }
      );
    }

    const transcriptRaw = (await fs.readFile(path.join(tmpDir, txt), "utf8")).toString().trim();
    const transcript = postprocessTranscript(transcriptRaw);
    const q = computeTranscriptQuality(transcript, transcriptRaw);

    // sprzątanie (best effort)
    fs.rm(tmpDir, { recursive: true, force: true }).catch(() => {});

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
        bestOf: BEST_OF,
        offline: true,
        bin: MLX,
        audioChosenPath: chosenRelPath,
        audioWasPreprocessed: mode === "preprocessed",
        qualityScore: q.score,
        qualityFlags: q.flags,
        alertLevel,
        durationMs,
      },
      // historia uruchomień — prosto i bez ryzyka nadpisania
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
        bestOf: BEST_OF,
        offline: true,
        exitCode: exit.code,
        signal: exit.signal,
        stderrPreview: preview(stderr, 900),
        stdoutPreview: preview(stdout, 600),
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
        stderrPreview: preview(stderr, 600),
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message || "Unknown error", name: e?.name || "Error" },
      { status: 500 }
    );
  }
}

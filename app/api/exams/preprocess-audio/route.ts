// app/api/exams/preprocess-audio/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";
import { spawn } from "child_process";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const FFMPEG_BIN = process.env.FFMPEG_BIN || "ffmpeg";
const PREPROCESS_TIMEOUT_MS = Number(process.env.PREPROCESS_TIMEOUT_MS || 2 * 60 * 1000);

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

function ensureDir(p: string) {
  return fs.mkdir(p, { recursive: true });
}

function runFfmpeg(args: string[], timeoutMs: number) {
  return new Promise<{ ok: true }>((resolve, reject) => {
    const child = spawn(FFMPEG_BIN, args, { stdio: ["ignore", "ignore", "pipe"] });

    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`ffmpeg timeout after ${timeoutMs}ms`));
    }, timeoutMs);

    child.stderr.on("data", (d) => (stderr += d.toString()));

    child.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });

    child.on("close", (code) => {
      clearTimeout(timer);
      if (code === 0) return resolve({ ok: true });
      reject(new Error(`ffmpeg failed (code=${code}). stderr:\n${stderr.slice(0, 2000)}`));
    });
  });
}

function buildOutPath(inputAbs: string) {
  const dir = path.dirname(inputAbs);
  const base = path.basename(inputAbs);
  const ext = (base.split(".").pop() || "wav").toLowerCase();

  // Zapisuj jako WAV (PCM) – stabilne dla STT
  const outName = base.replace(new RegExp(`\\.${ext}$`, "i"), "") + `.clean.wav`;
  return path.join(dir, outName);
}

/**
 * Preprocess (SAFE MODE - default):
 * - resample do 16k
 * - mono
 * - loudnorm wyłączony tutaj (tylko konwersja)
 */
function ffmpegArgs(inAbs: string, outAbs: string) {
  return [
    "-y",
    "-i",
    inAbs,

    "-vn",
    "-hide_banner",
    "-loglevel",
    "error",

    // tylko konwersja do formatu stabilnego dla STT
    "-acodec",
    "pcm_s16le",
    "-ar",
    "16000",
    "-ac",
    "1",

    outAbs,
  ];
}

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId } = (await req.json()) as { patientId?: string; examId?: string };

    if (!patientId || !examId) {
      return NextResponse.json({ ok: false, error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();
    const examRef = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await examRef.get();

    if (!snap.exists) {
      return NextResponse.json({ ok: false, error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;
    const localPath: string | undefined = exam?.recording?.localPath;
    if (!localPath) {
      return NextResponse.json({ ok: false, error: "No recording.localPath in exam" }, { status: 400 });
    }

    const inputAbs = path.isAbsolute(localPath) ? localPath : path.join(process.cwd(), localPath);

    try {
      await fs.access(inputAbs);
    } catch {
      return NextResponse.json(
        { ok: false, error: "Audio file not found on disk", inputAbs, localPath },
        { status: 404 }
      );
    }

    // out in the same dir
    const outAbs = buildOutPath(inputAbs);
    await ensureDir(path.dirname(outAbs));

    const started = Date.now();
    const args = ffmpegArgs(inputAbs, outAbs);
    await runFfmpeg(args, PREPROCESS_TIMEOUT_MS);
    const tookMs = Date.now() - started;

    // rel path for later reads
    const outRel = path.relative(process.cwd(), outAbs).split(path.sep).join("/");

    await examRef.update({
      recording: {
        ...(exam?.recording || {}),
        preprocessedLocalPath: outRel,
        preprocessMeta: {
          engine: "ffmpeg",
          ffmpegBin: FFMPEG_BIN,
          outFormat: "wav pcm_s16le",
          sampleRate: 16000,
          channels: 1,
          filterMode: "safe",
          filter: "aresample=16000,aformat=mono,highpass=80,lowpass=8000,loudnorm=I=-16:TP=-1.5:LRA=11",
          latencyMs: tookMs,
          processedAt: new Date(),
        },
      },
      updatedAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      patientId,
      examId,
      input: localPath,
      output: outRel,
      latencyMs: tookMs,
    });
  } catch (err: any) {
    console.error("PREPROCESS ERROR:", err);
    return NextResponse.json({ ok: false, error: err?.message || "Unknown error" }, { status: 500 });
  }
}

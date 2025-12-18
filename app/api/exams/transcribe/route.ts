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

const WHISPER_MODEL =
  process.env.WHISPER_MODEL || "mlx-community/whisper-large-v3-turbo";

const DEFAULT_LANGUAGE = process.env.WHISPER_LANGUAGE || "pl";
const TRANSCRIBE_TIMEOUT_MS = Number(process.env.TRANSCRIBE_TIMEOUT_MS || 5 * 60 * 1000);

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount) });

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
        new Error(
          `mlx_whisper failed (code=${code}). stderr:\n${stderr}\nstdout:\n${stdout}`
        )
      );
    });
  });
}

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId } = (await req.json()) as {
      patientId?: string;
      examId?: string;
    };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    // ✅ TO JEST KLUCZOWA POPRAWKA:
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

    const audioAbsPath = path.isAbsolute(localPath)
      ? localPath
      : path.join(process.cwd(), localPath);

    try {
      await fs.access(audioAbsPath);
    } catch {
      return NextResponse.json(
        { error: "Audio file not found on disk", audioAbsPath, localPath },
        { status: 404 }
      );
    }

    const transcriptRaw = await runMlxWhisperTranscribe(audioAbsPath);

    await examRef.update({
      transcript: transcriptRaw,
      transcribedAt: new Date(),
      transcriptMeta: {
        modelUsed: WHISPER_MODEL,
        language: DEFAULT_LANGUAGE,
        engine: "mlx-whisper",
        audioLocalPath: localPath,
      },
    });

    return NextResponse.json({
      ok: true,
      patientId,
      examId,
      transcriptPreview: transcriptRaw.slice(0, 300),
    });
  } catch (err: any) {
    console.error("TRANSCRIBE ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

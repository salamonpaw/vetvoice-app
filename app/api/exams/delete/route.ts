// app/api/exams/delete/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function safeErrorMessage(err: unknown) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const anyErr = err as any;
    if (anyErr?.message) return String(anyErr.message);
    if (anyErr?.error) return String(anyErr.error);
  }
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

async function safeUnlink(p?: string | null) {
  if (!p) return { ok: true, path: null, removed: false };
  try {
    await fs.unlink(p);
    return { ok: true, path: p, removed: true };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: true, path: p, removed: false };
    return { ok: false, path: p, removed: false, error: e?.message || String(e) };
  }
}

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      clinicId?: string;
      patientId?: string;
      examId?: string;
      deleteLocalFiles?: boolean;
    };

    const { clinicId, patientId, examId } = body;
    const deleteLocalFiles = Boolean(body?.deleteLocalFiles);

    if (!patientId || !examId) {
      return NextResponse.json({ ok: false, error: "Missing patientId or examId" }, { status: 400 });
    }

    const db = await getAdminDb();

    const refA = db.doc(`patients/${patientId}/exams/${examId}`);
    const refB = clinicId ? db.doc(`clinics/${clinicId}/patients/${patientId}/exams/${examId}`) : null;

    let ref = refA;
    let snap = await refA.get();
    if (!snap.exists && refB) {
      ref = refB;
      snap = await refB.get();
    }

    if (!snap.exists) {
      return NextResponse.json(
        { ok: false, error: "Exam not found", tried: { pathA: refA.path, pathB: refB?.path ?? null } },
        { status: 404 }
      );
    }

    const exam = snap.data() as any;

    const fileResults: any[] = [];
    if (deleteLocalFiles) {
      const absMain = exam?.recording?.absolutePath ? String(exam.recording.absolutePath) : null;

      const pre = exam?.recording?.preprocessedLocalPath ? String(exam.recording.preprocessedLocalPath) : null;
      const preAbs = pre && !pre.startsWith("/") ? path.join(process.cwd(), pre) : pre;

      fileResults.push({ kind: "recording.absolutePath", ...(await safeUnlink(absMain)) });
      fileResults.push({ kind: "recording.preprocessedLocalPath", ...(await safeUnlink(preAbs)) });
    }

    await ref.delete();

    return NextResponse.json({
      ok: true,
      deletedDocPath: ref.path,
      deleteLocalFiles,
      files: fileResults,
    });
  } catch (e: any) {
    const message = safeErrorMessage(e);
    console.error("DELETE EXAM ERROR:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

// app/api/exams/delete/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

type DeleteExamBody = {
  clinicId?: string;
  patientId?: string;
  examId?: string;
  deleteLocalFiles?: boolean;
};

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

/**
 * Dozwolony katalog danych (PoC) – wszystko co kasujemy MUSI być pod tym prefixem.
 * Wg Twojej koncepcji: /data/clinics/... (ale jako minimum chronimy /data)
 */
const DATA_ROOT_ABS = path.resolve(process.cwd(), "data");

/**
 * Zamienia dowolną ścieżkę (abs/rel) na absolutną + sprawdza, czy mieści się w DATA_ROOT_ABS.
 * Jeśli nie – blokuje kasowanie.
 */
function toSafeAbsPath(p?: string | null) {
  if (!p) return { ok: true as const, absPath: null as string | null, blocked: false as const };

  const raw = String(p).trim();
  if (!raw) return { ok: true as const, absPath: null as string | null, blocked: false as const };

  // Jeśli rel – traktujemy jako rel do cwd
  const abs = path.resolve(process.cwd(), raw);

  // Guard: nie kasujemy niczego poza /data
  const allowedPrefix = DATA_ROOT_ABS + path.sep;
  const isUnderDataRoot = abs === DATA_ROOT_ABS || abs.startsWith(allowedPrefix);

  if (!isUnderDataRoot) {
    return { ok: false as const, absPath: abs, blocked: true as const, error: "Path outside allowed data root" };
  }

  return { ok: true as const, absPath: abs, blocked: false as const };
}

async function safeUnlinkAbs(absPath?: string | null) {
  if (!absPath) return { ok: true, path: null, removed: false };
  try {
    await fs.unlink(absPath);
    return { ok: true, path: absPath, removed: true };
  } catch (e: any) {
    if (e?.code === "ENOENT") return { ok: true, path: absPath, removed: false };
    return { ok: false, path: absPath, removed: false, error: e?.message || String(e) };
  }
}

async function readBody(req: NextRequest): Promise<DeleteExamBody> {
  // DELETE bywa bez body; u Ciebie UI woła POST, ale dodajemy kompatybilność.
  try {
    const txt = await req.text();
    if (!txt) return {};
    return JSON.parse(txt);
  } catch {
    return {};
  }
}

async function handleDelete(req: NextRequest) {
  try {
    const body = await readBody(req);

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

    // ===== Cleanup plików lokalnych (opcjonalnie) =====
    const fileResults: any[] = [];
    const warnings: string[] = [];

    if (deleteLocalFiles) {
      const storage = exam?.recording?.storage ? String(exam.recording.storage) : "local";

      if (storage !== "local") {
        warnings.push(`deleteLocalFiles requested, but recording.storage="${storage}" (skipping local deletion)`);
      } else {
        // Zbieramy kandydatów: absolutePath, localPath, preprocessedLocalPath
        const candidates: Array<{ kind: string; value: string | null }> = [
          { kind: "recording.absolutePath", value: exam?.recording?.absolutePath ? String(exam.recording.absolutePath) : null },
          { kind: "recording.localPath", value: exam?.recording?.localPath ? String(exam.recording.localPath) : null },
          { kind: "recording.preprocessedLocalPath", value: exam?.recording?.preprocessedLocalPath ? String(exam.recording.preprocessedLocalPath) : null },
        ];

        for (const c of candidates) {
          if (!c.value) {
            fileResults.push({ kind: c.kind, ok: true, path: null, removed: false, skipped: true });
            continue;
          }

          const safe = toSafeAbsPath(c.value);
          if (!safe.ok) {
            fileResults.push({
              kind: c.kind,
              ok: false,
              path: safe.absPath,
              removed: false,
              blocked: true,
              error: safe.error,
            });
            warnings.push(`Blocked deletion for ${c.kind} (outside data root): ${safe.absPath}`);
            continue;
          }

          fileResults.push({ kind: c.kind, ...(await safeUnlinkAbs(safe.absPath)) });
        }
      }
    }

    // ===== Usunięcie dokumentu exam =====
    await ref.delete();

    return NextResponse.json({
      ok: true,
      deletedDocPath: ref.path,
      deleteLocalFiles,
      dataRoot: DATA_ROOT_ABS,
      files: fileResults,
      warnings,
    });
  } catch (e: any) {
    console.error("DELETE EXAM ERROR:", e);
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}

// Kompatybilność wstecz: UI może wołać POST
export async function POST(req: NextRequest) {
  return handleDelete(req);
}

// Lepsza semantyka REST: DELETE też działa
export async function DELETE(req: NextRequest) {
  return handleDelete(req);
}

export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION = "report-v7-scalable";

// ---------- FIREBASE ----------
async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) {
    throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");
  }

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

function section(v?: string | null) {
  return v && v.trim() ? v.trim() : "—";
}

// ---------- REPORT BUILDERS ----------
function buildAbnormalReport(examType: string, a: any) {
  return [
    `RAPORT BADANIA: ${examType}`,
    ``,
    `Powód wizyty:`,
    section(a.sections.reason),
    ``,
    `Opis badania:`,
    section(a.sections.findings),
    ``,
    a.keyFindings?.length
      ? ["Najważniejsze ustalenia:", ...a.keyFindings.map((x: string) => `- ${x}`)].join("\n")
      : "",
    ``,
    `Wnioski:`,
    section(a.sections.conclusions),
    ``,
    `Zalecenia:`,
    section(a.sections.recommendations),
    ``,
    `---`,
    `Raport wygenerowany automatycznie.`,
  ].join("\n");
}

function buildNormalReport(examType: string, a: any) {
  const of = a.organFindings || {};
  return [
    `RAPORT BADANIA: ${examType}`,
    ``,
    `Powód wizyty:`,
    section(a.sections.reason),
    ``,
    `Opis badania (USG w normie):`,
    Object.entries(of)
      .map(([k, v]) => `- ${k}: ${v === "normal" ? "bez odchyleń" : "—"}`)
      .join("\n"),
    ``,
    `Wnioski:`,
    `Nie stwierdzono istotnych odchyleń od normy.`,
    ``,
    `Zalecenia:`,
    `Brak szczególnych zaleceń. Kontrola w razie objawów klinicznych.`,
    ``,
    `---`,
    `Raport wygenerowany automatycznie.`,
  ].join("\n");
}

// ---------- ROUTE ----------
export async function POST(req: NextRequest) {
  try {
    const { patientId, examId, clinicId } = await req.json();
    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing IDs" }, { status: 400 });
    }

    const db = await getAdminDb();

    const refA = db.doc(`patients/${patientId}/exams/${examId}`);
    const refB = clinicId
      ? db.doc(`clinics/${clinicId}/patients/${patientId}/exams/${examId}`)
      : null;

    let ref = refA;
    let snap = await refA.get();
    if (!snap.exists && refB) {
      ref = refB;
      snap = await refB.get();
    }
    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data()!;
    if (!exam.analysis) {
      return NextResponse.json({ error: "No analysis" }, { status: 400 });
    }

    const examType = exam.type || "USG jamy brzusznej";
    const report =
      exam.analysis.summaryType === "abnormal"
        ? buildAbnormalReport(examType, exam.analysis)
        : buildNormalReport(examType, exam.analysis);

    await ref.update({
      report,
      reportMeta: {
        version: REPORT_VERSION,
        summaryType: exam.analysis.summaryType,
        generatedAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("GENERATE REPORT ERROR:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

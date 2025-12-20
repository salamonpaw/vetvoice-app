export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION = "analysis-template-v2";

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

function section(value?: string | null) {
  return value && value.trim() ? value.trim() : "—";
}

function buildReportFromAnalysis(params: {
  examType?: string;
  sections: {
    reason?: string | null;
    findings?: string | null;
    conclusions?: string | null;
    recommendations?: string | null;
  };
}) {
  const examType = (params.examType || "Badanie").trim();
  const s = params.sections || {};

  return [
    `RAPORT BADANIA: ${examType}`,
    ``,
    `Powód wizyty:`,
    section(s.reason),
    ``,
    `Opis badania:`,
    section(s.findings),
    ``,
    `Wnioski:`,
    section(s.conclusions),
    ``,
    `Zalecenia:`,
    section(s.recommendations),
    ``,
    `---`,
    `Raport wygenerowany automatycznie na podstawie analizy transkrypcji.`,
  ].join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const { clinicId, patientId, examId } = (await req.json()) as {
      clinicId?: string;
      patientId?: string;
      examId?: string;
    };

    // clinicId opcjonalne (bo dane masz aktualnie bez clinics/)
    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();

    // Dual-path lookup (jak w analyze)
    const refA = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const refB = clinicId ? adminDb.doc(`clinics/${clinicId}/patients/${patientId}/exams/${examId}`) : null;

    let examRef = refA;
    let snap = await refA.get();

    if (!snap.exists && refB) {
      examRef = refB;
      snap = await refB.get();
    }

    if (!snap.exists) {
      return NextResponse.json(
        {
          error: "Exam not found",
          tried: {
            pathA: refA.path,
            pathB: refB?.path ?? null,
          },
        },
        { status: 404 }
      );
    }

    const exam = snap.data() as any;

    if (!exam?.analysis?.sections) {
      return NextResponse.json(
        { error: "Missing analysis.sections — run analyze first" },
        { status: 400 }
      );
    }

    const report = buildReportFromAnalysis({
      examType: exam?.type,
      sections: exam.analysis.sections,
    });

    await examRef.update({
      report,
      reportedAt: new Date(),
      reportMeta: {
        version: REPORT_VERSION,
        engine: "template-from-analysis",
        basedOn: "analysis.sections",
      },
    });

    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      reportPreview: report.slice(0, 500),
    });
  } catch (err: any) {
    console.error("GENERATE REPORT ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

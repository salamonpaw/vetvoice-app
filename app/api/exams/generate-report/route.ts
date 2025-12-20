// app/api/exams/generate-report/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * Wersja generatora raportu (B2 – heurystyczny, bez LLM)
 */
const REPORT_VERSION = "heuristic-v1";

/**
 * Firebase Admin (ładowany z pliku service account poza repo)
 */
async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) {
    throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");
  }

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

/* =========================
   Heurystyczny generator raportu (B2)
   ========================= */

function normalizeText(input: string) {
  return input.replace(/\r\n/g, "\n").trim();
}

function firstMatchLine(lines: string[], patterns: RegExp[]) {
  for (const line of lines) {
    const t = line.trim();
    for (const p of patterns) {
      const m = t.match(p);
      if (m?.[1]) return m[1].trim();
      if (m?.[2]) return m[2].trim();
    }
  }
  return undefined;
}

function collectAfterLabel(
  lines: string[],
  labelPatterns: RegExp[],
  stopPatterns: RegExp[]
) {
  const idx = lines.findIndex((l) =>
    labelPatterns.some((p) => p.test(l.trim()))
  );
  if (idx === -1) return undefined;

  const out: string[] = [];
  for (let i = idx + 1; i < lines.length; i++) {
    const t = lines[i].trim();
    if (!t) continue;
    if (stopPatterns.some((p) => p.test(t))) break;
    out.push(t);
    if (out.join(" ").length > 1200) break; // bezpiecznik
  }

  const joined = out.join(" ").trim();
  return joined ? joined : undefined;
}

function buildReportTemplate(params: {
  examType?: string;
  transcript: string;
}) {
  const examType = (params.examType || "Badanie").trim();
  const source = normalizeText(params.transcript || "");
  const lines = source
    .split("\n")
    .map((l) => l.trim())
    .filter(Boolean);

  // Etykiety PL (tolerujące warianty)
  const REASON_LABELS = [
    /^(pow[oó]d wizyty)[:\-]\s*$/i,
    /^(pow[oó]d)[:\-]\s*$/i,
  ];
  const FINDINGS_LABELS = [
    /^(opis badania)[:\-]\s*$/i,
    /^(opis)[:\-]\s*$/i,
  ];
  const CONC_LABELS = [
    /^(wnioski)[:\-]\s*$/i,
    /^(rozpoznanie)[:\-]\s*$/i,
  ];
  const RECO_LABELS = [
    /^(zalecenia)[:\-]\s*$/i,
    /^(rekomendacje)[:\-]\s*$/i,
  ];

  const STOP_LABELS = [
    /^(pow[oó]d wizyty)[:\-]/i,
    /^(opis badania)[:\-]/i,
    /^(wnioski)[:\-]/i,
    /^(zalecenia)[:\-]/i,
    /^(rekomendacje)[:\-]/i,
    /^[-—]{2,}$/i,
  ];

  const extracted = {
    reason: collectAfterLabel(lines, REASON_LABELS, STOP_LABELS),
    findings: collectAfterLabel(lines, FINDINGS_LABELS, STOP_LABELS),
    conclusions: collectAfterLabel(lines, CONC_LABELS, STOP_LABELS),
    recommendations: collectAfterLabel(lines, RECO_LABELS, STOP_LABELS),
  };

  // Fallbacki, gdy lekarz nie dyktował etykiet
  if (!extracted.recommendations) {
    extracted.recommendations = firstMatchLine(lines, [
      /^(zalecam)[:\-]?\s*(.+)$/i,
      /^(sugeruj[ęe])[:\-]?\s*(.+)$/i,
      /^(rekomenduj[ęe])[:\-]?\s*(.+)$/i,
    ]);
  }

  if (!extracted.conclusions) {
    extracted.conclusions = firstMatchLine(lines, [
      /^(wniosek)[:\-]?\s*(.+)$/i,
      /^(podsumowuj[ąa]c)[:\-]?\s*(.+)$/i,
      /^(rozpoznanie)[:\-]?\s*(.+)$/i,
    ]);
  }

  // Opis badania – fallback: zwięzły opis z całości
  if (!extracted.findings) {
    const compact = lines.join(" ");
    extracted.findings = compact ? compact.slice(0, 900).trim() : undefined;
  }

  // Powód wizyty – fallback: pierwsza sensowna linia
  if (!extracted.reason) {
    extracted.reason = lines[0] || "—";
  }

  const report = [
    `RAPORT BADANIA: ${examType}`,
    ``,
    `Powód wizyty:`,
    extracted.reason || "—",
    ``,
    `Opis badania:`,
    extracted.findings || "—",
    ``,
    `Wnioski:`,
    extracted.conclusions || "—",
    ``,
    `Zalecenia:`,
    extracted.recommendations || "—",
    ``,
    `---`,
    `Źródło (transkrypcja):`,
    source || "—",
  ].join("\n");

  const reportMeta = {
    version: REPORT_VERSION,
    engine: "heuristic",
    basedOn: "transcript",
    extracted: {
      reason: Boolean(extracted.reason),
      findings: Boolean(extracted.findings),
      conclusions: Boolean(extracted.conclusions),
      recommendations: Boolean(extracted.recommendations),
    },
  };

  return { report, reportMeta };
}

/* =========================
   POST /api/exams/generate-report
   ========================= */

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId } = (await req.json()) as {
      patientId?: string;
      examId?: string;
    };

    if (!patientId || !examId) {
      return NextResponse.json(
        { error: "Missing patientId or examId" },
        { status: 400 }
      );
    }

    const adminDb = await getAdminDb();
    const examRef = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await examRef.get();

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;
    const transcript: string | undefined = exam?.transcript;
    const examType: string | undefined = exam?.type;

    if (!transcript || !transcript.trim()) {
      return NextResponse.json(
        { error: "No transcript in exam (generate report requires transcript)" },
        { status: 400 }
      );
    }

    const { report, reportMeta } = buildReportTemplate({
      examType,
      transcript,
    });

    await examRef.update({
      report,
      reportedAt: new Date(),
      reportMeta,
    });

    return NextResponse.json({
      ok: true,
      patientId,
      examId,
      reportPreview: report.slice(0, 400),
    });
  } catch (err: any) {
    console.error("GENERATE REPORT ERROR:", err);
    return NextResponse.json(
      { error: err?.message || "Unknown error" },
      { status: 500 }
    );
  }
}
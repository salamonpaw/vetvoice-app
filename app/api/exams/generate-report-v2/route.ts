// app/api/exams/generate-report-v2/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION = "analysis-template-v2-p06-reason+patientname-headers";
const DATE_LOCALE = "pl-PL";

/* ================= Firebase ================= */

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_PATH");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

/* ================= Helpers ================= */

function formatDatePL(d = new Date()) {
  return new Intl.DateTimeFormat(DATE_LOCALE, {
    day: "2-digit",
    month: "2-digit",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(d);
}

function cleanLine(s: string) {
  return String(s ?? "").replace(/\s+/g, " ").trim();
}

function uniqueLines(lines: string[]) {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const l of lines) {
    const key = l.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(l);
  }
  return out;
}

/* ================= POWÓD BADANIA ================= */

function resolveExamReason({
  facts,
  analysis,
}: {
  facts?: any;
  analysis?: any;
}): string {
  const candidates = [
    facts?.exam?.reason,
    facts?.reason,
    analysis?.sections?.reason,
  ];

  for (const c of candidates) {
    if (typeof c === "string") {
      const s = c.trim();
      if (s && s.toLowerCase() !== "nie podano") return s;
    }
  }

  return "Nie podano w transkrypcji.";
}

/* ================= Render helpers ================= */

function renderListSection(title: string, items: string[]) {
  const out: string[] = [];
  out.push(`${title}:`);
  if (!items.length) {
    out.push("—");
    out.push("");
    return out;
  }
  for (const i of items) out.push(`- ${cleanLine(i)}`);
  out.push("");
  return out;
}

/* ================= Endpoint ================= */

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId, sanitize, useLLM } =
      (await req.json()) as {
        patientId?: string;
        examId?: string;
        sanitize?: boolean;
        useLLM?: boolean;
      };

    if (!patientId || !examId) {
      return NextResponse.json(
        { error: "Missing patientId or examId" },
        { status: 400 }
      );
    }

    const adminDb = await getAdminDb();
    const ref = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await ref.get();

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;

    const facts = exam?.facts || {};
    const analysis = exam?.analysis || {};
    const impression = exam?.impression || {};

    const lines: string[] = [];

    /* ================= Header ================= */

    lines.push(`RAPORT BADANIA: USG jamy brzusznej`);
    lines.push(`Data wygenerowania: ${formatDatePL(new Date())}`);

    const patientName = cleanLine(facts?.exam?.patientName || "");
    if (patientName) {
      lines.push(`Pacjent: ${patientName}`);
    }
    lines.push("");

    /* ================= POWÓD BADANIA ================= */

    const examReason = resolveExamReason({ facts, analysis });
    lines.push("POWÓD BADANIA:");
    lines.push(`- ${examReason}`);
    lines.push("");

    /* ================= WARUNKI BADANIA ================= */

    const conditions: string[] = Array.isArray(facts?.conditions)
      ? facts.conditions
      : [];

    lines.push(...renderListSection("WARUNKI BADANIA", conditions));

    /* ================= OPIS BADANIA ================= */

    const findings: string[] = Array.isArray(facts?.findings)
      ? uniqueLines(facts.findings)
      : [];

    lines.push(...renderListSection("OPIS BADANIA", findings));

    /* ================= POMIARY ================= */

    const measurements: any[] = Array.isArray(facts?.measurements)
      ? facts.measurements
      : [];

    const measurementLines: string[] = [];

    for (const m of measurements) {
      if (!m || !Array.isArray(m.value) || !m.value.length) continue;
      if (!m.unit) continue;

      const range =
        m.value.length === 1
          ? `${m.value[0]}`
          : `${m.value[0]}–${m.value[m.value.length - 1]}`;

      const labelParts = [m.structure, m.location].filter(Boolean);
      const label = labelParts.join(" – ");

      measurementLines.push(`${label}: ${range} ${m.unit}`);
    }

    // P0.6: bez dopisku w nawiasie
    lines.push(...renderListSection("POMIARY", measurementLines));

    /* ================= WNIOSKI ================= */

    const conclusions: string[] = Array.isArray(impression?.doctorKeyConcerns)
      ? impression.doctorKeyConcerns
      : [];

    // P0.6: sama nazwa "WNIOSKI"
    lines.push(...renderListSection("WNIOSKI", conclusions));

    /* ================= ZALECENIA ================= */

    const recommendations: string[] = Array.isArray(impression?.doctorPlan)
      ? impression.doctorPlan
      : [];

    lines.push(...renderListSection("ZALECENIA", recommendations));

    /* ================= OBJAWY ALARMOWE ================= */

    const redFlags: string[] = Array.isArray(impression?.doctorRedFlags)
      ? impression.doctorRedFlags
      : [];

    lines.push(...renderListSection("OBJAWY ALARMOWE", redFlags));

    /* ================= Footer ================= */

    lines.push(
      "Uwaga: Dokument został automatycznie wygenerowany na podstawie transkrypcji i analizy AI."
    );
    lines.push("Wymagana jest weryfikacja i zatwierdzenie przez lekarza.");

    const reportText = lines.join("\n");

    /* ================= Save ================= */

    await ref.update({
      report: reportText,
      reportMeta: {
        version: REPORT_VERSION,
        generatedAt: new Date(),
        sanitize: Boolean(sanitize),
        useLLM: Boolean(useLLM),
      },
    });

    return NextResponse.json({
      ok: true,
      reportPreview: reportText,
      docPath: ref.path,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

// app/api/exams/generate-report-v2/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION =
  "analysis-template-v2-p09-aggregate-findings-by-organ+anti-loop+wnioski-fallback+no-transcript";
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

function normKey(s: string) {
  return cleanLine(s)
    .toLowerCase()
    .replace(/[.。]\s*$/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Anti-loop na poziomie raportu:
 * - jeśli linia powtarza się > maxRepeats, zostawia keep (domyślnie 1)
 * - dodatkowo robi finalne uniq (case-insensitive)
 */
function limitRepeatedLines(lines: string[], opts?: { maxRepeats?: number; keep?: number }) {
  const maxRepeats = opts?.maxRepeats ?? 2;
  const keep = opts?.keep ?? 1;

  const counts = new Map<string, number>();
  const kept = new Map<string, number>();
  const out: string[] = [];

  for (const raw of lines) {
    const line = cleanLine(raw);
    if (!line) continue;

    const key = normKey(line);
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);

    if (c > maxRepeats) {
      const k = kept.get(key) ?? 0;
      if (k < keep) {
        out.push(line);
        kept.set(key, k + 1);
      }
      continue;
    }

    out.push(line);
  }

  const seen = new Set<string>();
  const uniq: string[] = [];
  for (const l of out) {
    const k = normKey(l);
    if (seen.has(k)) continue;
    seen.add(k);
    uniq.push(l);
  }
  return uniq;
}

function isNoiseFinding(line: string) {
  const s = cleanLine(line);
  if (!s) return true;

  // same nagłówki typu "Śledziona." / "Jelito." / "Nerki."
  if (/^[A-ZĄĆĘŁŃÓŚŻŹ][a-ząćęłńóśżź]+[.!?]?$/.test(s)) return true;

  // zbyt krótkie, bez treści
  const wc = s.split(" ").filter(Boolean).length;
  if (wc <= 2) return true;

  // ogólniaki
  const low = s.toLowerCase();
  if (low.includes("wydaje się, że nie ma żadnego problemu")) return true;

  return false;
}

/**
 * Agreguje OPIS BADANIA po narządzie:
 * - wejście: ["Wątroba: ...", "Wątroba: ...", "Śledziona: ..."]
 * - wyjście: ["Wątroba: ...; ...; ...", "Śledziona: ..."]
 *
 * Zachowuje kolejność narządów wg pierwszego wystąpienia.
 */
function aggregateFindingsByOrgan(findings: string[]) {
  const groups = new Map<string, string[]>();
  const passthrough: string[] = [];

  for (const raw of findings) {
    const line = cleanLine(raw);
    if (!line) continue;
    if (isNoiseFinding(line)) continue;

    const idx = line.indexOf(":");
    if (idx === -1) {
      passthrough.push(line);
      continue;
    }

    const organ = cleanLine(line.slice(0, idx));
    const desc = cleanLine(line.slice(idx + 1));
    if (!organ || !desc) continue;

    const arr = groups.get(organ) ?? [];
    arr.push(desc);
    groups.set(organ, arr);
  }

  const order: string[] = [];
  for (const raw of findings) {
    const idx = String(raw).indexOf(":");
    if (idx === -1) continue;
    const organ = cleanLine(String(raw).slice(0, idx));
    if (!organ) continue;
    if (!order.includes(organ)) order.push(organ);
  }

  const out: string[] = [];
  for (const organ of order) {
    const descs = groups.get(organ) ?? [];
    if (!descs.length) continue;

    const merged = limitRepeatedLines(descs, { maxRepeats: 1, keep: 1 }).join("; ");
    out.push(`${organ}: ${merged}`);
  }

  const tail = limitRepeatedLines(passthrough, { maxRepeats: 1, keep: 1 });
  for (const t of tail) out.push(t);

  return out;
}

/* ================= POWÓD BADANIA ================= */

function resolveExamReason({ facts, analysis }: { facts?: any; analysis?: any }): string {
  const candidates = [facts?.exam?.reason, facts?.reason, analysis?.sections?.reason];

  for (const c of candidates) {
    if (typeof c === "string") {
      const s = c.trim();
      if (s && s.toLowerCase() !== "nie podano") return s;
    }
  }

  return "Nie podano w transkrypcji.";
}

/* ================= WNIOSKI fallback ================= */

function resolveConclusions({ facts, impression }: { facts?: any; impression?: any }) {
  const fromImpression: string[] = Array.isArray(impression?.doctorKeyConcerns)
    ? impression.doctorKeyConcerns
    : [];

  if (fromImpression.length) return fromImpression;

  const findings: string[] = Array.isArray(facts?.findings) ? facts.findings : [];

  const candidates = findings.filter((l) => {
    const k = l.toLowerCase();
    return (
      k.startsWith("podsumowanie") ||
      k.includes("podsumowanie badania") ||
      k.includes("obraz usg wskazuje") ||
      k.includes("przemawia za") ||
      k.includes("sugeruje") ||
      k.includes("najpewniej") ||
      k.includes("cechy przewlekłego") ||
      k.includes("krążenia wrotno") ||
      k.includes("nadciśnienia wrotnego") ||
      k.includes("przekrwieniem biernym")
    );
  });

  return limitRepeatedLines(candidates, { maxRepeats: 1, keep: 1 });
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
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();
    const ref = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await ref.get();

    if (!snap.exists) return NextResponse.json({ error: "Exam not found" }, { status: 404 });

    const exam = snap.data() as any;

    const facts = exam?.facts || {};
    const analysis = exam?.analysis || {};
    const impression = exam?.impression || {};

    const lines: string[] = [];

    /* ================= Header ================= */

    lines.push(`RAPORT BADANIA: USG jamy brzusznej`);
    lines.push(`Data wygenerowania: ${formatDatePL(new Date())}`);

    const patientName = cleanLine(facts?.exam?.patientName || "");
    if (patientName) lines.push(`Pacjent: ${patientName}`);
    lines.push("");

    /* ================= POWÓD BADANIA ================= */

    const examReason = resolveExamReason({ facts, analysis });
    lines.push("POWÓD BADANIA:");
    lines.push(`- ${examReason}`);
    lines.push("");

    /* ================= WARUNKI BADANIA ================= */

    const conditionsRaw: string[] = Array.isArray(facts?.conditions) ? facts.conditions : [];
    const conditions = limitRepeatedLines(conditionsRaw, { maxRepeats: 2, keep: 1 });
    lines.push(...renderListSection("WARUNKI BADANIA", conditions));

    /* ================= OPIS BADANIA ================= */

    const findingsRaw: string[] = Array.isArray(facts?.findings) ? facts.findings : [];
    const findingsAgg = aggregateFindingsByOrgan(findingsRaw);
    const findings = limitRepeatedLines(findingsAgg, { maxRepeats: 2, keep: 1 });
    lines.push(...renderListSection("OPIS BADANIA", findings));

    /* ================= POMIARY ================= */

    const measurements: any[] = Array.isArray(facts?.measurements) ? facts.measurements : [];
    const measurementLines: string[] = [];

    for (const m of measurements) {
      if (!m || !Array.isArray(m.value) || !m.value.length) continue;
      if (!m.unit) continue;

      const range =
        m.value.length === 1 ? `${m.value[0]}` : `${m.value[0]}–${m.value[m.value.length - 1]}`;

      const labelParts = [m.structure, m.location].filter(Boolean);
      const label = labelParts.join(" – ");

      measurementLines.push(`${label}: ${range} ${m.unit}`);
    }

    lines.push(
      ...renderListSection(
        "POMIARY",
        limitRepeatedLines(measurementLines, { maxRepeats: 2, keep: 1 })
      )
    );

    /* ================= WNIOSKI ================= */

    const conclusions = resolveConclusions({ facts, impression });
    lines.push(
      ...renderListSection("WNIOSKI", limitRepeatedLines(conclusions, { maxRepeats: 2, keep: 1 }))
    );

    /* ================= ZALECENIA ================= */

    const recommendationsRaw: string[] = Array.isArray(impression?.doctorPlan)
      ? impression.doctorPlan
      : [];
    const recommendations = limitRepeatedLines(recommendationsRaw, { maxRepeats: 2, keep: 1 });
    lines.push(...renderListSection("ZALECENIA", recommendations));

    /* ================= OBJAWY ALARMOWE ================= */

    const redFlagsRaw: string[] = Array.isArray(impression?.doctorRedFlags)
      ? impression.doctorRedFlags
      : [];
    const redFlags = limitRepeatedLines(redFlagsRaw, { maxRepeats: 2, keep: 1 });
    lines.push(...renderListSection("OBJAWY ALARMOWE", redFlags));

    /* ================= Footer ================= */

    lines.push("Uwaga: Dokument został automatycznie wygenerowany na podstawie transkrypcji i analizy AI.");
    lines.push("Wymagana jest weryfikacja i zatwierdzenie przez lekarza.");

    // Celowo: brak transkrypcji w raporcie — żadnego doklejania transcriptRaw.
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
      docPath: ref.path,
      reportPreview: reportText,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}

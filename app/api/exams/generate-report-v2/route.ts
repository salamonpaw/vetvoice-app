// app/api/exams/generate-report-v2/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const REPORT_VERSION =
  "analysis-template-v2-p13-hard-post-normalize+conditions-guard+optional-polish";

/* =========================
   Firebase (NO dynamic require)
========================= */
async function getAdminDb() {
  if (!getApps().length) {
    const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH");

    const absPath = path.resolve(process.cwd(), relPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const serviceAccount = JSON.parse(raw);

    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* =========================
   HARD FILTERS / NORMALIZATION
========================= */

// TYLKO techniczne warunki badania (bez wniosków typu "śledziona reaktywna")
const ALLOWED_CONDITIONS = [
  "bez sedacji",
  "z sedacją",
  "pozycja",
  "position",
  "na plecach",
  "na boku",
  "na boczku",
  "pozycja grzbietowa",
  "pozycja boczna",
  "pacjent niespokojny",
  "niespokojny",
  "utrudnione badanie",
  "utrudniony",
  "ograniczona widoczność",
  "słaba widoczność",
  "duży pacjent",
  "pacjent duży",
  "trudne badanie",
  "bez narkozy",
  "znieczulenie",
];

function filterExamConditions(lines: string[] = []) {
  return lines
    .map((l) => (typeof l === "string" ? l.trim() : ""))
    .filter(Boolean)
    .filter((l) => ALLOWED_CONDITIONS.some((k) => l.toLowerCase().includes(k)));
}

// Ostatnia linia obrony – korekta STT i stylu (bez interpretacji klinicznej)
function finalMedicalNormalize(s: string) {
  return s
    // literówki / STT
    .replace(/\behebryczność\b/gi, "echogeniczność")
    .replace(/\bechogoniczność\b/gi, "echogeniczność")
    .replace(/\bechogenicznoś[ćc]\b/gi, "echogeniczność")
    .replace(/\bjedniczka\b/gi, "miedniczka")
    .replace(/\bamy brzusznej\b/gi, "jamy brzusznej")
    .replace(/\bdo plerem\b/gi, "dopplerem")
    .replace(/\bWęzy\b/gi, "Węzły")
    .replace(/\bkrężkowe\b/gi, "krezkowe")

    // lekkie ujednolicenie stylu (bez dodawania faktów)
    .replace(/\bZalecam obserwacje\b/gi, "Zaleca się obserwację")
    .replace(/\bzalecam obserwacje\b/gi, "zaleca się obserwację")
    .replace(/\bpodobnie\b/gi, "o podobnym obrazie")
    .replace(/\bnie widzę osadu ani kamieni\b/gi, "bez osadu ani kamieni");
}

function normalizeLines(lines: string[] = []) {
  return lines
    .map((l) => (typeof l === "string" ? finalMedicalNormalize(l.trim()) : ""))
    .filter(Boolean);
}

function unique(arr: string[]) {
  return Array.from(new Set(arr));
}

function safeString(x: unknown) {
  return typeof x === "string" ? x.trim() : "";
}

/* =========================
   OPTIONAL: LLM "POLISH" on final report
   - only fixes typos/terminology/style
   - must keep the structure & not add new facts
========================= */
async function polishReportWithLLM(input: string) {
  if (process.env.REPORT_POLISH_WITH_LLM !== "1") return input;

  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
  const model =
    process.env.LMSTUDIO_MODEL_ALT ||
    process.env.LMSTUDIO_MODEL ||
    "qwen2.5-14b-instruct-1m";

  const maxTokens = Number(process.env.REPORT_POLISH_MAX_TOKENS || 350);
  const timeoutMs = Number(process.env.REPORT_POLISH_TIMEOUT_MS || 25000);

  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0.1,
        max_tokens: maxTokens,
        messages: [
          {
            role: "system",
            content:
              "Jesteś korektorem raportów weterynaryjnych PL. " +
              "Popraw WYŁĄCZNIE: literówki, przekręcone słowa, interpunkcję, odmianę, terminologię (np. ehebryczność/echogoniczność -> echogeniczność; jedniczka -> miedniczka). " +
              "Możesz lekko ujednolicić styl bez zmiany sensu (np. 'zalecam' -> 'zaleca się', 'podobnie' -> 'o podobnym obrazie'). " +
              "NIE dodawaj żadnych nowych informacji medycznych. NIE dopisuj narządów, pomiarów, rozpoznań, zaleceń. NIE usuwaj faktów. " +
              "Zachowaj układ sekcji i listy. " +
              "Zwróć TYLKO gotowy tekst raportu (plain text), bez komentarzy, bez JSON."
          },
          { role: "user", content: input }
        ]
      })
    });

    if (!res.ok) return input;

    const json = await res.json();
    const out = json?.choices?.[0]?.message?.content;

    if (typeof out !== "string") return input;
    const trimmed = out.trim();
    if (trimmed.length < 50) return input;

    // Bezpiecznik: zachowaj wymagane nagłówki
    const mustHave = [
      "POWÓD BADANIA:",
      "WARUNKI BADANIA:",
      "OPIS BADANIA:",
      "POMIARY:",
      "WNIOSKI:",
      "ZALECENIA:",
      "OBJAWY ALARMOWE:",
      "Uwaga: Dokument został automatycznie wygenerowany"
    ];
    for (const h of mustHave) if (!trimmed.includes(h)) return input;

    return trimmed;
  } catch {
    return input;
  } finally {
    clearTimeout(t);
  }
}

/* =========================
   API
========================= */
export async function POST(req: NextRequest) {
  const t0 = Date.now();

  try {
    const body = await req.json();
    const patientId = body?.patientId;
    const examId = body?.examId;
    const sanitize = body?.sanitize ?? true;

    if (!patientId || !examId) {
      return NextResponse.json({ ok: false, error: "Missing patientId/examId" }, { status: 400 });
    }

    const db = await getAdminDb();
    const ref = db.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await ref.get();

    if (!snap.exists) {
      return NextResponse.json({ ok: false, error: "Exam not found" }, { status: 404 });
    }

    const data = snap.data() || {};
    const facts = data.facts || {};
    const exam = facts.exam || {};
    const impression = data.impression || {};
    const analysis = data.analysis || {};

    // ===== POWÓD / PACJENT =====
    const patientName = safeString(exam.patientName) || null;
    const reason = safeString(exam.reason) || null;

    // ===== WARUNKI BADANIA (TYLKO TECHNICZNE) =====
    const rawConditions: string[] = Array.isArray(facts.conditionsLines)
      ? facts.conditionsLines
      : Array.isArray(facts.conditions)
        ? facts.conditions
        : [];

    const conditions = normalizeLines(filterExamConditions(rawConditions));

    // ===== OPIS BADANIA =====
    const rawFindings: string[] = Array.isArray(facts.findingsLines)
      ? facts.findingsLines
      : Array.isArray(facts.findings)
        ? facts.findings
        : [];

    const findings = normalizeLines(rawFindings);

    // ===== POMIARY =====
    const measFromFacts = Array.isArray(facts.measurements) ? facts.measurements : [];
    const measurementsLines: string[] = [];

    for (const m of measFromFacts as any[]) {
      const structure = safeString(m?.structure);
      const unit = safeString(m?.unit);
      const value = Array.isArray(m?.value) ? m.value : [];
      const nums = value.filter((x: any) => typeof x === "number" && Number.isFinite(x));
      if (!structure || nums.length === 0) continue;

      const valStr = nums.length === 2 ? `${nums[0]}–${nums[1]}` : `${nums[0]}`;
      measurementsLines.push(`${structure}: ${valStr}${unit ? " " + unit : ""}`);
    }

    const measurementsSummary: string[] = measurementsLines.length
      ? measurementsLines
      : Array.isArray(analysis.measurementsSummary)
        ? analysis.measurementsSummary
        : [];

    const finalMeasurements = unique(
      measurementsSummary
        .map((m: any) => (typeof m === "string" ? finalMedicalNormalize(m.trim()) : ""))
        .filter(Boolean)
    );

    // ===== WNIOSKI =====
    const wnioskiFromImpression: string[] = Array.isArray(impression.doctorKeyConcerns)
      ? impression.doctorKeyConcerns
          .filter((x: any) => typeof x === "string")
          .map((s: string) => finalMedicalNormalize(s.trim()))
          .filter(Boolean)
      : [];

    const fallbackSummary =
      typeof analysis.summary === "string" && analysis.summary.trim().length
        ? [finalMedicalNormalize(analysis.summary.trim())]
        : [];

    const finalWnioski = unique(wnioskiFromImpression.length ? wnioskiFromImpression : fallbackSummary);

    // ===== ZALECENIA / RED FLAGS =====
    const zalecenia: string[] = Array.isArray(impression.doctorPlan)
      ? impression.doctorPlan
          .filter((x: any) => typeof x === "string")
          .map((s: string) => finalMedicalNormalize(s.trim()))
          .filter(Boolean)
      : [];

    const redFlags: string[] = Array.isArray(impression.doctorRedFlags)
      ? impression.doctorRedFlags
          .filter((x: any) => typeof x === "string")
          .map((s: string) => finalMedicalNormalize(s.trim()))
          .filter(Boolean)
      : [];

    // ===== Raport (plain text) =====
    const nowPL = new Date().toLocaleString("pl-PL");

    const out: string[] = [];
    out.push("RAPORT BADANIA: USG jamy brzusznej");
    out.push(`Data wygenerowania: ${nowPL}`);
    if (patientName) out.push(`Pacjent: ${patientName}`);

    out.push("");
    out.push("POWÓD BADANIA:");
    out.push(reason ? `- ${finalMedicalNormalize(reason)}` : "- Nie podano w transkrypcji.");

    out.push("");
    out.push("WARUNKI BADANIA:");
    if (conditions.length) conditions.forEach((c) => out.push(`- ${c}`));
    else out.push("—");

    out.push("");
    out.push("OPIS BADANIA:");
    if (findings.length) findings.forEach((f) => out.push(`- ${f}`));
    else out.push("—");

    out.push("");
    out.push("POMIARY:");
    if (finalMeasurements.length) finalMeasurements.forEach((m) => out.push(`- ${m}`));
    else out.push("—");

    out.push("");
    out.push("WNIOSKI:");
    if (finalWnioski.length) finalWnioski.forEach((w) => out.push(`- ${w}`));
    else out.push("—");

    out.push("");
    out.push("ZALECENIA:");
    if (zalecenia.length) zalecenia.forEach((z) => out.push(`- ${z}`));
    else out.push("—");

    out.push("");
    out.push("OBJAWY ALARMOWE:");
    if (redFlags.length) redFlags.forEach((r) => out.push(`- ${r}`));
    else out.push("—");

    out.push("");
    out.push("Uwaga: Dokument został automatycznie wygenerowany na podstawie transkrypcji i analizy AI.");
    out.push("Wymagana jest weryfikacja i zatwierdzenie przez lekarza.");

    let report = out.join("\n");

    // HARD post-normalize (gwarantuje poprawę nawet jeśli coś ominęło normalizację linii)
    report = finalMedicalNormalize(report);

    // Optional final LLM polish (only typos/terminology/style; must keep structure)
    report = await polishReportWithLLM(report);

    await ref.update({
      report,
      reportMeta: {
        generatedAt: FieldValue.serverTimestamp(),
        sanitize: Boolean(sanitize),
        useLLM: false,
        version: REPORT_VERSION,
        tookMs: Date.now() - t0,
        status: "in_progress"
      }
    });

    return NextResponse.json({ ok: true, reportPreview: report, docPath: ref.path });
  } catch (e: any) {
    return NextResponse.json({ ok: false, error: e?.message || "Unknown error" }, { status: 500 });
  }
}

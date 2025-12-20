// app/api/exams/generate-report/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION = "analysis-template-v3-b1";

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

function normalizeSections(input: any) {
  const src = input ?? {};
  const norm = (v: any) => (typeof v === "string" ? v.trim() : null);

  return {
    reason: norm(src.reason),
    findings: norm(src.findings),
    conclusions: norm(src.conclusions),
    recommendations: norm(src.recommendations),
  };
}

function isEmptyText(v?: string | null) {
  if (!v) return true;
  const t = v.trim();
  return !t || t === "—" || t.toLowerCase() === "brak" || t.toLowerCase() === "nie dotyczy";
}

/**
 * B1: deterministyczne zalecenia (bez AI).
 * Zasady:
 * - Jeśli recommendations istnieje -> używamy go.
 * - Jeśli brak -> generujemy "bezpieczne" zalecenia zależnie od findings/conclusions.
 * - Nigdy nie wymyślamy diagnozy; zalecenia to "rozważyć / zaleca się / wskazana kontrola".
 */
function inferRecommendations(params: { findings?: string | null; conclusions?: string | null }): { text: string | null; rulesHit: string[] } {
  const findings = (params.findings || "").toLowerCase();
  const conclusions = (params.conclusions || "").toLowerCase();
  const textAll = `${findings}\n${conclusions}`;

  const rulesHit: string[] = [];
  const recs: string[] = [];

  const hasAnyMedicalSignal = (patterns: RegExp[]) => patterns.some((p) => p.test(textAll));

  // --- Reguły "twarde" (typowe i bezpieczne) ---
  // Nerki / układ moczowy
  if (hasAnyMedicalSignal([/nerk/, /mocz/, /pęcherz/, /pęcherz/])) {
    if (/(powiększon|poszerzon|zastój|wodonercz|kamień|złog)/.test(textAll)) {
      rulesHit.push("renal_abnormal");
      recs.push("Zaleca się ocenę funkcji nerek (badanie krwi: mocznik, kreatynina) oraz badanie ogólne moczu.");
      recs.push("Wskazana kontrola USG oraz dalsza diagnostyka w zależności od objawów klinicznych.");
    } else {
      rulesHit.push("renal_mention");
      recs.push("W razie utrzymywania się objawów klinicznych rozważyć badanie ogólne moczu oraz kontrolę USG.");
    }
  }

  // Wątroba / drogi żółciowe
  if (hasAnyMedicalSignal([/wątro/, /żółci/, /pęcherzyk żółciowy/, /cholestaz/, /drogi żółci/])) {
    if (/(powiększon|zmian|niejednorodn|stłuszcz|zastój|poszerzon)/.test(textAll)) {
      rulesHit.push("liver_abnormal");
      recs.push("Zaleca się badania laboratoryjne (profil wątrobowy) oraz kontrolę w zależności od obrazu klinicznego.");
    } else {
      rulesHit.push("liver_mention");
      recs.push("Kontrola w zależności od objawów klinicznych; rozważyć badania krwi przy podejrzeniu choroby wątroby.");
    }
  }

  // Trzustka
  if (hasAnyMedicalSignal([/trzustk/])) {
    if (/(zapalen|zmian|obrzęk|niejednorodn)/.test(textAll)) {
      rulesHit.push("pancreas_abnormal");
      recs.push("Wskazana korelacja z objawami oraz rozważenie badań dodatkowych zgodnie z decyzją lekarza prowadzącego.");
    } else {
      rulesHit.push("pancreas_mention");
      // nie dokładamy na siłę, bo sama wzmianka "trzustka ok" nie wymaga zaleceń
    }
  }

  // Śledziona
  if (hasAnyMedicalSignal([/śledzion/])) {
    if (/(powiększon|zmian|guz|ognisk)/.test(textAll)) {
      rulesHit.push("spleen_abnormal");
      recs.push("Zaleca się dalszą diagnostykę w zależności od obrazu klinicznego oraz rozważenie kontroli obrazowej.");
    } else {
      rulesHit.push("spleen_mention");
    }
  }

  // Nowotworowe / guzy / podejrzenia
  if (hasAnyMedicalSignal([/nowotwor/, /guz/, /masa/, /zmiana ogniskowa/, /przerzut/])) {
    // nawet jeśli "brak objawów nowotworowych", nadal można dać bezpieczną kontrolę zależnie od objawów
    rulesHit.push("oncology_context");
    recs.push("W przypadku niepokojących objawów klinicznych zaleca się kontrolę oraz diagnostykę zgodnie z decyzją lekarza.");
  }

  // Jeśli w opisie wszystko "bez odchyleń", nie dodajemy zaleceń.
  const looksNormal = /(bez odchyleń|bez istotnych odchyleń|w normie|bez zmian)/.test(textAll);
  const looksAbnormal = /(powiększon|poszerzon|zastój|kamień|złog|zmian|guz|masa|niejednorodn|obrzęk|zapalen|pogrub)/.test(textAll);

  // Fallback: jeśli były jakiekolwiek nieprawidłowości, a reguły nic nie złapały, dodaj ogólne, bezpieczne.
  if (!looksNormal && looksAbnormal && recs.length === 0) {
    rulesHit.push("generic_abnormal_fallback");
    recs.push("Zaleca się korelację z objawami klinicznymi oraz rozważenie badań dodatkowych według decyzji lekarza.");
    recs.push("Wskazana kontrola w przypadku utrzymywania się lub nasilenia objawów.");
  }

  // Jeśli wszystko wygląda normalnie i nie było reguł "abnormal", zwróć null (czyli w raporcie będzie "—").
  if (recs.length === 0) {
    // nawet jeśli były wzmianki typu "trzustka ok", nie ma sensu generować zaleceń
    return { text: null, rulesHit };
  }

  // Dedup + łączenie
  const uniq = Array.from(new Set(recs.map((x) => x.trim()).filter(Boolean)));
  return { text: uniq.join(" "), rulesHit };
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

    // clinicId opcjonalne (dual-path)
    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();

    // Dual-path lookup
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
          tried: { pathA: refA.path, pathB: refB?.path ?? null },
        },
        { status: 404 }
      );
    }

    const exam = snap.data() as any;

    const rawSections = exam?.analysis?.sections;
    if (!rawSections) {
      return NextResponse.json(
        { error: "Missing analysis.sections — run /api/exams/analyze first" },
        { status: 400 }
      );
    }

    const sections = normalizeSections(rawSections);

    // Jeśli recommendations puste -> B1: spróbuj wywnioskować deterministycznie
    let inferredRules: string[] = [];
    if (isEmptyText(sections.recommendations)) {
      const inferred = inferRecommendations({
        findings: sections.findings,
        conclusions: sections.conclusions,
      });
      inferredRules = inferred.rulesHit;
      if (inferred.text) {
        sections.recommendations = inferred.text;
      } else {
        sections.recommendations = null; // w raporcie pokaże "—"
      }
    }

    // (opcjonalnie) walidacja: jeśli WSZYSTKO null -> raczej analiza była pusta
    const allEmpty = !sections.reason && !sections.findings && !sections.conclusions && !sections.recommendations;
    if (allEmpty) {
      return NextResponse.json(
        {
          error: "analysis.sections present but empty",
          hint: "Analiza nie wyciągnęła żadnych sekcji. Sprawdź /api/exams/analyze (prompt / JSON).",
        },
        { status: 400 }
      );
    }

    const report = buildReportFromAnalysis({
      examType: exam?.type,
      sections,
    });

    const quality = {
      hasReason: !!sections.reason,
      hasFindings: !!sections.findings,
      hasConclusions: !!sections.conclusions,
      hasRecommendations: !!sections.recommendations,
    };

    await examRef.update({
      report,
      reportedAt: new Date(),
      reportMeta: {
        version: REPORT_VERSION,
        engine: "template-from-analysis",
        basedOn: "analysis.sections",
        b1: {
          inferredRecommendations: isEmptyText(rawSections?.recommendations),
          inferredRules,
        },
      },
      reportQuality: quality,
    });

    // UWAGA: UI czasem chciało report "od razu". Możesz też zwracać report w response:
    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      report, // <- dodane celowo, żeby UI mogło ustawić draft natychmiast po 1 kliknięciu
      reportPreview: report.slice(0, 500),
      reportQuality: quality,
      inferredRules,
    });
  } catch (err: any) {
    console.error("GENERATE REPORT ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

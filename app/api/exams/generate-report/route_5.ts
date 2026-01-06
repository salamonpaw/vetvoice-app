// app/api/exams/generate-report/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION = "analysis-template-v9-vet-golden-v1-compliance";

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app =
    getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

function cleanMedicalPolish(input: string) {
  let s = input || "";

  s = s.replace(/\bnetki\b/gi, "nerki");
  s = s.replace(/\bbrusznej\b/gi, "brzusznej");
  s = s.replace(/\bbruszna\b/gi, "brzuszna");
  s = s.replace(/\bbruszny\b/gi, "brzuszny");
  s = s.replace(/\bbrusznego\b/gi, "brzusznego");

  s = s.replace(/\bprzeroźnion([aąeęyio])\b/gi, "przerośnięt$1");
  s = s.replace(/\bprzeroźnięt([aąeęyio])\b/gi, "przerośnięt$1");
  s = s.replace(/\bprzeroźnięta\b/gi, "przerośnięta");
  s = s.replace(/\bprzeroźnięty\b/gi, "przerośnięty");
  s = s.replace(/\bprzeroźnięte\b/gi, "przerośnięte");

  s = s.replace(/\bkęst([eyąa])\b/gi, "gęst$1");

  s = s.replace(/\bcystami\b/gi, "torbielami");
  s = s.replace(/\bcystach\b/gi, "torbielach");
  s = s.replace(/\bcysty\b/gi, "torbiele");
  s = s.replace(/\bcysta\b/gi, "torbiel");
  s = s.replace(/\bcyste\b/gi, "torbiele");

  // lekkie mini-cleanup
  s = s.replace(/\bzwiększoną naczynienie\b/gi, "zwiększone unaczynienie");
  s = s.replace(/\bniereguralny\b/gi, "nieregularny");
  s = s.replace(/\bpęcharz\b/gi, "pęcherz");
  s = s.replace(/\bjomy\b/gi, "jamy");
  s = s.replace(/\bwpłynu\b/gi, "płynu");

  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function safeOneLine(s: string) {
  return cleanMedicalPolish((s || "").replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim());
}

function isEmptyText(v?: string | null) {
  if (!v) return true;
  const t = v.trim();
  return !t || t === "—" || t.toLowerCase() === "brak" || t.toLowerCase() === "nie dotyczy";
}

function normalizeSections(input: any) {
  const src = input ?? {};
  const norm = (v: any) => (typeof v === "string" ? cleanMedicalPolish(v.trim()) : null);

  return {
    reason: norm(src.reason),
    findings: norm(src.findings),
    conclusions: norm(src.conclusions),
    recommendations: norm(src.recommendations),
  };
}

function normalizeKeyFindings(arr: any): string[] | null {
  if (!Array.isArray(arr)) return null;
  const cleaned = arr
    .filter((x) => typeof x === "string")
    .map((x) => cleanMedicalPolish(x.trim()))
    .filter(Boolean);

  const uniq = Array.from(new Set(cleaned));
  return uniq.length ? uniq : null;
}

function inferExamTypeFallback(examType?: string, findings?: string | null, conclusions?: string | null) {
  const t = (examType || "").toLowerCase();
  const text = `${findings || ""} ${conclusions || ""}`.toLowerCase();

  if (t.includes("usg")) return (examType || "USG").trim();
  if (/(wątro|śledzion|nerk|pęcherz|jelit|jama brzuszn)/.test(text)) return "USG jamy brzusznej";
  return (examType || "Badanie").trim();
}

function makeFallbackSections(score: number | null) {
  const concl =
    typeof score === "number" && score < 60
      ? "Materiał niewystarczający do jednoznacznej analizy (niska jakość transkrypcji) — proszę zweryfikować."
      : "Materiał niewystarczający do jednoznacznej analizy — proszę zweryfikować.";

  return {
    reason: "Nie podano w nagraniu (badanie diagnostyczne).",
    findings: "Brak jednoznacznego opisu narządów w transkrypcji.",
    conclusions: concl,
    recommendations: "W razie potrzeby powtórzyć nagranie lub uzupełnić opis badania w dokumentacji.",
  };
}

function extractPatientLabel(exam: any, transcript?: string | null) {
  const name = exam?.analysis?.entities?.patientName ? String(exam.analysis.entities.patientName) : null;
  if (name && name.trim()) return name.trim();

  const t = (transcript || "").toLowerCase();
  const m1 = t.match(/\bbadanie\s+([a-ząćęłńóśźż][a-ząćęłńóśźż-]{1,25})\b/i);
  if (m1?.[1]) return m1[1];

  const m2 = t.match(/\bimi[eę]\s+([a-ząćęłńóśźż][a-ząćęłńóśźż-]{1,25})\b/i);
  if (m2?.[1]) return m2[1];

  return null;
}

function extractConditions(transcript?: string | null) {
  const t = (transcript || "").toLowerCase();
  const parts: string[] = [];

  if (/\bbez sedacji\b/.test(t)) parts.push("bez sedacji");
  if (/\bsedacj[ai]\b/.test(t) && !/\bbez sedacji\b/.test(t)) parts.push("w sedacji");

  if (/\bpozycj[ai]\s+grzbietow/.test(t)) parts.push("pozycja grzbietowa");
  if (/\bpozycj[ai]\s+bocz/.test(t)) parts.push("pozycja boczna");

  if (/\bniespokojn/.test(t)) parts.push("pacjent okresowo niespokojny");

  return parts.length ? cleanMedicalPolish(parts.join(", ")) : null;
}

function smartReasonFallback(reason: string | null, examType: string) {
  if (isEmptyText(reason)) return "Nie podano w nagraniu (badanie diagnostyczne).";

  const r = (reason ?? "").toLowerCase();
  const et = (examType ?? "").toLowerCase();

  if (r.includes("badanie usg") || r === et || r.includes("usg jamy brzusznej")) {
    return "Nie podano w nagraniu (badanie diagnostyczne).";
  }

  return reason!;
}

function bulletizeFindings(text: string) {
  const cleaned = cleanMedicalPolish(text);
  const sentences = cleaned
    .split(/(?<=[.?!])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length >= 15);

  if (sentences.length <= 2) return cleaned;
  return sentences.map((s) => `- ${s.replace(/\.$/, "")}.`).join("\n");
}

function deriveVetConclusionsAndRecs(params: {
  findingsText: string;
  keyFindings: string[] | null;
  transcript?: string | null;
}) {
  const full = `${params.findingsText || ""} ${(params.transcript || "")}`.toLowerCase();
  const kf = (params.keyFindings || []).join(" ").toLowerCase();

  const hasForeignBody =
    /ciał[oa]\s+obc|obecno[śćsc]\s+c[ia]ł[oa]\s+obc|struktura.*cień akustyczny|cień akustyczny/.test(full);

  const hasPartialObstruction = /niedrożno[śćsc]|poszerzone światło|nagromadzenie płynnej treści/.test(full);

  const hasInflammation =
    /stan zapalny|zwiększone unaczynienie|pogrubienie ściany|zatarta warstwowość|osłabiona perystaltyka/.test(full);

  const hasFreeFluid = /woln(y|ego)\s+płyn|płynu wolnego|między pętlami/.test(full);

  const hasMesentericNodes = /węzł(y|ów)\s+chłonn(e|ych)\s+kręsk/.test(full);

  const conclusions: string[] = [];
  if (hasInflammation) conclusions.push("Obraz jelita cienkiego odpowiada zmianom zapalnym z towarzyszącą hipomotoryką.");
  if (hasForeignBody) conclusions.push("Zmiana w świetle jelita z cieniem akustycznym — wysokie podejrzenie ciała obcego.");
  if (hasPartialObstruction && hasForeignBody) conclusions.push("Obraz sugeruje częściową niedrożność w przebiegu podejrzenia ciała obcego.");
  if (hasMesentericNodes) conclusions.push("Wtórne zmiany odczynowe w węzłach chłonnych krezkowych.");
  if (hasFreeFluid) conclusions.push("Niewielka ilość wolnego płynu w jamie brzusznej (odczynowy/zapalny).");

  if (!conclusions.length && kf) {
    conclusions.push("W badaniu opisano istotne odchylenia — proszę zweryfikować opis oraz obraz kliniczny pacjenta.");
  }

  const recommendations: string[] = [];
  if (hasForeignBody || hasPartialObstruction) {
    recommendations.push("Pilna konsultacja chirurgiczna / postępowanie chirurgiczne zgodnie z obrazem klinicznym.");
    recommendations.push("Rozważyć RTG jamy brzusznej lub TK w celu potwierdzenia lokalizacji i planowania zabiegu.");
    recommendations.push("Monitorować stan ogólny pacjenta oraz parametry życiowe.");
  } else if (hasInflammation) {
    recommendations.push("Korelacja z objawami klinicznymi i badaniami laboratoryjnymi; rozważyć kontrolne USG.");
  } else {
    recommendations.push("W razie potrzeby uzupełnić opis badania w dokumentacji lub wykonać badanie kontrolne.");
  }

  return {
    conclusionsText: conclusions.length ? conclusions.map((x, i) => `${i + 1}. ${x}`).join("\n") : "—",
    recommendationsText: recommendations.length ? recommendations.map((x) => `- ${x}`).join("\n") : "—",
  };
}

function buildQualityNotice(qScore: number | null) {
  if (typeof qScore !== "number") {
    return "Uwaga: Brak danych o jakości transkrypcji — prosimy o weryfikację raportu.";
  }
  if (qScore >= 75) return null;
  if (qScore >= 60) {
    return "Uwaga: Średnia jakość nagrania/transkrypcji — prosimy o zweryfikowanie raportu przed zatwierdzeniem.";
  }
  return "Uwaga: Niska jakość nagrania/transkrypcji — raport może być niepełny lub zawierać błędy. Prosimy o zweryfikowanie raportu przed zatwierdzeniem.";
}

function buildReport(params: {
  examType?: string;
  patientLabel?: string | null;
  conditions?: string | null;
  sections: { reason?: string | null; findings?: string | null; conclusions?: string | null; recommendations?: string | null };
  keyFindings?: string[] | null;
  transcript?: string | null;
  transcriptQualityScore?: number | null;
  transcriptQualityFlags?: string[] | null;
  fallbackUsed: boolean;
}) {
  const s = params.sections;
  const examType = inferExamTypeFallback(params.examType, s.findings, s.conclusions);

  const title = params.patientLabel ? `${examType} – ${params.patientLabel}` : `${examType}`;

  const reason = smartReasonFallback(s.reason ?? null, examType);

  const findingsRaw = isEmptyText(s.findings)
    ? "Brak jednoznacznego opisu narządów w transkrypcji."
    : (s.findings || "").trim();

  const findings = bulletizeFindings(findingsRaw);

  let conclusions = isEmptyText(s.conclusions) ? null : (s.conclusions || "").trim();
  let recommendations = isEmptyText(s.recommendations) ? null : (s.recommendations || "").trim();

  if (!conclusions || !recommendations) {
    const derived = deriveVetConclusionsAndRecs({
      findingsText: findingsRaw,
      keyFindings: params.keyFindings || null,
      transcript: params.transcript || null,
    });
    if (!conclusions) conclusions = derived.conclusionsText;
    if (!recommendations) recommendations = derived.recommendationsText;
  }

  const kf = Array.isArray(params.keyFindings) ? params.keyFindings : null;
  const keyFindingsBlock =
    kf && kf.length
      ? [``, `Najważniejsze ustalenia:`, kf.slice(0, 8).map((x) => `- ${x}`).join("\n")].join("\n")
      : "";

  const qScore: number | null = typeof params.transcriptQualityScore === "number" ? params.transcriptQualityScore : null;
  const qFlags = params.transcriptQualityFlags?.length ? params.transcriptQualityFlags.join(", ") : null;

  const qualityLine =
    typeof qScore === "number"
      ? `Jakość transkrypcji: ${qScore}/100${qFlags ? ` (flags: ${qFlags})` : ""}`
      : "Jakość transkrypcji: brak danych";

  const banner = params.fallbackUsed
    ? "⚠ RAPORT TECHNICZNY (brak jednoznacznych danych klinicznych w analizie) — wymaga weryfikacji lekarza."
    : null;

  const source =
    params.transcript && params.transcript.trim()
      ? safeOneLine(params.transcript).slice(0, 900)
      : null;

  // === NEW: compliance footer ===
  const qualityNotice = buildQualityNotice(qScore);
  const aiFooter =
    "Raport wygenerowany automatycznie na podstawie transkrypcji AI (rozpoznawanie mowy) oraz analizy AI. Wymagana weryfikacja i zatwierdzenie przez lekarza weterynarii.";

  return [
    `RAPORT BADANIA: ${title}`,
    banner ? banner : null,
    ``,
    `Powód wizyty:`,
    reason,
    ``,
    params.conditions ? `Warunki badania:\n${params.conditions}\n` : null,
    `Opis badania:`,
    findings,
    keyFindingsBlock,
    ``,
    `Wnioski:`,
    conclusions || "—",
    ``,
    `Zalecenia:`,
    recommendations || "—",
    ``,
    `---`,
    qualityLine,
    qualityNotice ? qualityNotice : null,
    aiFooter,
    source ? [``, `---`, `Źródło (transkrypcja):`, source].join("\n") : null,
  ]
    .filter((x) => x != null)
    .join("\n");
}

export async function POST(req: NextRequest) {
  try {
    const { clinicId, patientId, examId } = (await req.json()) as {
      clinicId?: string;
      patientId?: string;
      examId?: string;
    };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();

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
        { error: "Exam not found", tried: { pathA: refA.path, pathB: refB?.path ?? null } },
        { status: 404 }
      );
    }

    const exam = snap.data() as any;

    // prefer normalized transcript if available
    const transcript: string | null = exam?.transcriptNormalized
      ? String(exam.transcriptNormalized)
      : exam?.transcript
      ? String(exam.transcript)
      : null;

    const tqScore: number | null = typeof exam?.transcriptQuality?.score === "number" ? exam.transcriptQuality.score : null;
    const tqFlags: string[] | null = Array.isArray(exam?.transcriptQuality?.flags) ? exam.transcriptQuality.flags : null;

    const rawSections = exam?.analysis?.sections || null;
    const keyFindings = normalizeKeyFindings(exam?.analysis?.keyFindings);

    let sections = normalizeSections(rawSections);

    const emptyAll =
      isEmptyText(sections.reason) &&
      isEmptyText(sections.findings) &&
      isEmptyText(sections.conclusions) &&
      isEmptyText(sections.recommendations);

    let fallbackUsed = false;
    if (emptyAll) {
      fallbackUsed = true;
      const fb = makeFallbackSections(tqScore);
      sections = { ...fb };
    }

    const patientLabel = extractPatientLabel(exam, transcript);
    const conditions = extractConditions(transcript);

    const report = buildReport({
      examType: exam?.type,
      patientLabel,
      conditions,
      sections,
      keyFindings,
      transcript,
      transcriptQualityScore: tqScore,
      transcriptQualityFlags: tqFlags,
      fallbackUsed,
    });

    const reportQuality = {
      hasReason: !isEmptyText(sections.reason),
      hasFindings: !isEmptyText(sections.findings),
      hasConclusions: !isEmptyText(sections.conclusions),
      hasRecommendations: !isEmptyText(sections.recommendations),
      hasKeyFindings: !!(keyFindings && keyFindings.length),
      fallbackUsed,
      transcriptQualityScore: tqScore,
      examTypeEffective: inferExamTypeFallback(exam?.type, sections.findings, sections.conclusions),
      patientLabel: patientLabel || null,
      conditions: conditions || null,
    };

    await examRef.update({
      report,
      reportedAt: new Date(),
      reportMeta: {
        version: REPORT_VERSION,
        engine: "template-from-analysis-vet",
        basedOn: "analysis.sections + transcript heuristics + deterministic fill + compliance footer",
        fallbackUsed,
      },
      reportQuality,
      updatedAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      reportPreview: report.slice(0, 1200),
      reportQuality,
      fallbackUsed,
    });
  } catch (err: any) {
    console.error("GENERATE REPORT ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

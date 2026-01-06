// app/api/exams/generate-report/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const REPORT_VERSION = "report-v13-sectioned-facts-first-3mm-leakfix-handling-filter";

// ================= Firebase Admin =================

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

// ================= Text helpers =================

function cleanMedicalPolish(input: string) {
  let s = input || "";

  // podstawowe literówki
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

  // mini-cleanup
  s = s.replace(/\bzwiększoną naczynienie\b/gi, "zwiększone unaczynienie");
  s = s.replace(/\bniereguralny\b/gi, "nieregularny");
  s = s.replace(/\bpęcharz\b/gi, "pęcherz");
  s = s.replace(/\bjomy\b/gi, "jamy");
  s = s.replace(/\bwpłynu\b/gi, "płynu");

  // ===== konserwatywne poprawki językowe =====
  s = s.replace(/\bdogrzgotow([a-ząćęłńóśźż]*)\b/gi, "dogrzbietow$1");
  s = s.replace(/\bczachami\b/gi, "cechami");
  s = s.replace(/\bhipertafogand[a-ząćęłńóśźż]*\b/gi, "hiperechogenna");
  s = s.replace(/\baksiserp[a-ząćęłńóśźż]*\b/gi, "akcji serca");
  s = s.replace(/\bpiometr\b/gi, "piometra");
  s = s.replace(/\bpiometru\b/gi, "piometry");

  // częste STT
  s = s.replace(/\bwiejniki\b/gi, "jajniki");
  s = s.replace(/\bwieżniki\b/gi, "jajniki");

  s = s.replace(/\s+/g, " ").trim();
  return s;
}

function safeOneLine(s: string) {
  return cleanMedicalPolish((s || "").replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim());
}

function isEmptyText(v?: string | null) {
  if (!v) return true;
  const t = String(v).trim();
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

function normalizeStringArray(arr: any): string[] | null {
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
  if (/(wątro|śledzion|nerk|pęcherz|jelit|jama brzuszn|macic|jajnik)/.test(text)) return "USG jamy brzusznej";
  return (examType || "Badanie").trim();
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

  // “duża” to warunek badania / handling, nie wynik obrazowania
  if (/\b(jest\s+)?duż[ay]\b/.test(t)) parts.push("pacjent duży (utrudnione badanie)");

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

function flagsToList(flags: any): string[] | null {
  if (!flags) return null;
  if (Array.isArray(flags)) return flags.filter((x) => typeof x === "string");
  if (typeof flags === "object") {
    return Object.entries(flags)
      .filter(([, v]) => Boolean(v))
      .map(([k]) => k);
  }
  return null;
}

// ================= Facts-first assembly =================

function uniqStrings(items: string[]) {
  return Array.from(
    new Set(items.map((x) => cleanMedicalPolish(String(x).trim())).filter((x) => typeof x === "string" && x.length > 0))
  );
}

function looksNonImagingSentence(s: string) {
  // rzeczy “kliniczne/ocenne” – wolimy w WNIOSKACH, a nie w USTALENIACH
  const t = s.toLowerCase();
  return /(zagrożen|stan bezpośredni|piln|natychmiast|operac|zabieg|seps|wstrząs|konsultac)/.test(t);
}

function looksHandlingSentence(s: string) {
  // handling / organizacja badania – nie opis narządów
  const t = s.toLowerCase();
  return /(jest\s+duż|duż[ay]\b|położyć|położ|na\s+boku|materac|proszę\s+trzymać|trzymać\s+głow|operował\s+głowic|punkt\s+odniesienia|zaczynam\s+od\s+pęcherza)/.test(
    t
  );
}

function extractUterusWallThicknessFact(transcript?: string | null): string | null {
  const tRaw = transcript || "";
  const t = safeOneLine(tRaw).toLowerCase();

  // 1) “Ściana tych struktur ... około 3 mm”
  // (w transkrypcji często pada najpierw “te struktury”, a dopiero potem “to jest macica”)
  const m1 = t.match(
    /(ścian[ay]\s+(tych\s+)?struktur[^.]{0,80}?(pogrubiał[a-ząćęłńóśźż]*|pogrubion[a-ząćęłńóśźż]*|pogrubiał[aeo]?)[^.]{0,80}?(około|ok\.)\s*3\s*mm)/
  );
  if (m1) return "Ściana (rogów) macicy pogrubiała, ok. 3 mm.";

  // 2) wariant: “grubość ... 3 mm” w kontekście macicy/rogów
  const m2 = t.match(
    /(grubo(?:ść|s[cś])\s+(ścian[ay]|ściany)[^.]{0,80}?(macic|rogów\s+macic)[^.]{0,80}?(około|ok\.)\s*3\s*mm)/
  );
  if (m2) return "Grubość ściany macicy ok. 3 mm.";

  // 3) wariant “trzy milimetry” (słownie) w pobliżu “ściana”
  const m3 = t.match(/(ścian[ay][^.]{0,80}?(około|ok\.)\s*trzy\s*milimetr[ayów]*)/);
  if (m3) return "Ściana (rogów) macicy pogrubiała, ok. 3 mm.";

  return null;
}

function buildKeyFindingsClean(
  keyFindings: string[] | null,
  evidence: { claim: string; quote: string }[] | null,
  extraFacts: string[]
) {
  const items: string[] = [];

  if (keyFindings?.length) items.push(...keyFindings);

  // jeśli keyFindings brak, a evidence jest -> użyj claim
  if ((!keyFindings || !keyFindings.length) && evidence?.length) {
    for (const e of evidence) {
      if (e?.claim) items.push(String(e.claim));
    }
  }

  // dopnij ekstra fakty (np. 3 mm)
  if (extraFacts?.length) items.push(...extraFacts);

  const uniq = uniqStrings(items);

  // filtr: wyrzucamy handling i “kliniczne decyzje” z listy obrazowej
  const filtered = uniq.filter((x) => !looksHandlingSentence(x)).filter((x) => !looksNonImagingSentence(x));

  return filtered.length ? filtered.slice(0, 8) : uniq.length ? uniq.slice(0, 8) : null;
}

function classifyToSections(facts: string[]) {
  const buckets: Record<string, string[]> = {
    Macica: [],
    Jajniki: [],
    "Pęcherz moczowy": [],
    "Jama brzuszna / płyn": [],
    Inne: [],
  };

  for (const f of facts) {
    const t = f.toLowerCase();

    if (looksHandlingSentence(f)) continue;

    if (/(macic|rogi macicy|piometr|ropomacic)/.test(t)) buckets["Macica"].push(f);
    else if (/(jajnik|torbiel)/.test(t)) buckets["Jajniki"].push(f);
    else if (/(pęcherz|pęcherza)/.test(t)) buckets["Pęcherz moczowy"].push(f);
    else if (/(woln(y|ego)\s+płyn|zachyłek|między pętlami|jama brzuszn)/.test(t)) buckets["Jama brzuszna / płyn"].push(f);
    else buckets["Inne"].push(f);
  }

  for (const k of Object.keys(buckets)) {
    buckets[k] = uniqStrings(buckets[k]);
  }

  return buckets;
}

function buildFindingsSectioned(params: {
  sectionsFindings: string | null;
  keyFindings: string[] | null;
  evidence: { claim: string; quote: string }[] | null;
  extraFacts: string[];
}) {
  // Jeśli mamy findings od modelu, to go “odśmiecamy” i ewentualnie rozbijamy na linie
  if (!isEmptyText(params.sectionsFindings)) {
    const f = cleanMedicalPolish(params.sectionsFindings!.trim());

    // rozbij na krótkie linie po przecinkach i średnikach
    const parts = f
      .split(/[;,]\s+/)
      .map((x) => x.trim())
      .filter(Boolean)
      .filter((x) => !looksHandlingSentence(x));

    // dopnij brakujące fakty (np. 3 mm) – jeśli nie ma ich już w tekście
    const out: string[] = [];
    if (parts.length) out.push(...parts);
    for (const ef of params.extraFacts) {
      const efc = cleanMedicalPolish(ef);
      if (!efc) continue;
      if (!out.some((p) => p.toLowerCase().includes("3 mm") && efc.toLowerCase().includes("3 mm"))) {
        out.push(efc);
      }
    }

    if (out.length >= 4) return out.map((x) => `- ${x.replace(/\.$/, "")}`).join("\n");
    return out.join(", ");
  }

  // fallback: buduj opis z faktów
  const rawFacts: string[] = [];

  if (params.keyFindings?.length) rawFacts.push(...params.keyFindings);
  if (params.evidence?.length) rawFacts.push(...params.evidence.map((e) => e.claim).filter(Boolean));
  if (params.extraFacts?.length) rawFacts.push(...params.extraFacts);

  const facts = uniqStrings(rawFacts).filter((x) => !looksHandlingSentence(x)).slice(0, 12);
  if (!facts.length) return "Brak jednoznacznego opisu narządów w transkrypcji.";

  const buckets = classifyToSections(facts);

  // jeśli większość jest “Macica/Jajniki/Pęcherz” – sekcje; w innym razie lista
  const lines: string[] = [];
  const order = ["Macica", "Jajniki", "Pęcherz moczowy", "Jama brzuszna / płyn", "Inne"] as const;

  let hadSection = false;
  for (const sec of order) {
    const items = buckets[sec];
    if (!items?.length) continue;
    hadSection = true;
    lines.push(`${sec}:`);
    for (const it of items.slice(0, 6)) {
      lines.push(`- ${it}`);
    }
    lines.push("");
  }

  if (!hadSection) return facts.map((x) => `- ${x}`).join("\n");

  return lines.join("\n").trim();
}

function buildEvidenceBlock(evidence: { claim: string; quote: string }[] | null) {
  if (!evidence?.length) return "";
  const lines = evidence
    .slice(0, 4)
    .map((e, i) => {
      const claim = cleanMedicalPolish(String(e.claim || "").trim());
      const quote = safeOneLine(String(e.quote || "")).slice(0, 160);
      if (!claim || !quote) return null;
      return `${i + 1}. ${claim}\n   „${quote}”`;
    })
    .filter(Boolean);

  if (!lines.length) return "";
  return `\nDowody z transkrypcji (cytaty):\n${lines.join("\n")}\n`;
}

function hasUterusLeak(transcript?: string | null, evidence?: { claim: string; quote: string }[] | null) {
  const t = (transcript || "").toLowerCase();
  const e = (evidence || []).map((x) => `${x.claim} ${x.quote}`.toLowerCase()).join(" ");
  const full = `${t} ${e}`;

  // “macica ... zaczyna przeciekać” / “ropa ... przecieka”
  return /(macica[^.]{0,120}przeciek|zaczyna\s+przeciekać|macica\s+jest\s+wypełniona\s+ropą[^.]{0,80}przeciek)/.test(full);
}

function fixConclusionsLeakMixup(conclusions: string, transcript?: string | null, evidence?: { claim: string; quote: string }[] | null) {
  let c = cleanMedicalPolish(conclusions);

  // jeśli mamy dowód na przeciekanie macicy, a wnioski mówią o “przecieku pęcherza” -> popraw
  if (hasUterusLeak(transcript, evidence)) {
    const low = c.toLowerCase();

    const mentionsBladderLeak =
      /przeciek[a-ząćęłńóśźż]*[^.]{0,60}(pęcherz|pęcherza)/.test(low) ||
      /(pęcherz|pęcherza)[^.]{0,60}przeciek[a-ząćęłńóśźż]*/.test(low);

    if (mentionsBladderLeak) {
      c = c
        .replace(/przeciek[a-ząćęłńóśźż]*[^.]{0,60}(pęcherz|pęcherza)/gi, "podejrzeniem przeciekania macicy")
        .replace(/(pęcherz|pęcherza)[^.]{0,60}przeciek[a-ząćęłńóśźż]*/gi, "podejrzeniem przeciekania macicy");
    }

    // jeśli jest “przeciek” bez wskazania – doprecyzuj bez zgadywania przyczyny
    if (/przeciek[a-ząćęłńóśźż]*/.test(low) && !/macic/.test(low)) {
      c = c.replace(/przeciek[a-ząćęłńóśźż]*/gi, "podejrzenie przeciekania macicy");
    }
  }

  return c;
}

// ================= Report builder =================

function buildReport(params: {
  examType?: string;
  patientLabel?: string | null;
  conditions?: string | null;

  sections: {
    reason?: string | null;
    findings?: string | null;
    conclusions?: string | null;
    recommendations?: string | null;
  };

  keyFindings?: string[] | null;
  evidence?: { claim: string; quote: string }[] | null;

  transcript?: string | null;
  transcriptQualityScore?: number | null;
  transcriptQualityFlags?: string[] | null;

  fallbackUsed: boolean;
  includeTranscriptSource: boolean;

  // QA/debug
  includeEvidenceInReport: boolean;
}) {
  const s = params.sections;
  const examType = inferExamTypeFallback(params.examType, s.findings ?? null, s.conclusions ?? null);
  const title = params.patientLabel ? `${examType} – ${params.patientLabel}` : `${examType}`;

  const reason = smartReasonFallback(s.reason ?? null, examType);

  // Extra fact: “ściana ~3 mm”
  const extraFacts: string[] = [];
  const wall3mm = extractUterusWallThicknessFact(params.transcript || null);
  if (wall3mm) extraFacts.push(wall3mm);

  const findings = buildFindingsSectioned({
    sectionsFindings: s.findings ?? null,
    keyFindings: params.keyFindings || null,
    evidence: params.evidence || null,
    extraFacts,
  });

  // Najważniejsze ustalenia: obrazowe, bez “zaleceń/akcji” i bez handlingu
  const keyFindingsClean = buildKeyFindingsClean(params.keyFindings || null, params.evidence || null, extraFacts);
  const keyFindingsBlock =
    keyFindingsClean?.length
      ? `\nNajważniejsze ustalenia:\n${keyFindingsClean.map((x) => `- ${x}`).join("\n")}\n`
      : "";

  const conclusionsBase = isEmptyText(s.conclusions)
    ? "Brak jednoznacznych wniosków w transkrypcji — proszę zweryfikować opis badania."
    : String(s.conclusions).trim();

  const conclusions = fixConclusionsLeakMixup(conclusionsBase, params.transcript || null, params.evidence || null);

  // Zalecenia: jeśli brak w analizie -> bezpieczne ogólne (bez “wymyślonych” badań)
  const recommendations = isEmptyText(s.recommendations)
    ? "Pilna konsultacja i korelacja z obrazem klinicznym pacjenta; decyzje terapeutyczne po weryfikacji przez lekarza."
    : cleanMedicalPolish(String(s.recommendations).trim());

  const qScore: number | null =
    typeof params.transcriptQualityScore === "number" ? params.transcriptQualityScore : null;
  const qFlags = params.transcriptQualityFlags?.length ? params.transcriptQualityFlags.join(", ") : null;

  const qualityLine =
    typeof qScore === "number"
      ? `Jakość transkrypcji: ${qScore}/100${qFlags ? ` (flags: ${qFlags})` : ""}`
      : "Jakość transkrypcji: brak danych";

  const banner = params.fallbackUsed ? "⚠ RAPORT TECHNICZNY (analiza zawiera braki) — wymaga weryfikacji lekarza." : null;

  const qualityNotice = buildQualityNotice(qScore);
  const aiFooter =
    "Raport wygenerowany automatycznie na podstawie transkrypcji AI (rozpoznawanie mowy) oraz analizy AI. Wymagana weryfikacja i zatwierdzenie przez lekarza weterynarii.";

  // Cytaty: tryb QA/debug (OFF domyślnie)
  const evidenceBlock = params.includeEvidenceInReport ? buildEvidenceBlock(params.evidence || null) : "";

  const source =
    params.includeTranscriptSource && params.transcript && params.transcript.trim()
      ? safeOneLine(params.transcript).slice(0, 1400)
      : null;

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
    keyFindingsBlock ? keyFindingsBlock.trimEnd() : null,
    evidenceBlock ? evidenceBlock.trimEnd() : null,
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

// ================= Endpoint =================

export async function POST(req: NextRequest) {
  try {
    const body = (await req.json()) as {
      clinicId?: string;
      patientId?: string;
      examId?: string;
      includeTranscriptSource?: boolean;

      // QA/debug
      includeEvidenceInReport?: boolean;
    };

    const { clinicId, patientId, examId } = body;
    const includeTranscriptSource = Boolean(body?.includeTranscriptSource); // default false
    const includeEvidenceInReport = Boolean(body?.includeEvidenceInReport); // default false

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

    const transcript: string | null =
      exam?.transcriptNormalized ? String(exam.transcriptNormalized) : exam?.transcript ? String(exam.transcript) : null;

    const tqScore: number | null =
      typeof exam?.transcriptQuality?.score === "number" ? exam.transcriptQuality.score : null;

    const tqFlagsList = flagsToList(exam?.transcriptQuality?.flags);
    const tqFlagsFromMeta = flagsToList(exam?.transcriptMeta?.qualityFlags);
    const tqFlags: string[] | null = tqFlagsList?.length ? tqFlagsList : tqFlagsFromMeta?.length ? tqFlagsFromMeta : null;

    const rawSections = exam?.analysis?.sections || null;
    const keyFindings = normalizeStringArray(exam?.analysis?.keyFindings);

    const evidenceRaw = Array.isArray(exam?.analysis?.evidence) ? exam.analysis.evidence : null;
    const evidence =
      Array.isArray(evidenceRaw)
        ? evidenceRaw
            .map((e: any) => ({
              claim: typeof e?.claim === "string" ? cleanMedicalPolish(e.claim.trim()) : "",
              quote: typeof e?.quote === "string" ? e.quote : "",
            }))
            .filter((e: any) => e.claim && e.quote)
            .slice(0, 6)
        : null;

    let sections = normalizeSections(rawSections);

    const emptyAll =
      isEmptyText(sections.reason) &&
      isEmptyText(sections.findings) &&
      isEmptyText(sections.conclusions) &&
      isEmptyText(sections.recommendations);

    const fallbackUsed = emptyAll;

    const patientLabel = extractPatientLabel(exam, transcript);
    const conditions = extractConditions(transcript);

    const report = buildReport({
      examType: exam?.type,
      patientLabel,
      conditions,
      sections,
      keyFindings,
      evidence,
      transcript,
      transcriptQualityScore: tqScore,
      transcriptQualityFlags: tqFlags,
      fallbackUsed,
      includeTranscriptSource,
      includeEvidenceInReport,
    });

    const reportQuality = {
      hasReason: !isEmptyText(sections.reason),
      hasFindings: !isEmptyText(sections.findings),
      hasConclusions: !isEmptyText(sections.conclusions),
      hasRecommendations: !isEmptyText(sections.recommendations),
      hasKeyFindings: !!(keyFindings && keyFindings.length),
      hasEvidence: !!(evidence && evidence.length),
      fallbackUsed,
      includeTranscriptSource,
      includeEvidenceInReport,
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
        engine: "facts-first-sectioned-3mm-leakfix-handling-filter",
        basedOn: "analysis.sections + analysis.keyFindings + analysis.evidence + transcript heuristics (no invented tests)",
        fallbackUsed,
        includeTranscriptSource,
        includeEvidenceInReport,
      },
      reportQuality,
      updatedAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      reportPreview: report.slice(0, 1400),
      reportQuality,
      fallbackUsed,
      includeTranscriptSource,
      includeEvidenceInReport,
    });
  } catch (err: any) {
    console.error("GENERATE REPORT ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

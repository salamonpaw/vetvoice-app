// app/api/exams/analyze/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION = "analyze-v6-structured-clean";

// ---- LM Studio config ----
function getLmConfig() {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.LMSTUDIO_MODEL || "qwen2.5-14b-instruct";
  return { baseUrl, model };
}

// ---- Firebase Admin ----
async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });
  return getFirestore(app);
}

// ---- Text cleaning (deterministyczne) ----
function cleanMedicalPolish(input: string) {
  let s = input;

  // częste błędy STT / odmiany
  s = s.replace(/\bnetki\b/gi, "nerki");
  s = s.replace(/\bbrusznej\b/gi, "brzusznej");
  s = s.replace(/\bbruszna\b/gi, "brzuszna");
  s = s.replace(/\bbruszny\b/gi, "brzuszny");
  s = s.replace(/\bbrusznego\b/gi, "brzusznego");

  // "przeroźniona" itp.
  s = s.replace(/\bprzeroźnion([aąeęyio])\b/gi, "przerośnięt$1");
  s = s.replace(/\bprzeroźnięt([aąeęyio])\b/gi, "przerośnięt$1");
  s = s.replace(/\bprzeroźnięta\b/gi, "przerośnięta");
  s = s.replace(/\bprzeroźnięty\b/gi, "przerośnięty");
  s = s.replace(/\bprzeroźnięte\b/gi, "przerośnięte");

  // "kęste osad" -> "gęsty osad" (różne końcówki)
  s = s.replace(/\bkęst([eyąa])\b/gi, "gęst$1");

  // opcjonalnie: cysta/cysty -> torbiel/torbiele (jeśli wolisz)
  // UWAGA: jeśli wolisz zostawić "cysta", zakomentuj blok poniżej
  s = s.replace(/\bcystami\b/gi, "torbielami");
  s = s.replace(/\bcystach\b/gi, "torbielach");
  s = s.replace(/\bcysty\b/gi, "torbiele");
  s = s.replace(/\bcysta\b/gi, "torbiel");
  s = s.replace(/\bcyste\b/gi, "torbiele");

  // whitespace
  s = s.replace(/\s+/g, " ").trim();
  return s;
}

// ---- Prompt ----
function buildSystemPrompt(examType: string) {
  return `
Jesteś asystentem lekarza weterynarii. Masz WYŁĄCZNIE wyekstrahować informacje medyczne z transkrypcji i przypisać je do pól.

WYMÓG FORMATU:
- Zwróć WYŁĄCZNIE poprawny JSON.
- Bez markdown, bez komentarzy, bez dodatkowego tekstu.
- Każda wartość string ma być w JEDNEJ LINII (bez znaków nowej linii).
- Jeśli brak informacji -> null.
- Nie wymyślaj faktów.
- Ignoruj komendy/uspokajanie/organizacyjne ("spokojnie", "nie ruszaj się", "moment", itp.).
- Jeśli w transkrypcji jest oczywista literówka (np. "netki" -> "nerki", "brusznej" -> "brzusznej", "kęste" -> "gęste", "przeroźnięta" -> "przerośnięta"), popraw ją w polach wynikowych.

Sekcje (krótko, klinicznie):
- reason: powód wizyty (1–2 zdania)
- findings: opis badania: zapisuj narządami w formacie "Wątroba: ... Śledziona: ... Nerki: ... Pęcherz: ... Prostata: ..." jeśli te narządy są w transkrypcji.
- conclusions: wnioski/podsumowanie (1–3 zdania, bez spekulacji; nie używaj "chyba/może", chyba że pada w transkrypcji)
- recommendations: zalecenia (TYLKO jeśli w transkrypcji padają konkretne działania)

Dodatkowo:
- entities: kluczowe encje (pacjent, narządy, problemy)
- keyFindings: 3–8 najważniejszych ustaleń (krótkie punkty, bez numeracji)
- evidence: do 6 krótkich cytatów (claim + quote) wspierających kluczowe ustalenia; quote to krótki fragment transkrypcji (1 linia)

Typ badania: ${examType}

Oczekiwany JSON (dokładnie te klucze):
{
  "sections": {
    "reason": string | null,
    "findings": string | null,
    "conclusions": string | null,
    "recommendations": string | null
  },
  "entities": {
    "patientName": string | null,
    "organsMentioned": string[] | null,
    "problemsMentioned": string[] | null
  },
  "keyFindings": string[] | null,
  "evidence": { "claim": string, "quote": string }[] | null
}
`.trim();
}

// ---- JSON helpers ----
function extractJsonObject(text: string) {
  const t = (text || "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first !== -1 && last !== -1 && last > first) return t.slice(first, last + 1);
  return t;
}

function escapeNewlinesInsideJsonStrings(input: string) {
  let out = "";
  let inString = false;
  let escaped = false;

  for (let i = 0; i < input.length; i++) {
    const ch = input[i];

    if (!inString) {
      if (ch === '"') {
        inString = true;
        escaped = false;
      }
      out += ch;
      continue;
    }

    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }

    if (ch === "\\") {
      out += ch;
      escaped = true;
      continue;
    }

    if (ch === '"') {
      inString = false;
      out += ch;
      continue;
    }

    if (ch === "\n") {
      out += "\\n";
      continue;
    }
    if (ch === "\r") {
      out += "\\r";
      continue;
    }

    out += ch;
  }

  return out;
}

function safeJsonParse(text: string) {
  const slice = extractJsonObject(text);
  try {
    return JSON.parse(slice);
  } catch {
    const repaired = escapeNewlinesInsideJsonStrings(slice);
    return JSON.parse(repaired);
  }
}

function oneLine(s: string) {
  return s.replace(/\r?\n|\r/g, " ").replace(/\s+/g, " ").trim();
}

function normString(v: any): string | null {
  if (typeof v !== "string") return null;
  return cleanMedicalPolish(oneLine(v));
}

function normArray(arr: any): string[] | null {
  if (!Array.isArray(arr)) return null;
  const cleaned = arr
    .filter((x) => typeof x === "string")
    .map((x) => cleanMedicalPolish(oneLine(x)))
    .filter(Boolean);

  const uniq = Array.from(new Set(cleaned));
  return uniq.length ? uniq : null;
}

function normEvidence(arr: any): { claim: string; quote: string }[] | null {
  if (!Array.isArray(arr)) return null;
  const cleaned = arr
    .map((x) => ({
      claim: typeof x?.claim === "string" ? cleanMedicalPolish(oneLine(x.claim)) : null,
      quote: typeof x?.quote === "string" ? cleanMedicalPolish(oneLine(x.quote)) : null,
    }))
    .filter((x) => !!x.claim && !!x.quote)
    .slice(0, 6) as { claim: string; quote: string }[];

  return cleaned.length ? cleaned : null;
}

// ---- LM calls ----
async function callLmChat(args: {
  baseUrl: string;
  model: string;
  system: string;
  user: string;
  maxTokens?: number;
  temperature?: number;
  useJsonResponseFormat?: boolean;
}) {
  const { baseUrl, model, system, user, maxTokens = 900, temperature = 0, useJsonResponseFormat = true } = args;

  const body: any = {
    model,
    stream: false,
    temperature,
    max_tokens: maxTokens,
    messages: [
      { role: "system", content: system },
      { role: "user", content: user },
    ],
  };

  if (useJsonResponseFormat) {
    body.response_format = { type: "json_object" };
  }

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();

  if (!res.ok) {
    return { ok: false as const, status: res.status, rawText };
  }

  let json: any = null;
  try {
    json = JSON.parse(rawText);
  } catch {
    return { ok: false as const, status: 502, rawText };
  }

  const content = json?.choices?.[0]?.message?.content;
  return { ok: true as const, status: 200, content: typeof content === "string" ? content : "", rawText };
}

async function fixJsonWithLlm(baseUrl: string, model: string, broken: string) {
  const system = `
Jesteś narzędziem do naprawy danych. Dostaniesz tekst, który MA być JSON-em.
Zwróć WYŁĄCZNIE poprawny JSON (bez markdown, bez komentarzy, bez dodatkowego tekstu).
Nie zmieniaj znaczenia — tylko napraw format (cudzysłowy, przecinki, ucieczki znaków, domknięcia).
`.trim();

  const user = `NAPRAW TEN JSON I ZWRÓĆ POPRAWNY JSON:\n${broken}`;

  const r = await callLmChat({
    baseUrl,
    model,
    system,
    user,
    maxTokens: 1100,
    temperature: 0,
    useJsonResponseFormat: false,
  });

  if (!r.ok) return null;
  return r.content?.trim() || null;
}

// ---- Route ----
export async function POST(req: NextRequest) {
  const started = Date.now();

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

    // dual-path lookup
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
    const transcript: string | undefined = exam?.transcript;
    const examType: string = (exam?.type || "Badanie").toString();

    if (!transcript || !transcript.trim()) {
      return NextResponse.json({ error: "No transcript in exam (analyze requires transcript)" }, { status: 400 });
    }

    const { baseUrl, model } = getLmConfig();
    const system = buildSystemPrompt(examType);

    const user = `TRANSKRYPCJA:\n${transcript.trim()}`;

    // 1) call #1: z response_format
    let lm = await callLmChat({
      baseUrl,
      model,
      system,
      user,
      maxTokens: 1100,
      temperature: 0,
      useJsonResponseFormat: true,
    });

    // call #2: bez response_format (gdy serwer nie wspiera)
    if (!lm.ok) {
      lm = await callLmChat({
        baseUrl,
        model,
        system,
        user,
        maxTokens: 1100,
        temperature: 0,
        useJsonResponseFormat: false,
      });
    }

    if (!lm.ok) {
      return NextResponse.json(
        { error: "LM Studio error", status: lm.status, details: (lm.rawText || "").slice(0, 2000) },
        { status: 502 }
      );
    }

    const content = lm.content;
    if (!content || typeof content !== "string") {
      return NextResponse.json({ error: "LM Studio returned empty content" }, { status: 502 });
    }

    // 2) parse → jeśli nie przejdzie: spróbuj naprawić LLM-em → parse
    let parsed: any = null;
    let finalText = content;

    try {
      parsed = safeJsonParse(finalText);
    } catch {
      const fixed = await fixJsonWithLlm(baseUrl, model, finalText);
      if (!fixed) {
        return NextResponse.json(
          { error: "Invalid JSON from LLM", rawPreview: finalText.slice(0, 2000) },
          { status: 502 }
        );
      }
      finalText = fixed;

      try {
        parsed = safeJsonParse(finalText);
      } catch (e2: any) {
        return NextResponse.json(
          { error: "Invalid JSON from LLM (after fix)", details: e2?.message, rawPreview: finalText.slice(0, 2000) },
          { status: 502 }
        );
      }
    }

    const sections = parsed?.sections ?? {};
    const entities = parsed?.entities ?? {};
    const keyFindings = parsed?.keyFindings ?? null;
    const evidence = parsed?.evidence ?? null;

    const normalized = {
      sections: {
        reason: normString(sections.reason),
        findings: normString(sections.findings),
        conclusions: normString(sections.conclusions),
        recommendations: normString(sections.recommendations),
      },
      entities: {
        patientName: normString(entities.patientName),
        organsMentioned: normArray(entities.organsMentioned),
        problemsMentioned: normArray(entities.problemsMentioned),
      },
      keyFindings: normArray(keyFindings),
      evidence: normEvidence(evidence),
    };

    const missing = {
      reason: !normalized.sections.reason,
      findings: !normalized.sections.findings,
      conclusions: !normalized.sections.conclusions,
      recommendations: !normalized.sections.recommendations,
      keyFindings: !(normalized.keyFindings && normalized.keyFindings.length),
      evidence: !(normalized.evidence && normalized.evidence.length),
    };

    const latencyMs = Date.now() - started;

    await examRef.update({
      analysis: normalized,
      analysisMissing: missing,
      analysisMeta: {
        engine: "lmstudio",
        model,
        baseUrl,
        promptVersion: PROMPT_VERSION,
        latencyMs,
        analyzedAt: new Date(),
        jsonRepaired: finalText !== content,
      },
    });

    return NextResponse.json({
      ok: true,
      analysis: { ...normalized, missing },
      meta: {
        engine: "lmstudio",
        model,
        baseUrl,
        promptVersion: PROMPT_VERSION,
        latencyMs,
        jsonRepaired: finalText !== content,
      },
      docPath: examRef.path,
    });
  } catch (err: any) {
    console.error("ANALYZE ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

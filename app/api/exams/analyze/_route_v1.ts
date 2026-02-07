// app/api/exams/analyze/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION = "analyze-v4";

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

// ---- Prompt ----
function buildSystemPrompt(examType: string) {
  return `
Jesteś asystentem lekarza weterynarii. Masz WYŁĄCZNIE wyekstrahować informacje medyczne z transkrypcji i przypisać je do pól raportu.

WYMÓG FORMATU:
- Zwróć WYŁĄCZNIE poprawny JSON.
- Bez markdown, bez komentarzy, bez dodatkowego tekstu.
- Każda wartość string ma być w JEDNEJ LINII (bez znaków nowej linii).
- Jeśli brak informacji -> null.
- Nie wymyślaj faktów.
- Ignoruj komendy/uspokajanie/organizacyjne ("spokojnie", "nie ruszaj się", "moment", itp.).

Sekcje:
- reason: powód wizyty (1–2 zdania)
- findings: opis badania (co oceniono i co stwierdzono)
- conclusions: wnioski/podsumowanie
- recommendations: zalecenia (tylko jeśli padają konkretne)

Typ badania: ${examType}

Oczekiwany JSON (dokładnie te klucze):
{
  "sections": {
    "reason": string | null,
    "findings": string | null,
    "conclusions": string | null,
    "recommendations": string | null
  }
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

    // kluczowe: gołe newline w stringu = invalid JSON
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
    // ratunek #1: zamień newline wewnątrz stringów na \n
    const repaired = escapeNewlinesInsideJsonStrings(slice);
    return JSON.parse(repaired);
  }
}

function oneLine(s: string) {
  // “jedna linia” + kompresja whitespace
  return s
    .replace(/\r?\n|\r/g, " ")
    .replace(/\s+/g, " ")
    .trim();
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
  const { baseUrl, model, system, user, maxTokens = 500, temperature = 0, useJsonResponseFormat = true } = args;

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

  // OpenAI-compatible: response_format
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

  // bez response_format — bywa, że LM Studio się czepia
  const r = await callLmChat({
    baseUrl,
    model,
    system,
    user,
    maxTokens: 700,
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
      clinicId?: string; // opcjonalne
      patientId?: string;
      examId?: string;
    };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();

    // dual-path lookup (jak generate-report)
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
    const transcript: string | undefined = exam?.transcript;
    const examType: string = (exam?.type || "Badanie").toString();

    if (!transcript || !transcript.trim()) {
      return NextResponse.json(
        { error: "No transcript in exam (analyze requires transcript)" },
        { status: 400 }
      );
    }

    const { baseUrl, model } = getLmConfig();
    const system = buildSystemPrompt(examType);

    // (opcjonalnie) utnij skrajnie długie transkrypcje, żeby nie rozwalić kontekstu
    const transcriptTrimmed = transcript.trim();
    const user = `TRANSKRYPCJA:\n${transcriptTrimmed}`;

    // 1) call #1: z response_format
    let lm = await callLmChat({
      baseUrl,
      model,
      system,
      user,
      maxTokens: 600,
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
        maxTokens: 600,
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
    const normalized = {
      sections: {
        reason: typeof sections.reason === "string" ? oneLine(sections.reason) : null,
        findings: typeof sections.findings === "string" ? oneLine(sections.findings) : null,
        conclusions: typeof sections.conclusions === "string" ? oneLine(sections.conclusions) : null,
        recommendations: typeof sections.recommendations === "string" ? oneLine(sections.recommendations) : null,
      },
    };

    const missing = {
      reason: !normalized.sections.reason,
      findings: !normalized.sections.findings,
      conclusions: !normalized.sections.conclusions,
      recommendations: !normalized.sections.recommendations,
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
        // pomocne w debug: czy było naprawiane
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

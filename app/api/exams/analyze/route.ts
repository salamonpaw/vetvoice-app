// app/api/exams/analyze/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION = "analysis-v5-diagnoses-from-impression-sanitize";
const LM_TIMEOUT_MS = Number(process.env.ANALYZE_LM_TIMEOUT_MS || 60000);

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

/* ================= LM Studio ================= */

function getLmConfig(modelOverride?: string) {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
  const model =
    modelOverride ||
    process.env.LMSTUDIO_MODEL ||
    "qwen2.5-14b-instruct-1m";
  const apiKey = process.env.LMSTUDIO_API_KEY || "lm-studio";
  return { baseUrl, model, apiKey };
}

/* ================= PROMPT ================= */

function buildSystemPrompt() {
  return `
Jesteś doświadczonym lekarzem weterynarii – diagnostą obrazowym.

ETAP B — SYNTEZA NA PODSTAWIE:
(1) facts — suche fakty i pomiary (ETAP A)
(2) impression — dokładnie to, co powiedział lekarz (ETAP A2)

ZASADY:
- Zwróć WYŁĄCZNIE poprawny JSON. Bez markdown. Bez komentarzy.
- Język: polski, formalny.
- NIE twórz zaleceń ani red flags — będą narzucone z impression po stronie serwera.
- Nie dopowiadaj etiologii. Jeśli brak podstaw → pomiń.
- Skup się na krótkim, rzeczowym summary (zgodnym z impression.doctorOverall)
  oraz na confidence (0–100).

FORMAT WYJŚCIA:
{
  "summary": string | null,
  "confidence": number
}
`;
}

/* ================= LLM CALL ================= */

async function callLmStudio(args: {
  systemPrompt: string;
  userContent: string;
  modelOverride?: string;
}) {
  const { baseUrl, model, apiKey } = getLmConfig(args.modelOverride);
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const body = {
    model,
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userContent },
    ],
    temperature: 0.1,
    max_tokens: 600,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), LM_TIMEOUT_MS);

  const started = Date.now();
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${apiKey}`,
      },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(
        `LM Studio error (${res.status}): ${rawText.slice(0, 2000)}`
      );
    }

    const data = JSON.parse(rawText);
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("LM Studio returned empty content");
    }

    return {
      content,
      modelUsed: model,
      tookMs: Date.now() - started,
    };
  } finally {
    clearTimeout(timeout);
  }
}

/* ================= HELPERS ================= */

function extractJsonObject(text: string) {
  const start = text.indexOf("{");
  const end = text.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return text.slice(start, end + 1);
}

function toStringArray(x: any, max = 40): string[] {
  if (!Array.isArray(x)) return [];
  return x
    .filter((v) => typeof v === "string")
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, max);
}

/**
 * sanitizeText:
 * - ma "odmulić" summary/overall z terminów, których nie chcesz widzieć,
 *   nawet jeśli padły w cytacie lekarza.
 * - działa deterministycznie (bez LLM).
 */
function sanitizeText(input: string): string {
  let s = input;

  // ujednolicenia
  s = s.replace(/\s+/g, " ").trim();

  // zamiana "może sugerować ..." na bardziej neutralne "może wskazywać na ..."
  s = s.replace(/\bmoże sugerować\b/gi, "może wskazywać na");

  // neutralizacja słów "zapalny / nowotworowy / patologia" itp.
  // (możesz rozszerzać listę)
  const replacements: Array<[RegExp, string]> = [
    [/\bzapaln\w*\b/gi, "inny"],
    [/\bnowotwor\w*\b/gi, "inny"],
    [/\bpatologi\w*\b/gi, "odchylenia"],
    [/\bguz\w*\b/gi, "zmiana"],
    [/\bneoplazj\w*\b/gi, "zmiana"],
    [/\binflamacj\w*\b/gi, "odchylenia"],
  ];

  for (const [re, rep] of replacements) {
    s = s.replace(re, rep);
  }

  // kosmetyka podwójnych spacji i kropki
  s = s.replace(/\s+\./g, ".");
  s = s.replace(/\.\./g, ".");
  s = s.trim();

  return s;
}

function buildMeasurementsSummaryFromFacts(facts: any): string[] {
  const m = facts?.measurements;
  if (!Array.isArray(m)) return [];

  const out: string[] = [];

  for (const it of m) {
    if (!it || typeof it !== "object") continue;

    let structure = typeof it.structure === "string" ? it.structure : null;
    if (!structure) continue;

    // delikatna korekta literówek (BEZ interpretacji)
    structure = structure.replace(/wroternej/gi, "wrotnej");

    const unit = typeof it.unit === "string" ? it.unit : null;
    const value = Array.isArray(it.value) ? it.value : [];
    if (!value.length) continue;

    const nums = value.map((n: unknown) => String(n));
    let valueStr = "";

    if (nums.length === 1) {
      valueStr = nums[0];
    } else if (nums.length === 2) {
      const isRange = unit ? /cm\/s/i.test(unit) : false;
      valueStr = isRange ? `${nums[0]}–${nums[1]}` : `${nums[0]} x ${nums[1]}`;
    } else {
      valueStr = nums.join(" x ");
    }

    const unitStr = unit ? ` ${unit}` : "";
    out.push(`${structure}: ${valueStr}${unitStr}`);
  }

  return out;
}

function buildClinicalReasoningFromImpression(
  impression: any,
  sanitize: boolean
): string[] {
  const out: string[] = [];

  const overallRaw =
    typeof impression?.doctorOverall === "string"
      ? impression.doctorOverall.trim()
      : "";

  const overall = overallRaw ? (sanitize ? sanitizeText(overallRaw) : overallRaw) : "";
  if (overall) out.push(overall);

  const concerns = toStringArray(impression?.doctorKeyConcerns, 30);
  for (const c of concerns) {
    out.push(`Do obserwacji wg lekarza: ${sanitize ? sanitizeText(c) : c}.`);
  }

  const plan = toStringArray(impression?.doctorPlan, 30);
  if (plan.length) {
    out.push(`Zalecenia wg lekarza: ${plan.join("; ")}.`);
  }

  const quotes = toStringArray(impression?.quotes, 12);
  if (quotes.length) {
    const q = quotes.slice(0, 3).map((x) => (sanitize ? sanitizeText(x) : x));
    out.push(`Źródło (cytaty): ${q.join(" | ")}.`);
  }

  return out.slice(0, 12);
}

/* ================= ENDPOINT ================= */

export async function POST(req: NextRequest) {
  try {
    const { patientId, examId, useAltModel, sanitize } =
      (await req.json()) as {
        patientId?: string;
        examId?: string;
        useAltModel?: boolean;
        sanitize?: boolean;
      };

    if (!patientId || !examId) {
      return NextResponse.json(
        { error: "Missing patientId or examId" },
        { status: 400 }
      );
    }

    const requestedModelName = useAltModel
      ? process.env.LMSTUDIO_MODEL_ALT || process.env.LMSTUDIO_MODEL
      : process.env.LMSTUDIO_MODEL;

    const adminDb = await getAdminDb();
    const ref = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const snap = await ref.get();

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;
    const facts = exam?.facts;
    const impression = exam?.impression;

    if (!facts) {
      return NextResponse.json(
        { error: "Missing facts (run extract-facts first)" },
        { status: 400 }
      );
    }

    if (!impression) {
      return NextResponse.json(
        { error: "Missing impression (run extract-impression first)" },
        { status: 400 }
      );
    }

    const doSanitize = Boolean(sanitize);

    const measurementsSummary = buildMeasurementsSummaryFromFacts(facts);
    const clinicalReasoning = buildClinicalReasoningFromImpression(
      impression,
      doSanitize
    );

    // LLM tylko summary + confidence
    const payload = {
      facts,
      impression,
      measurementsSummary,
    };

    const lm = await callLmStudio({
      systemPrompt: buildSystemPrompt(),
      userContent: JSON.stringify(payload, null, 2),
      modelOverride: requestedModelName,
    });

    const raw = String(lm.content || "");
    let modelOut: any = null;

    try {
      modelOut = JSON.parse(raw);
    } catch {
      const extracted = extractJsonObject(raw);
      if (!extracted) {
        return NextResponse.json(
          { error: "Model returned non-JSON", preview: raw.slice(0, 400) },
          { status: 502 }
        );
      }
      modelOut = JSON.parse(extracted);
    }

    const summaryRaw =
      typeof modelOut?.summary === "string" ? modelOut.summary.trim() : null;

    const analysis = {
      summary:
        summaryRaw && doSanitize ? sanitizeText(summaryRaw) : summaryRaw,

      // TWARDO z impression — zero dopisków modelu
      diagnoses: toStringArray(impression?.doctorKeyConcerns, 40),

      clinicalReasoning,
      measurementsSummary,

      // Twardo z impression, bez kreatywności modelu
      recommendations: toStringArray(impression?.doctorPlan, 30),
      redFlags: toStringArray(impression?.doctorRedFlags, 30),

      confidence:
        typeof modelOut?.confidence === "number"
          ? Math.max(0, Math.min(100, modelOut.confidence))
          : 80,
    };

    await ref.update({
      analysis,
      analysisMeta: {
        at: new Date(),
        version: PROMPT_VERSION,
        modelUsed: lm.modelUsed,
        tookMs: lm.tookMs,
        sanitize: doSanitize,
      },
    });

    return NextResponse.json({
      ok: true,
      docPath: ref.path,
      analysis,
      tookMs: lm.tookMs,
    });
  } catch (e: any) {
    return NextResponse.json(
      { error: e?.message ?? "Unknown error" },
      { status: 500 }
    );
  }
}

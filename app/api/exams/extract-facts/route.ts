// app/api/exams/extract-facts/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROMPT_VERSION = "facts-v13-retry+truncated-json-guard+firestore-safe";

const HEAD_CHARS = Number(process.env.FACTS_HEAD_CHARS || 6000);
const TAIL_CHARS = Number(process.env.FACTS_TAIL_CHARS || 4500);
const LM_TIMEOUT_MS = Number(process.env.FACTS_LM_TIMEOUT_MS || 60000);
const MAX_TOKENS = Number(process.env.FACTS_MAX_TOKENS || 900);

// retry knobs (safe defaults)
const FACTS_RETRY_ON_PARSE_FAIL = (process.env.FACTS_RETRY_ON_PARSE_FAIL || "1") === "1";
const FACTS_RETRY_TAIL_CHARS = Number(process.env.FACTS_RETRY_TAIL_CHARS || 3500);
const FACTS_RETRY_MAX_TOKENS = Number(process.env.FACTS_RETRY_MAX_TOKENS || 600);
const FACTS_RETRY_TIMEOUT_MS = Number(process.env.FACTS_RETRY_TIMEOUT_MS || 45000);

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

function head(s: string, maxChars: number) {
  if (!s) return "";
  return s.length > maxChars ? s.slice(0, maxChars) : s;
}
function tail(s: string, maxChars: number) {
  if (!s) return "";
  return s.length > maxChars ? s.slice(-maxChars) : s;
}
function headTail(transcript: string) {
  const h = head(transcript, HEAD_CHARS);
  const t = tail(transcript, TAIL_CHARS);
  if (h === t) return h;
  return `${h}\n\n---\n\n${t}`.trim();
}

function applyDictionary(input: string) {
  const dict: Array<[RegExp, string]> = [
    [/\bmiąż\b/gi, "miąższ"],
    [/\behebryczność\b/gi, "echogeniczność"],
    [/\bechogoniczność\b/gi, "echogeniczność"],
    [/\bjedniczka\b/gi, "miedniczka"],
    [/\bamy brzusznej\b/gi, "jamy brzusznej"],
    [/\bJedeja\b/g, "Jedynie"],
    [/\bdo plerem\b/gi, "dopplerem"],
  ];

  let out = input;
  let appliedCount = 0;

  for (const [re, rep] of dict) {
    const before = out;
    out = out.replace(re, rep);
    if (out !== before) appliedCount++;
  }

  return { out, appliedCount };
}

function extractFirstJsonObject(s: string): string | null {
  const start = s.indexOf("{");
  if (start < 0) return null;

  let depth = 0;
  let inStr = false;
  let esc = false;

  for (let i = start; i < s.length; i++) {
    const ch = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
      continue;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") {
        depth--;
        if (depth === 0) return s.slice(start, i + 1);
      }
    }
  }
  return null;
}

function safeParseModelJson<T>(
  raw: string
): { ok: true; json: T } | { ok: false; error: string; preview: string } {
  const preview = (raw || "").slice(0, 800);

  try {
    return { ok: true, json: JSON.parse(raw) as T };
  } catch {}

  const stripped = (raw || "").replace(/```json/gi, "").replace(/```/g, "").trim();
  const chunk = extractFirstJsonObject(stripped);
  if (!chunk) return { ok: false, error: "No JSON object found in model output", preview };

  try {
    return { ok: true, json: JSON.parse(chunk) as T };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}`, preview };
  }
}

function cleanUndefinedDeep<T>(v: T): T {
  if (v === undefined) return undefined as any;

  if (Array.isArray(v)) {
    return v
      .map((x) => cleanUndefinedDeep(x))
      .filter((x) => x !== undefined) as any;
  }

  if (v && typeof v === "object") {
    const out: any = {};
    for (const [k, val] of Object.entries(v as any)) {
      const cleaned = cleanUndefinedDeep(val);
      if (cleaned !== undefined) out[k] = cleaned;
    }
    return out;
  }

  return v;
}

function toNumberSafe(x: unknown): number | null {
  if (typeof x === "number" && Number.isFinite(x)) return x;
  if (typeof x === "string") {
    const s = x.trim().replace(",", ".");
    const n = Number(s);
    if (Number.isFinite(n)) return n;
  }
  return null;
}

type Measurement = {
  structure: string;
  value: number[];
  unit: string | null;
  location: string | null;
};

function normalizeMeasurements(input: unknown): Measurement[] {
  if (!Array.isArray(input)) return [];
  const out: Measurement[] = [];

  for (const m of input as any[]) {
    const structure = typeof m?.structure === "string" ? m.structure.trim() : "";
    if (!structure) continue;

    const unit = typeof m?.unit === "string" ? m.unit.trim() : null;
    const location = typeof m?.location === "string" ? m.location.trim() : null;

    const rawVals = Array.isArray(m?.value) ? m.value : m?.value != null ? [m.value] : [];
    const nums = rawVals
      .map((v: unknown) => toNumberSafe(v))
      .filter((n: number | null): n is number => n !== null);

    if (nums.length === 0) continue;

    out.push({ structure, value: nums, unit, location });
  }

  return out;
}

async function lmChatJson(args: {
  baseUrl: string;
  model: string;
  prompt: string;
  maxTokens: number;
  timeoutMs: number;
}) {
  const { baseUrl, model, prompt, maxTokens, timeoutMs } = args;

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), timeoutMs);

  const t0 = Date.now();
  try {
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      signal: controller.signal,
      body: JSON.stringify({
        model,
        temperature: 0,
        stream: false,
        max_tokens: maxTokens,
        messages: [{ role: "user", content: prompt }],
      }),
    });

    const text = await res.text();
    const tookMs = Date.now() - t0;

    // NOTE: tu nie parsujemy jeszcze JSON-a, bo czasem to bywa urwane
    return { status: res.status, text, tookMs };
  } finally {
    clearTimeout(timeout);
  }
}

function buildPrompt(transcript: string) {
  return `
Zwróć WYŁĄCZNIE poprawny JSON (bez komentarzy, bez markdown).

Struktura:
{
  "exam": { "bodyRegion": string | null, "reason": string | null, "patientName": string | null },
  "conditions": string[],
  "findings": string[],
  "measurements": { "structure": string, "value": number[], "unit": string | null, "location": string | null }[]
}

Zasady:
- Nie wymyślaj.
- Tylko to, co padło w transkrypcji.
- Jeśli brak → null lub [].
- W measurements: value zawsze tablica liczb (np. [8, 2]).
- NIE wpisuj pomiarów jeśli w transkrypcji nie ma liczb.

TRANSKRYPCJA:
"""${transcript}"""
`.trim();
}

export async function POST(req: NextRequest) {
  const tAll0 = Date.now();

  try {
    const { patientId, examId } = await req.json();
    if (!patientId || !examId) {
      return NextResponse.json({ ok: false, error: "Missing patientId/examId" }, { status: 400 });
    }

    const db = await getAdminDb();
    const examRef = db.collection("patients").doc(patientId).collection("exams").doc(examId);

    const snap = await examRef.get();
    if (!snap.exists) {
      return NextResponse.json({ ok: false, error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() || {};
    const transcript: string = exam.transcript || "";
    if (!transcript) {
      return NextResponse.json({ ok: false, error: "Missing transcript" }, { status: 400 });
    }

    const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
    const model = process.env.LMSTUDIO_MODEL;
    if (!model) throw new Error("Missing LMSTUDIO_MODEL");

    // pass #1: head+tail + dict
    const input0 = headTail(transcript);
    const dictRes = applyDictionary(input0);
    const input = dictRes.out;

    const prompt1 = buildPrompt(input);

    const lm1 = await lmChatJson({
      baseUrl,
      model,
      prompt: prompt1,
      maxTokens: MAX_TOKENS,
      timeoutMs: LM_TIMEOUT_MS,
    });

    // log
    let lm1Envelope: any = null;
    try {
      lm1Envelope = JSON.parse(lm1.text);
    } catch {
      // LM Studio powinno zwracać JSON envelope; jeśli nie, to traktujemy jako błąd
      return NextResponse.json(
        {
          ok: false,
          error: "LM Studio returned non-JSON envelope",
          lmPreview: lm1.text.slice(0, 800),
          tookMs: Date.now() - tAll0,
        },
        { status: 502 }
      );
    }

    const choice0 = lm1Envelope?.choices?.[0] ?? {};
    const finishReason1 = choice0?.finish_reason ?? null;
    const msg = choice0?.message ?? {};
    const rawText1 = typeof msg.content === "string" ? msg.content : JSON.stringify(lm1Envelope);

    let parsed = safeParseModelJson<any>(rawText1);

    // retry if parse failed (typically truncated JSON)
    let usedRetry = false;
    let finishReason2: string | null = null;

    if (!parsed.ok && FACTS_RETRY_ON_PARSE_FAIL) {
      usedRetry = true;

      const retryInput0 = tail(transcript, FACTS_RETRY_TAIL_CHARS);
      const retryDict = applyDictionary(retryInput0);
      const retryPrompt = buildPrompt(retryDict.out);

      const lm2 = await lmChatJson({
        baseUrl,
        model,
        prompt: retryPrompt,
        maxTokens: FACTS_RETRY_MAX_TOKENS,
        timeoutMs: FACTS_RETRY_TIMEOUT_MS,
      });

      let lm2Envelope: any = null;
      try {
        lm2Envelope = JSON.parse(lm2.text);
      } catch {
        return NextResponse.json(
          {
            ok: false,
            error: "LM Studio returned non-JSON envelope (retry)",
            lmPreview: lm2.text.slice(0, 800),
            tookMs: Date.now() - tAll0,
          },
          { status: 502 }
        );
      }

      const choice2 = lm2Envelope?.choices?.[0] ?? {};
      finishReason2 = choice2?.finish_reason ?? null;
      const msg2 = choice2?.message ?? {};
      const rawText2 = typeof msg2.content === "string" ? msg2.content : JSON.stringify(lm2Envelope);

      parsed = safeParseModelJson<any>(rawText2);

      console.log("[extract-facts] retry parse ok=", parsed.ok, "finish1=", finishReason1, "finish2=", finishReason2);
    } else {
      console.log("[extract-facts] parse ok=", parsed.ok, "finish=", finishReason1);
    }

    if (!parsed.ok) {
      // ważne: to NIE jest 500 — to jest problem z modelem/formatem
      return NextResponse.json(
        {
          ok: false,
          error: "Model returned truncated/invalid JSON",
          details: parsed.error,
          finishReason1,
          finishReason2,
          usedRetry,
          rawPreview: parsed.preview,
          tookMs: Date.now() - tAll0,
        },
        { status: 502 }
      );
    }

    const factsIn = parsed.json || {};

    // Normalizacja + krytyczne: zawsze tablice (żeby nie dziedziczyć starych wartości)
    const facts = {
      exam: {
        bodyRegion: typeof factsIn?.exam?.bodyRegion === "string" ? factsIn.exam.bodyRegion.trim() : null,
        reason: typeof factsIn?.exam?.reason === "string" ? factsIn.exam.reason.trim() : null,
        patientName: typeof factsIn?.exam?.patientName === "string" ? factsIn.exam.patientName.trim() : null,
      },
      conditions: Array.isArray(factsIn?.conditions)
        ? factsIn.conditions.filter((x: any) => typeof x === "string").map((s: string) => s.trim()).filter(Boolean)
        : [],
      findings: Array.isArray(factsIn?.findings)
        ? factsIn.findings.filter((x: any) => typeof x === "string").map((s: string) => s.trim()).filter(Boolean)
        : [],
      measurements: normalizeMeasurements(factsIn?.measurements),
    };

    const factsOut: any = {
      ...facts,
      conditionsLines: facts.conditions,
      findingsLines: facts.findings,
      reason: facts.exam.reason ?? null,
    };

    const safeFacts = cleanUndefinedDeep(factsOut);

    await examRef.update({
      facts: safeFacts,
      factsMeta: {
        at: FieldValue.serverTimestamp(),
        version: PROMPT_VERSION,
        baseUrl,
        modelUsed: model,
        preprocess: {
          dictionaryAppliedCount: dictRes.appliedCount,
          headChars: HEAD_CHARS,
          tailChars: TAIL_CHARS,
        },
        llm: {
          usedRetry,
          finishReason1,
          finishReason2,
        },
      },
    });

    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      facts: safeFacts,
      tookMs: Date.now() - tAll0,
    });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "LM timeout" : e?.message || "Unknown error";
    return NextResponse.json({ ok: false, error: msg, tookMs: Date.now() - tAll0 }, { status: 500 });
  }
}

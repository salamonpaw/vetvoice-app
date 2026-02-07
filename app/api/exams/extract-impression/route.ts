// app/api/exams/extract-impression/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore, FieldValue } from "firebase-admin/firestore";

const PROMPT_VERSION = "impression-v8-json-tags-stop-retry-pl";

// === TUNING (ENV overrides allowed) ===
const MAX_INPUT_CHARS = Number(process.env.IMPRESSION_MAX_INPUT_CHARS || 2800);
const MAX_TOKENS = Number(process.env.IMPRESSION_MAX_TOKENS || 700);
const LM_TIMEOUT_MS = Number(process.env.IMPRESSION_LM_TIMEOUT_MS || 45000);

// Retry (safe defaults)
const RETRY_ON_PARSE_FAIL = Number(process.env.IMPRESSION_RETRY_ON_PARSE_FAIL || 1); // 0/1
const RETRY_MAX_INPUT_CHARS = Number(process.env.IMPRESSION_RETRY_MAX_INPUT_CHARS || 2000);
const RETRY_MAX_TOKENS = Number(process.env.IMPRESSION_RETRY_MAX_TOKENS || 500);
const RETRY_TIMEOUT_MS = Number(process.env.IMPRESSION_RETRY_TIMEOUT_MS || 35000);

// === Firestore ===
async function getAdminDb() {
  if (!getApps().length) {
    const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
    if (!relPath) throw new Error("Missing FIREBASE_SERVICE_ACCOUNT_PATH");
    const absPath = path.resolve(process.cwd(), relPath);
    const raw = await fs.readFile(absPath, "utf-8");
    const serviceAccount = JSON.parse(raw);
    initializeApp({ credential: cert(serviceAccount) });
  }
  return getFirestore();
}

/* ================== helpers ================== */

function tail(s: string, maxChars: number) {
  if (!s) return "";
  return s.length > maxChars ? s.slice(-maxChars) : s;
}

function preview(s: string, max = 800) {
  const x = (s ?? "").toString();
  return x.length <= max ? x : x.slice(0, max) + "…";
}

function extractBetweenTags(s: string, openTag: string, closeTag: string): string | null {
  const a = s.indexOf(openTag);
  if (a < 0) return null;
  const b = s.indexOf(closeTag, a + openTag.length);
  if (b < 0) return null;
  return s.slice(a + openTag.length, b).trim();
}

// fallback: first complete JSON object scanning
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
): { ok: true; json: T; extracted: string } | { ok: false; error: string; extracted?: string } {
  const input = (raw || "").trim();
  if (!input) return { ok: false, error: "Empty model output" };

  // 1) Prefer <json> ... </json>
  const tagged = extractBetweenTags(input, "<json>", "</json>");
  if (tagged) {
    try {
      return { ok: true, json: JSON.parse(tagged) as T, extracted: tagged };
    } catch (e) {
      return { ok: false, error: `JSON parse failed (tagged): ${(e as Error).message}`, extracted: tagged };
    }
  }

  // 2) Strip markdown fences
  const stripped = input.replace(/```json/gi, "").replace(/```/g, "").trim();

  // 3) Try direct JSON.parse
  try {
    return { ok: true, json: JSON.parse(stripped) as T, extracted: stripped };
  } catch {}

  // 4) Fallback: first JSON object
  const chunk = extractFirstJsonObject(stripped);
  if (!chunk) return { ok: false, error: "No JSON object found in model output" };

  try {
    return { ok: true, json: JSON.parse(chunk) as T, extracted: chunk };
  } catch (e) {
    return { ok: false, error: `JSON parse failed: ${(e as Error).message}`, extracted: chunk };
  }
}

function looksEnglish(text: string) {
  const s = (text || "").toLowerCase();
  if (!s) return false;
  // ultra-light heuristic
  const enHits = [" the ", " and ", " with ", " without ", " patient ", " liver ", " spleen ", " kidney "].reduce(
    (acc, w) => acc + (s.includes(w) ? 1 : 0),
    0
  );
  const plHits = ["ą", "ę", "ł", "ń", "ś", "ż", "ź", " wątro", " śledz", " ner"].reduce(
    (acc, w) => acc + (s.includes(w) ? 1 : 0),
    0
  );
  // if clearly EN and not clearly PL
  return enHits >= 2 && plHits === 0;
}

function forceImpressionShape(x: any) {
  // No regression: keep the same keys; coerce types safely
  const arr = (v: any) => (Array.isArray(v) ? v.filter((s) => typeof s === "string").map((s) => s.trim()).filter(Boolean) : []);
  const strOrNull = (v: any) => (typeof v === "string" && v.trim() ? v.trim() : null);
  const consent = (v: any) => (v === "yes" || v === "no" ? v : null);

  return {
    doctorOverall: strOrNull(x?.doctorOverall),
    doctorKeyConcerns: arr(x?.doctorKeyConcerns),
    doctorPlan: arr(x?.doctorPlan),
    doctorRedFlags: arr(x?.doctorRedFlags),
    quotes: arr(x?.quotes).slice(0, 2),
    consentRecording: consent(x?.consentRecording),
  };
}

/* ================== LLM call ================== */

async function callLmStudio(baseUrl: string, model: string, messages: any[], maxTokens: number, timeoutMs: number) {
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
        // stop helps prevent post-json trailing junk
        stop: ["</json>"],
        messages,
      }),
    });

    const text = await res.text();
    const tookMs = Date.now() - t0;

    console.log("[extract-impression] lm status=", res.status, "tookMs=", tookMs);

    return { status: res.status, text, tookMs };
  } finally {
    clearTimeout(timeout);
  }
}

/* ================== API ================== */

export async function POST(req: NextRequest) {
  const all0 = Date.now();

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

    // Use tail (impression usually at the end)
    const t = tail(transcript, MAX_INPUT_CHARS);

    const system =
      "Jesteś asystentem lekarza weterynarii. " +
      "Odpowiadaj WYŁĄCZNIE po polsku. " +
      "Masz zwrócić TYLKO poprawny JSON w tagach <json>...</json>, bez markdown, bez komentarzy, bez dopisków.";

    const user =
      `Wyciągnij WYŁĄCZNIE informacje, które padły w transkrypcji. Nie wymyślaj.\n` +
      `Braki -> null lub [].\n` +
      `Maksymalnie 2 krótkie cytaty w "quotes".\n\n` +
      `Struktura JSON:\n` +
      `{\n` +
      `  "doctorOverall": string | null,\n` +
      `  "doctorKeyConcerns": string[],\n` +
      `  "doctorPlan": string[],\n` +
      `  "doctorRedFlags": string[],\n` +
      `  "quotes": string[],\n` +
      `  "consentRecording": "yes" | "no" | null\n` +
      `}\n\n` +
      `Zwróć w tagach:\n<json>{...}</json>\n\n` +
      `TRANSKRYPCJA (końcówka):\n"""${t}"""`;

    const messages = [
      { role: "system", content: system },
      { role: "user", content: user },
    ];

    const lm = await callLmStudio(baseUrl, model, messages, MAX_TOKENS, LM_TIMEOUT_MS);

    if (lm.status !== 200) {
      return NextResponse.json(
        {
          ok: false,
          error: "LM Studio error",
          lmStatus: lm.status,
          lmPreview: preview(lm.text, 800),
          tookMs: Date.now() - all0,
        },
        { status: 502 }
      );
    }

    let llmJson: any;
    try {
      llmJson = JSON.parse(lm.text);
    } catch {
      return NextResponse.json(
        {
          ok: false,
          error: "LM Studio returned non-JSON envelope",
          lmPreview: preview(lm.text, 800),
          tookMs: Date.now() - all0,
        },
        { status: 502 }
      );
    }

    const choice0 = llmJson?.choices?.[0] ?? {};
    const finishReason = choice0?.finish_reason ?? null;
    const msg = choice0?.message ?? {};

    let rawText = "";
    if (typeof msg.content === "string") rawText = msg.content;
    if (!rawText && Array.isArray(msg.content)) {
      rawText = msg.content
        .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
        .filter(Boolean)
        .join("\n")
        .trim();
    }

    // Parse attempt #1
    let parsed = safeParseModelJson<any>(rawText || "");
    let usedRetry = false;

    // Optional retry: parse fail OR language mismatch
    const rawLooksEn = looksEnglish(rawText || "");
    if ((!parsed.ok || rawLooksEn) && RETRY_ON_PARSE_FAIL === 1) {
      usedRetry = true;
      const t2 = tail(transcript, Math.min(RETRY_MAX_INPUT_CHARS, MAX_INPUT_CHARS));

      const user2 =
        `BŁĄD: poprzednia odpowiedź była niepoprawna (ucięty/nie-JSON albo zły język).\n` +
        `Zwróć ponownie WYŁĄCZNIE poprawny JSON w tagach <json>...</json>.\n` +
        `Tylko po polsku. Bez żadnych dopisków.\n` +
        `Jeśli nie ma danych -> null lub [].\n\n` +
        `TRANSKRYPCJA (końcówka):\n"""${t2}"""`;

      const lm2 = await callLmStudio(
        baseUrl,
        model,
        [
          { role: "system", content: system },
          { role: "user", content: user2 },
        ],
        RETRY_MAX_TOKENS,
        RETRY_TIMEOUT_MS
      );

      if (lm2.status !== 200) {
        return NextResponse.json(
          {
            ok: false,
            error: "LM Studio error (retry)",
            lmStatus: lm2.status,
            lmPreview: preview(lm2.text, 800),
            tookMs: Date.now() - all0,
          },
          { status: 502 }
        );
      }

      let llmJson2: any;
      try {
        llmJson2 = JSON.parse(lm2.text);
      } catch {
        return NextResponse.json(
          {
            ok: false,
            error: "LM Studio returned non-JSON envelope (retry)",
            lmPreview: preview(lm2.text, 800),
            tookMs: Date.now() - all0,
          },
          { status: 502 }
        );
      }

      const choiceR = llmJson2?.choices?.[0] ?? {};
      const finishReasonR = choiceR?.finish_reason ?? null;
      const msgR = choiceR?.message ?? {};

      let rawTextR = "";
      if (typeof msgR.content === "string") rawTextR = msgR.content;
      if (!rawTextR && Array.isArray(msgR.content)) {
        rawTextR = msgR.content
          .map((p: any) => (typeof p?.text === "string" ? p.text : ""))
          .filter(Boolean)
          .join("\n")
          .trim();
      }

      parsed = safeParseModelJson<any>(rawTextR || "");
      // override finishReason for diagnostics
      (parsed as any)._finishReason = finishReasonR;
      rawText = rawTextR || rawText;
      // if still EN, treat as fail
      if (looksEnglish(rawTextR || "")) {
        parsed = { ok: false, error: "Model answered in English (retry)", extracted: preview(rawTextR, 800) } as any;
      } else {
        // keep finish reason if we need it
        (parsed as any)._finishReason = finishReasonR;
      }

      // attach finish reasons for output on failure
      (parsed as any)._finishReason0 = finishReason;
      (parsed as any)._finishReasonR = finishReasonR;
    }

    if (!parsed.ok) {
      return NextResponse.json(
        {
          ok: false,
          error: "Model returned truncated/invalid JSON",
          details: parsed.error,
          finishReason,
          usedRetry,
          rawPreview: preview(rawText || "", 900),
          extractedPreview: parsed.extracted ? preview(parsed.extracted, 900) : null,
          tookMs: Date.now() - all0,
        },
        { status: 502 }
      );
    }

    // Safety: coerce schema (no regression)
    const shaped = forceImpressionShape(parsed.json);

    const impression = {
      ...shaped,
      impressionMeta: {
        at: FieldValue.serverTimestamp(),
        baseUrl,
        modelUsed: model,
        version: PROMPT_VERSION,
        tookMs: Date.now() - all0,
        inputChars: t.length,
        maxTokens: MAX_TOKENS,
        timeoutMs: LM_TIMEOUT_MS,
        finishReason,
        usedRetry,
      },
    };

    await examRef.update({ impression });

    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      impression,
      tookMs: Date.now() - all0,
    });
  } catch (e: any) {
    const msg = e?.name === "AbortError" ? "LM timeout" : e?.message || "Unknown error";
    return NextResponse.json({ ok: false, error: msg, tookMs: Date.now() - all0 }, { status: 500 });
  }
}

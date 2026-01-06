// app/api/exams/analyze/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION = "analyze-v12-json_schema-telemetry-truncation-guard-cjk-filter";

const MAX_LLM_INPUT_CHARS = Number(process.env.ANALYZE_MAX_INPUT_CHARS || 14000);

// ================= Error helpers =================

function safeErrorMessage(err: unknown) {
  if (typeof err === "string") return err;
  if (err && typeof err === "object") {
    const anyErr = err as any;
    if (anyErr?.message) return String(anyErr.message);
    if (anyErr?.error) return String(anyErr.error);
  }
  try {
    return String(err);
  } catch {
    return "Unknown error";
  }
}

// ================= Language / garbage guards =================

// CJK blocks (Chinese/Japanese/Korean) + common punctuation blocks used in CJK
const CJK_RE = /[\u3040-\u30FF\u3400-\u4DBF\u4E00-\u9FFF\uF900-\uFAFF]/g;

function stripCjk(s: string) {
  return s.replace(CJK_RE, "");
}

function hasCjk(s: string) {
  return CJK_RE.test(s);
}

function sanitizeStringPolishOnly(v: any) {
  if (v == null) return { value: null, changed: false, hadCjk: false };
  if (typeof v !== "string") return { value: v, changed: false, hadCjk: false };

  const had = hasCjk(v);
  if (!had) return { value: v, changed: false, hadCjk: false };

  const stripped = stripCjk(v);
  const cleaned = stripped.replace(/\s+/g, " ").trim();

  // jeśli po usunięciu CJK nic sensownego nie zostało
  if (!cleaned || cleaned === "—") return { value: null, changed: true, hadCjk: true };

  return { value: cleaned, changed: true, hadCjk: true };
}

function sanitizeStringArrayPolishOnly(arr: any) {
  if (!Array.isArray(arr)) return { value: null, changed: false, hadCjk: false };

  let changed = false;
  let hadCjk = false;

  const out = arr
    .filter((x) => typeof x === "string")
    .map((x) => {
      const res = sanitizeStringPolishOnly(x);
      if (res.changed) changed = true;
      if (res.hadCjk) hadCjk = true;
      return typeof res.value === "string" ? res.value : null;
    })
    .filter((x) => typeof x === "string" && x.trim().length > 0);

  const uniq = Array.from(new Set(out));
  return { value: uniq.length ? uniq : null, changed, hadCjk };
}

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

// ================= LM Studio =================

function getLmConfig() {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.LMSTUDIO_MODEL || "qwen2.5-14b-instruct-1m";
  const apiKey = process.env.LMSTUDIO_API_KEY || "lm-studio";
  return { baseUrl, model, apiKey };
}

function getAnalysisJsonSchema() {
  const nullableString = { anyOf: [{ type: "string" }, { type: "null" }] };
  const nullableStringArray = {
    anyOf: [{ type: "array", items: { type: "string" } }, { type: "null" }],
  };

  return {
    name: "vetvoice_analysis",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        sections: {
          type: "object",
          additionalProperties: false,
          properties: {
            reason: nullableString,
            findings: nullableString,
            conclusions: nullableString,
            recommendations: nullableString,
          },
          required: ["reason", "findings", "conclusions", "recommendations"],
        },
        entities: {
          type: "object",
          additionalProperties: false,
          properties: {
            patientName: nullableString,
            organsMentioned: nullableStringArray,
            problemsMentioned: nullableStringArray,
          },
          required: ["patientName", "organsMentioned", "problemsMentioned"],
        },
        keyFindings: nullableStringArray,
        evidence: {
          anyOf: [
            {
              type: "array",
              items: {
                type: "object",
                additionalProperties: false,
                properties: {
                  claim: { type: "string" },
                  quote: { type: "string" },
                },
                required: ["claim", "quote"],
              },
            },
            { type: "null" },
          ],
        },
      },
      required: ["sections", "entities", "keyFindings", "evidence"],
    },
  };
}

async function callLmStudio(args: {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  responseFormat?: "json_schema" | "text";
}) {
  const { baseUrl, model, apiKey } = getLmConfig();
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const body: any = {
    model,
    temperature: 0,
    max_tokens: args.maxTokens ?? 5000,
    messages: [
      { role: "system", content: args.systemPrompt },
      { role: "user", content: args.userContent },
    ],
  };

  if (args.responseFormat === "json_schema") {
    body.response_format = {
      type: "json_schema",
      json_schema: getAnalysisJsonSchema(),
    };
  } else if (args.responseFormat === "text") {
    body.response_format = { type: "text" };
  }

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify(body),
  });

  const rawText = await res.text();

  if (!res.ok) {
    throw new Error(`LM Studio error (${res.status}): ${rawText.slice(0, 2000)}`);
  }

  let data: any;
  try {
    data = JSON.parse(rawText);
  } catch (e: any) {
    throw new Error(
      `LM Studio returned non-JSON response: ${String(e?.message || e)}. Preview: ${rawText.slice(0, 500)}`
    );
  }

  const content = data?.choices?.[0]?.message?.content;
  if (!content || typeof content !== "string") throw new Error("LM Studio returned empty content");

  const finishReason = data?.choices?.[0]?.finish_reason ?? null;
  const usage = data?.usage ?? null;

  return {
    content,
    modelUsed: model,
    baseUrl,
    finishReason,
    usage,
  };
}

// ================= Text helpers =================

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

  return s.replace(/\s+/g, " ").trim();
}

function oneLine(input: any) {
  if (typeof input !== "string") return input;
  return cleanMedicalPolish(input.replace(/\r?\n|\r/g, " "));
}

function ensureNullIfEmpty(v: any) {
  if (v == null) return null;
  if (typeof v !== "string") return v;
  const t = oneLine(v).trim();
  if (!t || t === "—" || t.toLowerCase() === "brak" || t.toLowerCase() === "nie dotyczy") return null;
  return t;
}

function truncateForLlm(text: string) {
  const t = text || "";
  if (t.length <= MAX_LLM_INPUT_CHARS) {
    return { text: t, truncated: false, originalChars: t.length, sentChars: t.length };
  }
  const head = t.slice(0, Math.floor(MAX_LLM_INPUT_CHARS * 0.7));
  const tail = t.slice(-Math.floor(MAX_LLM_INPUT_CHARS * 0.3));
  const merged = `${head}\n\n[... UCIĘTO ŚRODEK TRANSKRYPCJI (dla limitu kontekstu) ...]\n\n${tail}`;
  return { text: merged, truncated: true, originalChars: t.length, sentChars: merged.length };
}

function seemsTruncatedByFinishReason(finishReason: any) {
  if (!finishReason) return false;
  if (typeof finishReason !== "string") return false;
  return finishReason !== "stop";
}

// ================= Quality =================

type TranscriptQuality = {
  score?: number;
  flags?: string[];
};

function getQualityBand(score: number | null) {
  if (score == null) return { band: "unknown" as const, note: null as string | null };
  if (score >= 75) return { band: "good" as const, note: null as string | null };
  if (score >= 60)
    return {
      band: "medium" as const,
      note: "Słabsza jakość transkrypcji — analiza może być niepełna, prosimy zweryfikować.",
    };
  return {
    band: "low" as const,
    note: "Słaba jakość transkrypcji — analiza może być istotnie niepełna.",
  };
}

// ================= Prompt =================

function buildSystemPrompt(examType: string, score: number | null, flags: string[] | null) {
  const q = score == null ? "unknown" : String(score);
  const f = flags?.length ? flags.join(", ") : "none";

  const qualityRules =
    score != null && score < 75
      ? `
UWAGA: jakość transkrypcji jest NISKA/ŚREDNIA (score=${q}, flags=${f}).
- Bądź BARDZO KONSERWATYWNY.
- Jeśli brak jednoznacznej informacji -> null.
- NIE domyślaj się, NIE wnioskuj.
`
      : `Informacja: jakość transkrypcji wygląda na dobrą (score=${q}, flags=${f}).`;

  return `
Jesteś asystentem lekarza weterynarii.
Wypełnij pola WYŁĄCZNIE na podstawie transkrypcji.
Nie wymyślaj faktów. Jeśli brak danych -> null.
Wartości string w JEDNEJ LINII.
Odpowiedzi ZAWSZE po polsku.
Nie używaj żadnego innego języka.
Zwróć WYŁĄCZNIE JSON zgodny ze schematem (bez markdown i komentarzy).

${qualityRules}

Typ badania: ${examType}
`.trim();
}

function buildRetrySystemPrompt(examType: string) {
  return `
Popraw poprzednią odpowiedź: musisz zwrócić kompletne dane zgodne ze SCHEMATEM.
Zwróć pełny obiekt, nie urywaj odpowiedzi.
Odpowiedzi ZAWSZE po polsku. Nie używaj żadnego innego języka.
Bez markdown, bez komentarzy.
Typ badania: ${examType}
`.trim();
}

// ================= Parse / Normalize =================

function normalizeAnalysis(parsed: any) {
  const sections = parsed?.sections || {};
  const entities = parsed?.entities || {};

  const normArr = (x: any) => {
    if (!Array.isArray(x)) return null;
    const cleaned = x
      .filter((v) => typeof v === "string")
      .map((v) => oneLine(v).trim())
      .filter(Boolean);
    const uniq = Array.from(new Set(cleaned));
    return uniq.length ? uniq : null;
  };

  const normEvidence = (x: any) => {
    if (!Array.isArray(x)) return null;
    const cleaned = x
      .map((e) => ({
        claim: ensureNullIfEmpty(e?.claim),
        quote: ensureNullIfEmpty(e?.quote),
      }))
      .filter((e) => e.claim && e.quote)
      .slice(0, 6);

    return cleaned.length ? cleaned : null;
  };

  return {
    sections: {
      reason: ensureNullIfEmpty(sections?.reason),
      findings: ensureNullIfEmpty(sections?.findings),
      conclusions: ensureNullIfEmpty(sections?.conclusions),
      recommendations: ensureNullIfEmpty(sections?.recommendations),
    },
    entities: {
      patientName: ensureNullIfEmpty(entities?.patientName),
      organsMentioned: normArr(entities?.organsMentioned),
      problemsMentioned: normArr(entities?.problemsMentioned),
    },
    keyFindings: normArr(parsed?.keyFindings),
    evidence: normEvidence(parsed?.evidence),
  };
}

function sanitizeAnalysisPolishOnly(analysis: any) {
  let changed = false;
  let hadCjk = false;

  const s1 = sanitizeStringPolishOnly(analysis?.sections?.reason);
  const s2 = sanitizeStringPolishOnly(analysis?.sections?.findings);
  const s3 = sanitizeStringPolishOnly(analysis?.sections?.conclusions);
  const s4 = sanitizeStringPolishOnly(analysis?.sections?.recommendations);

  const pn = sanitizeStringPolishOnly(analysis?.entities?.patientName);
  const om = sanitizeStringArrayPolishOnly(analysis?.entities?.organsMentioned);
  const pm = sanitizeStringArrayPolishOnly(analysis?.entities?.problemsMentioned);
  const kf = sanitizeStringArrayPolishOnly(analysis?.keyFindings);

  // evidence: claim/quote
  let evidenceChanged = false;
  let evidenceHadCjk = false;
  let evidenceOut: any = null;

  if (Array.isArray(analysis?.evidence)) {
    const out = analysis.evidence
      .map((e: any) => {
        const c = sanitizeStringPolishOnly(e?.claim);
        const q = sanitizeStringPolishOnly(e?.quote);
        if (c.changed || q.changed) evidenceChanged = true;
        if (c.hadCjk || q.hadCjk) evidenceHadCjk = true;
        return { claim: c.value, quote: q.value };
      })
      .filter((e: any) => typeof e.claim === "string" && e.claim && typeof e.quote === "string" && e.quote)
      .slice(0, 6);

    evidenceOut = out.length ? out : null;
  }

  const all = [s1, s2, s3, s4, pn, om, pm, kf];
  if (all.some((x) => x.changed) || evidenceChanged) changed = true;
  if (all.some((x) => x.hadCjk) || evidenceHadCjk) hadCjk = true;

  const sanitized = {
    sections: {
      reason: s1.value,
      findings: s2.value,
      conclusions: s3.value,
      recommendations: s4.value,
    },
    entities: {
      patientName: pn.value,
      organsMentioned: om.value,
      problemsMentioned: pm.value,
    },
    keyFindings: kf.value,
    evidence: evidenceOut,
  };

  return { sanitized, changed, hadCjk };
}

function isAllSectionsNull(analysis: any) {
  const s = analysis?.sections || {};
  return !s.reason && !s.findings && !s.conclusions && !s.recommendations;
}

function minimalFallbackAnalysis(transcript: string, score: number | null) {
  const note =
    typeof score === "number" && score < 60
      ? "Materiał niewystarczający do jednoznacznej analizy (niska jakość transkrypcji) — proszę zweryfikować opis badania."
      : "Materiał niewystarczający do jednoznacznej analizy — proszę zweryfikować opis badania.";

  return {
    sections: {
      reason: null,
      findings: null,
      conclusions: note,
      recommendations: "W razie potrzeby powtórzyć nagranie lub uzupełnić opis badania w dokumentacji.",
    },
    entities: {
      patientName: null,
      organsMentioned: null,
      problemsMentioned: null,
    },
    keyFindings: null,
    evidence: null,
  };
}

// ================= Endpoint =================

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

    const transcript: string | undefined = exam?.transcriptNormalized || exam?.transcript;
    if (!transcript || !String(transcript).trim()) {
      return NextResponse.json({ error: "Missing exam.transcript — run /api/exams/transcribe first" }, { status: 400 });
    }

    const examType = (exam?.type || "Badanie").toString();

    const tq = (exam?.transcriptQuality || {}) as TranscriptQuality;
    const score = typeof tq?.score === "number" ? tq.score : null;
    const flags = Array.isArray(tq?.flags) ? tq.flags : null;
    const band = getQualityBand(score);

    const cleanedTranscript = cleanMedicalPolish(String(transcript));
    const lim = truncateForLlm(cleanedTranscript);

    const systemPrompt = buildSystemPrompt(examType, score, flags);

    const started = Date.now();

    // 1) Primary call (json_schema)
    const lm1 = await callLmStudio({
      systemPrompt,
      userContent: lim.text,
      maxTokens: 4500,
      responseFormat: "json_schema",
    });

    const raw1 = String(lm1.content || "");
    let parsed: any = null;
    let usedRetry = false;

    const truncatedOut1 = seemsTruncatedByFinishReason(lm1.finishReason);

    try {
      parsed = JSON.parse(raw1);
    } catch {
      usedRetry = true;

      const lm2 = await callLmStudio({
        systemPrompt: buildRetrySystemPrompt(examType),
        userContent: lim.text,
        maxTokens: 3000,
        responseFormat: "json_schema",
      });

      const raw2 = String(lm2.content || "");
      const truncatedOut2 = seemsTruncatedByFinishReason(lm2.finishReason);

      try {
        parsed = JSON.parse(raw2);
      } catch (e2: any) {
        const tookMs = Date.now() - started;

        await examRef.update({
          analysisError: {
            at: new Date(),
            version: PROMPT_VERSION,
            engine: "lmstudio",
            baseUrl: lm1.baseUrl,
            modelUsed: lm1.modelUsed,
            tookMs,
            transcriptQuality: { score, flags, band: band.band, note: band.note },
            usedRetry,
            parseError: String(e2?.message || e2),
            rawModelOutputPreview: raw1.slice(0, 4000),
            rawModelOutputRetryPreview: raw2.slice(0, 4000),
            lmTelemetry: {
              primary: { finishReason: lm1.finishReason, usage: lm1.usage, truncatedOut: truncatedOut1 },
              retry: { finishReason: lm2.finishReason, usage: lm2.usage, truncatedOut: truncatedOut2 },
            },
            llmInput: {
              truncatedIn: lim.truncated,
              originalChars: lim.originalChars,
              sentChars: lim.sentChars,
              maxChars: MAX_LLM_INPUT_CHARS,
            },
          },
          updatedAt: new Date(),
        });

        const fallback = minimalFallbackAnalysis(String(transcript), score);

        await examRef.update({
          analysis: fallback,
          analyzedAt: new Date(),
          analysisMeta: {
            version: PROMPT_VERSION,
            engine: "lmstudio",
            baseUrl: lm1.baseUrl,
            modelUsed: lm1.modelUsed,
            tookMs,
            transcriptQuality: { score, flags, band: band.band, note: band.note },
            fallbackUsed: true,
            usedRetry,
            failedJsonParse: true,
            responseFormat: "json_schema",
            truncated: true,
            llmInput: {
              truncatedIn: lim.truncated,
              originalChars: lim.originalChars,
              sentChars: lim.sentChars,
              maxChars: MAX_LLM_INPUT_CHARS,
            },
          },
          analysisMissing: {
            reason: !fallback.sections.reason,
            findings: !fallback.sections.findings,
            conclusions: !fallback.sections.conclusions,
            recommendations: !fallback.sections.recommendations,
          },
          updatedAt: new Date(),
        });

        return NextResponse.json(
          { ok: true, warning: "LLM JSON parse failed; stored fallback analysis", docPath: examRef.path, fallbackUsed: true, usedRetry },
          { status: 200 }
        );
      }

      // retry succeeded
      const tookMs = Date.now() - started;

      let analysis = normalizeAnalysis(parsed);

      // NEW: filtr CJK
      const sres = sanitizeAnalysisPolishOnly(analysis);
      analysis = sres.sanitized;

      let fallbackUsed = false;
      const allNull = isAllSectionsNull(analysis);
      if (allNull) {
        analysis = minimalFallbackAnalysis(String(transcript), score);
        fallbackUsed = true;
      }

      const truncatedFinal = lim.truncated || truncatedOut1 || truncatedOut2 || allNull;

      await examRef.update({
        analysis,
        analyzedAt: new Date(),
        analysisMeta: {
          version: PROMPT_VERSION,
          engine: "lmstudio",
          baseUrl: lm1.baseUrl,
          modelUsed: lm1.modelUsed,
          tookMs,
          transcriptQuality: { score, flags, band: band.band, note: band.note },
          fallbackUsed,
          usedRetry,
          responseFormat: "json_schema",
          truncated: truncatedFinal,
          sanitize: { cjkFiltered: sres.hadCjk, changed: sres.changed },
          llmInput: {
            truncatedIn: lim.truncated,
            originalChars: lim.originalChars,
            sentChars: lim.sentChars,
            maxChars: MAX_LLM_INPUT_CHARS,
          },
        },
        analysisMissing: {
          reason: !analysis.sections.reason,
          findings: !analysis.sections.findings,
          conclusions: !analysis.sections.conclusions,
          recommendations: !analysis.sections.recommendations,
        },
        updatedAt: new Date(),
      });

      return NextResponse.json({ ok: true, docPath: examRef.path, analysis, tookMs, fallbackUsed, usedRetry });
    }

    // primary parse succeeded
    const tookMs = Date.now() - started;

    let analysis = normalizeAnalysis(parsed);

    // NEW: filtr CJK
    const sres = sanitizeAnalysisPolishOnly(analysis);
    analysis = sres.sanitized;

    let fallbackUsed = false;
    const allNull = isAllSectionsNull(analysis);
    if (allNull) {
      analysis = minimalFallbackAnalysis(String(transcript), score);
      fallbackUsed = true;
    }

    const truncatedFinal = lim.truncated || truncatedOut1 || allNull;

    await examRef.update({
      analysis,
      analyzedAt: new Date(),
      analysisMeta: {
        version: PROMPT_VERSION,
        engine: "lmstudio",
        baseUrl: lm1.baseUrl,
        modelUsed: lm1.modelUsed,
        tookMs,
        transcriptQuality: { score, flags, band: band.band, note: band.note },
        fallbackUsed,
        usedRetry,
        responseFormat: "json_schema",
        truncated: truncatedFinal,
        sanitize: { cjkFiltered: sres.hadCjk, changed: sres.changed },
        llmTelemetry: {
          primary: { finishReason: lm1.finishReason, usage: lm1.usage, truncatedOut: truncatedOut1 },
        },
        llmInput: {
          truncatedIn: lim.truncated,
          originalChars: lim.originalChars,
          sentChars: lim.sentChars,
          maxChars: MAX_LLM_INPUT_CHARS,
        },
      },
      analysisMissing: {
        reason: !analysis.sections.reason,
        findings: !analysis.sections.findings,
        conclusions: !analysis.sections.conclusions,
        recommendations: !analysis.sections.recommendations,
      },
      updatedAt: new Date(),
    });

    return NextResponse.json({ ok: true, docPath: examRef.path, analysis, tookMs, fallbackUsed, usedRetry });
  } catch (err: any) {
    const message = safeErrorMessage(err);
    console.error("ANALYZE ERROR:", message);
    return NextResponse.json({ ok: false, error: message }, { status: 500 });
  }
}

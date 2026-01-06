// app/api/exams/normalize-transcript/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const NORMALIZE_VERSION = "normalize-v2.3-uncertain-marking";

// ================= Firebase =================

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app =
    getApps().length > 0
      ? getApps()[0]
      : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

// ================= LM Studio =================

function getLmConfig() {
  return {
    baseUrl: process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434",
    model: process.env.LMSTUDIO_MODEL || "qwen2.5-14b-instruct-1m",
    apiKey: process.env.LMSTUDIO_API_KEY || "lm-studio",
  };
}

function getNormalizeJsonSchema() {
  return {
    name: "vetvoice_transcript_normalize",
    strict: true,
    schema: {
      type: "object",
      additionalProperties: false,
      properties: {
        text: { type: "string" },
        replacements: {
          type: "array",
          items: {
            type: "object",
            additionalProperties: false,
            properties: {
              from: { type: "string" },
              to: { type: "string" },
              confidence: { type: "number" },
              reason: { anyOf: [{ type: "string" }, { type: "null" }] },
            },
            required: ["from", "to", "confidence", "reason"],
          },
        },
      },
      required: ["text", "replacements"],
    },
  };
}

async function callLmStudioNormalize(prompt: string, transcript: string) {
  const { baseUrl, model, apiKey } = getLmConfig();
  const url = `${baseUrl.replace(/\/$/, "")}/v1/chat/completions`;

  const res = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0,
      max_tokens: 2200,
      messages: [
        { role: "system", content: prompt },
        { role: "user", content: transcript },
      ],
      response_format: {
        type: "json_schema",
        json_schema: getNormalizeJsonSchema(),
      },
    }),
  });

  if (!res.ok) {
    const t = await res.text();
    throw new Error(`LM Studio error (${res.status}): ${t.slice(0, 2000)}`);
  }

  const json = await res.json();
  const content = json?.choices?.[0]?.message?.content;
  if (!content) throw new Error("Empty model response");

  return content;
}

// ================= Safety helpers =================

function oneLine(s: string) {
  return (s || "").replace(/\s+/g, " ").trim();
}

function isSafeReplacement(from: string, to: string) {
  if (!from || !to) return false;
  if (from === to) return false;
  if (/\d/.test(from) || /\d/.test(to)) return false;

  const ratio =
    Math.max(from.length, to.length) /
    Math.max(1, Math.min(from.length, to.length));
  if (ratio > 1.35) return false;

  return /^[\p{L}\s-]+$/u.test(from) && /^[\p{L}\s-]+$/u.test(to);
}

// ================= Core logic =================

function applyAutomaticFixes(
  text: string,
  reps: Array<{ from: string; to: string; confidence: number }>
) {
  let out = text;

  for (const r of reps) {
    if (r.confidence < 0.8) continue;
    const from = oneLine(r.from);
    const to = oneLine(r.to);

    if (isSafeReplacement(from, to) && out.includes(from)) {
      out = out.split(from).join(to);
    }
  }

  return out;
}

function markUncertainTerms(
  text: string,
  reps: Array<{ from: string; to: string; confidence: number }>
) {
  let out = text;

  for (const r of reps) {
    if (r.confidence < 0.55 || r.confidence >= 0.8) continue;

    const from = oneLine(r.from);
    const to = oneLine(r.to);
    if (!from || !to) continue;

    const marker = `**${from} → ${to}**`;
    if (out.includes(from) && !out.includes(marker)) {
      out = out.split(from).join(marker);
    }
  }

  return out;
}

function buildSystemPrompt() {
  return `
Jesteś korektorem transkrypcji badania weterynaryjnego (PL).

ZADANIE:
- popraw WYŁĄCZNIE literówki, brak polskich znaków, błędne spacje
- NIE zmieniaj znaczenia zdań
- NIE dodawaj i NIE usuwaj informacji
- NIE zmieniaj liczb, jednostek ani wartości
- nazwy narządów tylko popraw ortograficznie

Zwróć JSON:
{
  "text": "...",
  "replacements": [
    { "from": "...", "to": "...", "confidence": 0-1, "reason": "..." }
  ]
}

Wpisuj tylko poprawki, gdzie masz realną pewność.
`.trim();
}

// ================= Endpoint =================

export async function POST(req: NextRequest) {
  try {
    const { docPath } = await req.json();
    if (!docPath) {
      return NextResponse.json({ error: "Missing docPath" }, { status: 400 });
    }

    const db = await getAdminDb();
    let ref = db.doc(docPath);
    let snap = await ref.get();

    // fallback clinics -> patients
    if (!snap.exists) {
      const m = docPath.match(/^clinics\/[^/]+\/patients\/([^/]+)\/exams\/([^/]+)$/);
      if (m) {
        ref = db.doc(`patients/${m[1]}/exams/${m[2]}`);
        snap = await ref.get();
      }
    }

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found", docPath }, { status: 404 });
    }

    const exam = snap.data() as any;
    const transcript = exam?.transcript;
    if (!transcript) {
      return NextResponse.json({ error: "Missing transcript" }, { status: 400 });
    }

    const started = Date.now();
    const raw = await callLmStudioNormalize(buildSystemPrompt(), transcript);
    const parsed = JSON.parse(raw);

    const replacements = Array.isArray(parsed.replacements)
      ? parsed.replacements
      : [];

    const autoFixed = applyAutomaticFixes(transcript, replacements);
    const finalText = markUncertainTerms(autoFixed, replacements);

    await ref.update({
      transcriptNormalized: finalText,
      transcriptNormalizeMeta: {
        version: NORMALIZE_VERSION,
        tookMs: Date.now() - started,
        replacements,
        normalizedAt: new Date(),
      },
      updatedAt: new Date(),
    });

    return NextResponse.json({
      ok: true,
      docPath: ref.path,
      replacementsCount: replacements.length,
      preview: finalText.slice(0, 500),
    });
  } catch (e: any) {
    console.error("NORMALIZE ERROR:", e);
    return NextResponse.json(
      { error: e?.message || "Unknown error" },
      { status: 500 }
    );
  }
}

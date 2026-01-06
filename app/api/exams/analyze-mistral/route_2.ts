export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

/**
 * TESTOWY ANALYZE – MISTRAL
 * Endpoint: /api/exams/analyze-mistral
 *
 * Cel:
 * - porównanie jakości ekstrakcji (Qwen vs Mistral)
 * - bez ruszania produkcyjnego /api/exams/analyze
 *
 * Różnice:
 * - model (LM Studio API identifier)
 * - promptVersion
 */

const PROMPT_VERSION = "analyze-v7-mistral-test";

// ---------- CONFIG ----------
function getLmConfig() {
  return {
    baseUrl: process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434",
    // Z LM Studio: "This model’s API identifier"
    model: "mistral-small-3.2-24b-instruct-2506-mlx",
  };
}

// ---------- FIREBASE ----------
async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) {
    throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");
  }

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app = getApps().length
    ? getApps()[0]
    : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

// ---------- TEXT ----------
function cleanMedicalPolish(s: string) {
  return s
    .replace(/\bnetki\b/gi, "nerki")
    .replace(/\bbrusz(n[aeyio]|nej|nego)\b/gi, "brzusz$1")
    .replace(/\bprzeroźnion([aąeęyio])\b/gi, "przerośnięt$1")
    .replace(/\bkęst([eyąa])\b/gi, "gęst$1")
    .replace(/\s+/g, " ")
    .trim();
}

function oneLine(s: string) {
  return cleanMedicalPolish(s.replace(/\r?\n|\r/g, " "));
}

// ---------- PROMPT ----------
function buildSystemPrompt(examType: string) {
  return `
Jesteś asystentem lekarza weterynarii.
Twoim zadaniem jest WYŁĄCZNIE ekstrakcja informacji medycznych z transkrypcji badania.

ZASADY:
- Zwróć WYŁĄCZNIE poprawny JSON.
- Nie dodawaj komentarzy, markdown ani tekstu opisowego.
- Nie wymyślaj informacji, których nie ma w transkrypcji.
- Ignoruj wypowiedzi organizacyjne i uspokajające.
- Popraw oczywiste literówki językowe.

Sekcje:
- reason
- findings (opis narządami)
- conclusions
- recommendations (TYLKO jeśli lekarz je wypowiada)
- keyFindings (3–8 punktów)

Typ badania: ${examType}

JSON:
{
  "sections": {
    "reason": string | null,
    "findings": string | null,
    "conclusions": string | null,
    "recommendations": string | null
  },
  "keyFindings": string[] | null
}
`.trim();
}

// ---------- HELPERS ----------
function safeJsonParse(text: string) {
  const t = (text || "").trim();
  const first = t.indexOf("{");
  const last = t.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) {
    throw new Error("Model did not return a JSON object.");
  }
  return JSON.parse(t.slice(first, last + 1));
}

// ---------- ORGAN LOGIC ----------
function inferOrganFindings(text: string) {
  const t = (text || "").toLowerCase();
  const ab = (r: RegExp) => r.test(t);

  return {
    liver: ab(/wątro.*(zmian|powiększ|niejednorod)/) ? "abnormal" : "normal",
    spleen: ab(/śledzion.*(zmian|guz|powiększ)/) ? "abnormal" : "normal",
    kidneys: ab(/nerk.*(zastój|kamień|wodonercz)/) ? "abnormal" : "normal",
    bladder: ab(/pęcherz.*(pogrub|zapal|piasek|kamień)/) ? "abnormal" : "normal",
    prostate: ab(/prostat.*(przerost|powiększ|torbiel)/) ? "abnormal" : "normal",
  };
}

function inferSummaryType(findings?: string | null, conclusions?: string | null) {
  const t = `${findings || ""} ${conclusions || ""}`.toLowerCase();
  return /(pogrub|zapal|kamień|piasek|przerost|guz|torbiel)/.test(t)
    ? "abnormal"
    : "normal";
}

// ---------- ROUTE ----------
export async function POST(req: NextRequest) {
  const started = Date.now();

  try {
    const { patientId, examId, clinicId } = (await req.json()) as {
      patientId?: string;
      examId?: string;
      clinicId?: string;
    };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const db = await getAdminDb();

    // Dual-path lookup (zgodnie z resztą projektu)
    const refA = db.doc(`patients/${patientId}/exams/${examId}`);
    const refB = clinicId ? db.doc(`clinics/${clinicId}/patients/${patientId}/exams/${examId}`) : null;

    let ref = refA;
    let snap = await refA.get();

    if (!snap.exists && refB) {
      ref = refB;
      snap = await refB.get();
    }

    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found", tried: { pathA: refA.path, pathB: refB?.path ?? null } }, { status: 404 });
    }

    const exam = snap.data() as any;
    const transcript: string | undefined = exam?.transcript;
    const examType: string = (exam?.type || "Badanie").toString();

    if (!transcript || !transcript.trim()) {
      return NextResponse.json({ error: "No transcript in exam" }, { status: 400 });
    }

    const { baseUrl, model } = getLmConfig();
    const system = buildSystemPrompt(examType);

    // --- LM Studio call ---
    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        max_tokens: 800,
        messages: [
          { role: "system", content: system },
          { role: "user", content: transcript },
        ],
      }),
    });

    const raw = await res.text();

    if (!res.ok) {
      return NextResponse.json(
        { error: "LM Studio error", status: res.status, details: raw.slice(0, 2000), model, baseUrl },
        { status: 502 }
      );
    }

    let json: any;
    try {
      json = JSON.parse(raw);
    } catch {
      return NextResponse.json(
        { error: "LM Studio returned invalid JSON envelope", details: raw.slice(0, 2000), model, baseUrl },
        { status: 502 }
      );
    }

    const content = json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      return NextResponse.json(
        { error: "LM Studio returned empty content", details: raw.slice(0, 2000), model, baseUrl },
        { status: 502 }
      );
    }

    let parsed: any;
    try {
      parsed = safeJsonParse(content);
    } catch (e: any) {
      return NextResponse.json(
        { error: "Model did not return valid JSON object", details: e?.message, rawPreview: content.slice(0, 2000), model, baseUrl },
        { status: 502 }
      );
    }

    const sections = parsed?.sections ?? {};
    const findings = typeof sections.findings === "string" ? oneLine(sections.findings) : null;
    const conclusions = typeof sections.conclusions === "string" ? oneLine(sections.conclusions) : null;

    const analysis = {
      sections: {
        reason: typeof sections.reason === "string" ? oneLine(sections.reason) : null,
        findings,
        conclusions,
        recommendations: typeof sections.recommendations === "string" ? oneLine(sections.recommendations) : null,
      },
      keyFindings: Array.isArray(parsed?.keyFindings)
        ? parsed.keyFindings
            .filter((x: any) => typeof x === "string" && x.trim())
            .map((x: string) => oneLine(x))
            .slice(0, 12)
        : null,
      organFindings: inferOrganFindings(findings || ""),
      summaryType: inferSummaryType(findings, conclusions),
    };

    const latencyMs = Date.now() - started;

    await ref.update({
      analysis,
      analysisMeta: {
        engine: "lmstudio",
        model,
        baseUrl,
        promptVersion: PROMPT_VERSION,
        latencyMs,
        analyzedAt: new Date(),
      },
    });

    // Zwracamy pełny payload – żeby UI mogło od razu z tego skorzystać
    return NextResponse.json({
      ok: true,
      analysis,
      meta: {
        engine: "lmstudio",
        model,
        baseUrl,
        promptVersion: PROMPT_VERSION,
        latencyMs,
      },
      docPath: ref.path,
    });
  } catch (e: any) {
    console.error("ANALYZE MISTRAL ERROR:", e);
    return NextResponse.json({ error: e?.message || "Unknown error" }, { status: 500 });
  }
}

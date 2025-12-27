export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION = "analyze-v7-scalable";

// ---------- CONFIG ----------
function getLmConfig() {
  return {
    baseUrl: process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434",
    model: process.env.LMSTUDIO_MODEL || "qwen2.5-14b-instruct",
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

function oneLine(v: unknown): string | null {
  if (typeof v !== "string") return null;
  return cleanMedicalPolish(v.replace(/\r?\n|\r/g, " ")).trim() || null;
}

// ---------- PROMPT ----------
function buildSystemPrompt(examType: string) {
  return `
Jesteś asystentem lekarza weterynarii.
Masz WYŁĄCZNIE wyekstrahować informacje medyczne z transkrypcji.

ZASADY:
- Zwróć WYŁĄCZNIE poprawny JSON.
- Bez komentarzy i markdown.
- Nie wymyślaj faktów.
- Ignoruj uspokajanie pacjenta i kwestie organizacyjne.
- Popraw oczywiste literówki.

Sekcje:
- reason
- findings (narządami)
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
  const first = text.indexOf("{");
  const last = text.lastIndexOf("}");
  return JSON.parse(text.slice(first, last + 1));
}

// ---------- ORGAN LOGIC ----------
function inferOrganFindings(text: string) {
  const t = text.toLowerCase();
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
  try {
    const { patientId, examId, clinicId } = await req.json();
    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing IDs" }, { status: 400 });
    }

    const db = await getAdminDb();

    const refA = db.doc(`patients/${patientId}/exams/${examId}`);
    const refB = clinicId
      ? db.doc(`clinics/${clinicId}/patients/${patientId}/exams/${examId}`)
      : null;

    let ref = refA;
    let snap = await refA.get();
    if (!snap.exists && refB) {
      ref = refB;
      snap = await refB.get();
    }
    if (!snap.exists) {
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data()!;
    if (!exam.transcript) {
      return NextResponse.json({ error: "No transcript" }, { status: 400 });
    }

    const { baseUrl, model } = getLmConfig();
    const system = buildSystemPrompt(exam.type || "Badanie");

    const res = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        temperature: 0,
        messages: [
          { role: "system", content: system },
          { role: "user", content: exam.transcript },
        ],
      }),
    });

    const json = JSON.parse(await res.text());
    const parsed = safeJsonParse(json.choices[0].message.content);

    const sections = parsed.sections || {};
    const findings = sections.findings ? oneLine(sections.findings) : null;
    const conclusions = sections.conclusions ? oneLine(sections.conclusions) : null;

    await ref.update({
      analysis: {
        sections: {
          reason: sections.reason ? oneLine(sections.reason) : null,
          findings,
          conclusions,
          recommendations: sections.recommendations
            ? oneLine(sections.recommendations)
            : null,
        },
        keyFindings: parsed.keyFindings || null,
        organFindings: inferOrganFindings(findings || ""),
        summaryType: inferSummaryType(findings, conclusions),
      },
      analysisMeta: {
        promptVersion: PROMPT_VERSION,
        model,
        analyzedAt: new Date(),
      },
    });

    return NextResponse.json({ ok: true });
  } catch (e: any) {
    console.error("ANALYZE ERROR:", e);
    return NextResponse.json({ error: e.message }, { status: 500 });
  }
}

// app/api/exams/analyze/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION = "analyze-v1";

/**
 * Ustaw w .env.local:
 * LMSTUDIO_BASE_URL=http://127.0.0.1:11434
 * LMSTUDIO_MODEL=qwen2.5-14b-instruct
 */
function getLmConfig() {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
  const model = process.env.LMSTUDIO_MODEL || "qwen2.5-14b-instruct";
  return { baseUrl, model };
}

async function getAdminDb() {
  const relPath = process.env.FIREBASE_SERVICE_ACCOUNT_PATH;
  if (!relPath) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_PATH (in .env.local)");

  const absPath = path.join(process.cwd(), relPath);
  const raw = await fs.readFile(absPath, "utf-8");
  const serviceAccount = JSON.parse(raw);

  const app =
    getApps().length > 0 ? getApps()[0] : initializeApp({ credential: cert(serviceAccount) });

  return getFirestore(app);
}

function buildSystemPrompt(examType: string) {
  return `
Jesteś asystentem lekarza weterynarii. Twoim zadaniem jest WYŁĄCZNIE ekstrakcja informacji z transkrypcji i przypisanie jej do pól raportu.
Zwracaj WYŁĄCZNIE poprawny JSON. Bez komentarzy, bez markdown, bez dodatkowego tekstu.

Zasady:
- Jeśli w transkrypcji NIE MA informacji do danej sekcji, zwróć null.
- Nie wymyślaj faktów.
- Pisz po polsku.
- Sekcje raportu: reason (powód wizyty), findings (opis badania), conclusions (wnioski), recommendations (zalecenia).

Typ badania: ${examType}

Oczekiwany format JSON (dokładnie te klucze):
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

function safeJsonParse(text: string) {
  const t = (text || "").trim();

  const firstBrace = t.indexOf("{");
  const lastBrace = t.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace !== -1 && lastBrace > firstBrace) {
    const slice = t.slice(firstBrace, lastBrace + 1);
    return JSON.parse(slice);
  }

  return JSON.parse(t);
}

export async function POST(req: NextRequest) {
  const started = Date.now();

  try {
    const { clinicId, patientId, examId } = (await req.json()) as {
      clinicId?: string;
      patientId?: string;
      examId?: string;
    };

    // clinicId jest opcjonalne, bo nie wiemy jeszcze na 100% gdzie masz dane
    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const adminDb = await getAdminDb();

    // Dwie możliwe struktury danych (w projekcie pojawiały się obie):
    // A) patients/{patientId}/exams/{examId}
    // B) clinics/{clinicId}/patients/{patientId}/exams/{examId}
    const refA = adminDb.doc(`patients/${patientId}/exams/${examId}`);
    const refB = clinicId
      ? adminDb.doc(`clinics/${clinicId}/patients/${patientId}/exams/${examId}`)
      : null;

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
          tried: {
            pathA: refA.path,
            pathB: refB?.path ?? null,
          },
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
    const user = `TRANSKRYPCJA:\n${transcript.trim()}`;

    const lmRes = await fetch(`${baseUrl}/v1/chat/completions`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        model,
        stream: false,
        temperature: 0,
        max_tokens: 500,
        messages: [
          { role: "system", content: system },
          { role: "user", content: user },
        ],
      }),
    });

    if (!lmRes.ok) {
      const errText = await lmRes.text();
      return NextResponse.json(
        { error: "LM Studio error", status: lmRes.status, details: errText.slice(0, 2000) },
        { status: 502 }
      );
    }

    const data = await lmRes.json();
    const content = data?.choices?.[0]?.message?.content;

    if (!content || typeof content !== "string") {
      return NextResponse.json({ error: "LM Studio returned empty content" }, { status: 502 });
    }

    const parsed = safeJsonParse(content);

    const sections = parsed?.sections ?? {};
    const normalized = {
      sections: {
        reason: typeof sections.reason === "string" ? sections.reason.trim() : null,
        findings: typeof sections.findings === "string" ? sections.findings.trim() : null,
        conclusions: typeof sections.conclusions === "string" ? sections.conclusions.trim() : null,
        recommendations:
          typeof sections.recommendations === "string" ? sections.recommendations.trim() : null,
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
      },
      docPath: examRef.path,
    });
  } catch (err: any) {
    console.error("ANALYZE ERROR:", err);
    return NextResponse.json({ error: err?.message || "Unknown error" }, { status: 500 });
  }
}

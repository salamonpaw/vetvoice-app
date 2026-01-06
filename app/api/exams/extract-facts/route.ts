// app/api/exams/extract-facts/route.ts
export const runtime = "nodejs";

import { NextRequest, NextResponse } from "next/server";
import path from "path";
import fs from "fs/promises";

import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

const PROMPT_VERSION =
  "facts-v9.2-p072-firestore-stripUndefined-only+preprocess-dictionary+loop-protection+anamnesis-reason+patientname-owner-guard+logiclayer-wall-shadow+findings-lines+conditions-dotkeys+drop-empty-keys";
const MAX_LLM_INPUT_CHARS = Number(process.env.FACTS_MAX_INPUT_CHARS || 12000);
const LM_TIMEOUT_MS = Number(process.env.FACTS_LM_TIMEOUT_MS || 60000);

/* ================= Firestore-safe: strip undefined ================= */

function stripUndefinedDeep<T>(obj: T): T {
  if (Array.isArray(obj)) {
    return obj.map(stripUndefinedDeep).filter((v) => v !== undefined) as any;
  }
  if (obj && typeof obj === "object") {
    const out: any = {};
    for (const [k, v] of Object.entries(obj as any)) {
      if (v === undefined) continue;
      const vv = stripUndefinedDeep(v);
      if (vv === undefined) continue;
      out[k] = vv;
    }
    return out;
  }
  return obj;
}

/* ================= Vet Dictionary (STT → Medical) ================= */

export const VET_STT_DICTIONARY: Array<[string, string]> = [
  ["milniczka", "miedniczka"],
  ["jedniczka", "miedniczka"],

  ["pęcherz grzucowy", "pęcherzyk żółciowy"],

  ["dogrzgotowa", "dogrzbietowa"],

  ["hipertafoganda", "hiperechogenna"],

  ["czachy zapalenia", "cechy zapalenia"],
  ["czachami zapalenia", "cechami zapalenia"],

  ["wiejniki", "jajniki"],
  ["wieżniki", "jajniki"],

  ["szóstka", "trzustka"],

  ["aksiserpa", "akcja serca"],

  ["kręskowe", "krezkowe"],

  ["jelito człeiste", "jelito czcze"],

  ["angioteka", "angio-tk"],

  ["organiczność", "echogeniczność"],
  ["ehebryczność", "echogeniczność"],

  ["uposzerzone", "poszerzone"],

  ["nekrozwycięstwo", "nefrolity"],
  ["nieolity", "nefrolity"],

  ["próbływy", "przepływy"],
  ["przebływy", "przepływy"],

  ["miąż", "miąższ"],
  ["koraj", "kora"],

  ["cieniak użytkowy", "cień akustyczny"],
  ["cieniek użytkowy", "cień akustyczny"],

  ["węzły kręskowe", "węzły krezkowe"],
  ["węzły kręskowy", "węzły krezkowe"],

  ["jelita, czego stwierdzam", "jelita, gdzie stwierdzam"],

  ["wywiatował", "zwymiotował"],
  ["wywiatowała", "zwymiotowała"],

  ["pęcherzyk żujciowy", "pęcherzyk żółciowy"],

  // z Twoich testów: STT czasem robi totalny odjazd przy nerkach
  ["prątnica pachwina", "nerki"],
];

function escapeRegex(s: string) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function applyVetDictionary(text: string) {
  const applied: Array<{ from: string; to: string; count: number }> = [];

  let out = text;
  for (const [from, to] of VET_STT_DICTIONARY) {
    const re = new RegExp(`\\b${escapeRegex(from)}\\b`, "gi");
    let count = 0;
    out = out.replace(re, () => {
      count += 1;
      return to;
    });
    if (count > 0) applied.push({ from, to, count });
  }

  return { text: out, applied };
}

/* ================= Loop protection + Anamnesis (Reason) ================= */

function normalizeLoopKey(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/[“”"]/g, '"')
    .replace(/[.,;:!?]+$/g, "")
    .trim();
}

export function removeLoops(text: string, opts?: { maxRepeats?: number; keep?: number }) {
  const maxRepeats = opts?.maxRepeats ?? 3;
  const keep = opts?.keep ?? 1;

  const rawLines = String(text || "")
    .split(/\r?\n/)
    .flatMap((l) => {
      const line = l.trim();
      if (!line) return [];
      if (line.length > 400 && line.includes(". "))
        return line.split(/(?<=\.)\s+/).map((x) => x.trim());
      return [line];
    })
    .filter(Boolean);

  const counts = new Map<string, number>();
  const keptCounts = new Map<string, number>();
  let removed = 0;

  const outLines: string[] = [];
  for (const line of rawLines) {
    const key = normalizeLoopKey(line);
    const c = (counts.get(key) ?? 0) + 1;
    counts.set(key, c);

    if (c > maxRepeats) {
      const kept = keptCounts.get(key) ?? 0;
      if (kept < keep) {
        outLines.push(line);
        keptCounts.set(key, kept + 1);
      } else {
        removed += 1;
      }
      continue;
    }

    outLines.push(line);
  }

  return {
    text: outLines.join("\n"),
    removed,
    uniqueLoopCandidates: Array.from(counts.entries())
      .filter(([, c]) => c > maxRepeats)
      .map(([k, c]) => ({ key: k, count: c })),
  };
}

const OWNER_REASON_PATTERNS: Array<{ id: string; re: RegExp; label: string }> = [
  {
    id: "hematuria",
    re: /\bsika\s+krwi(?:ą|a)?\b|\bkrew\s+w\s+moczu\b|\bkrwiomocz\b/i,
    label: "krwiomocz / sikanie krwią",
  },
  {
    id: "vomiting",
    re: /\b(?:wymiot(?:uje|y|ował|owała|y?my)|zwymiot(?:ował|owała|uje|y|ali|ały))\b/i,
    label: "wymioty",
  },
  { id: "diarrhea", re: /\bbiegunka\b|\bluzne?\s+kup(?:y|a)\b/i, label: "biegunka" },
  { id: "anorexia", re: /\bnie\s+je\b|\bbrak\s+apetytu\b/i, label: "brak apetytu / nie je" },
  {
    id: "polydipsia",
    re: /\bdużo\s+pije\b|\bwzmożone\s+pragnienie\b/i,
    label: "wzmożone pragnienie (dużo pije)",
  },
  {
    id: "polyuria",
    re: /\bdużo\s+sika\b|\bczęsto\s+sika\b|\bwielomocz\b/i,
    label: "wielomocz / częste oddawanie moczu",
  },
  {
    id: "abdominal_pain",
    re: /\bboli\s+brzuch\b|\bbolesno(?:ść|sci)\b|\bnapina\s+brzuch\b/i,
    label: "ból brzucha / bolesność",
  },
  {
    id: "lethargy",
    re: /\bosowiały\b|\bapatyczna\b|\bapatyczny\b|\bzgaszona\b|\bbez\s+energii\b/i,
    label: "osowiałość / apatia",
  },
];

export function extractPatientNameCandidate(text: string) {
  // owner-guard: ignoruj formy grzecznościowe jeśli w pobliżu jest "proszę"
  const candidates: string[] = [];

  const patterns: RegExp[] = [
    /\bWitam\s+Pana\s+([A-ZĄĆĘŁŃÓŚŻŹ][a-ząćęłńóśżź]{1,20})\b/g,
    /\bWitam\s+Panią\s+([A-ZĄĆĘŁŃÓŚŻŹ][a-ząćęłńóśżź]{1,20})\b/g,
    /\bPanie\s+([A-ZĄĆĘŁŃÓŚŻŹ][a-ząćęłńóśżź]{1,20})\b/g,
    /\bPani\s+([A-ZĄĆĘŁŃÓŚŻŹ][a-ząćęłńóśżź]{1,20})\b/g,
  ];

  for (const re of patterns) {
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const name = m[1];
      if (!name) continue;

      const tail = text.slice(m.index, Math.min(text.length, m.index + 80)).toLowerCase();
      if (tail.includes("proszę")) continue;

      candidates.push(name);
    }
  }

  const raw = candidates.length ? candidates[0] : null;
  if (!raw) return { raw: null, normalized: null };

  // bardzo ostrożna normalizacja odmiany (Maxa -> Max)
  let normalized = raw;
  const lower = raw.toLowerCase();
  const vowels = ["a", "e", "i", "o", "u", "y", "ą", "ę", "ó"];
  if (lower.endsWith("a") && raw.length >= 3) {
    const prev = lower[lower.length - 2];
    if (!vowels.includes(prev)) normalized = raw.slice(0, -1);
  }

  normalized = normalized.charAt(0).toUpperCase() + normalized.slice(1);
  return { raw, normalized };
}

function extractReasonCandidate(text: string) {
  const hits: Array<{ id: string; label: string }> = [];
  for (const p of OWNER_REASON_PATTERNS) {
    if (p.re.test(text)) hits.push({ id: p.id, label: p.label });
  }
  const unique = Array.from(new Map(hits.map((h) => [h.id, h])).values());

  const lines = String(text || "")
    .split(/\r?\n/)
    .flatMap((l) => (l.includes(". ") ? l.split(/(?<=\.)\s+/) : [l]))
    .map((l) => l.trim())
    .filter(Boolean);

  const reasonLine =
    lines.find((l) => OWNER_REASON_PATTERNS.some((p) => p.re.test(l))) || null;

  const reason =
    reasonLine?.replace(/\s+/g, " ").trim().replace(/[.。]\s*$/g, "") ||
    (unique.length ? unique.map((h) => h.label).join("; ") : null);

  return {
    hits: unique,
    reason: reason || null,
  };
}

export function preprocessTranscript(transcriptRaw: string) {
  const dict = applyVetDictionary(transcriptRaw);
  const loop = removeLoops(dict.text, { maxRepeats: 3, keep: 1 });
  const reason = extractReasonCandidate(loop.text);
  const name = extractPatientNameCandidate(loop.text);

  return {
    text: loop.text,
    dictionaryApplied: dict.applied,
    loopsRemoved: loop.removed,
    loopCandidates: loop.uniqueLoopCandidates,
    reasonCandidate: reason.reason,
    reasonHits: reason.hits,
    patientNameCandidate: name.normalized,
    patientNameRaw: name.raw,
  };
}

/* ================= Logic Layer (P0.5) ================= */

const HOLLOW_ORGANS = [
  "pęcherz",
  "pęcherz moczowy",
  "pęcherzyk żółciowy",
  "żołądek",
  "jelita",
  "jelito",
  "macica",
];

const SOLID_KEYWORDS = ["kamień", "złóg", "konkrement", "zwapnienie", "mineralizac"];

export type LogicRejection = {
  rule: "wall_assignment" | "acoustic_shadow";
  organ?: string;
  finding?: string;
  reason: string;
};

function normalizeOrganName(s: string) {
  return String(s || "")
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim();
}

function parseFindingLine(line: string) {
  const idx = line.indexOf(":");
  if (idx === -1) return { organ: null, desc: line };
  const organ = line.slice(0, idx).trim();
  const desc = line.slice(idx + 1).trim();
  return { organ, desc };
}

function enforceWallAssignment(findingsLines: string[]) {
  const kept: string[] = [];
  const rejected: LogicRejection[] = [];

  for (const line of findingsLines) {
    const { organ, desc } = parseFindingLine(line);
    const organNorm = normalizeOrganName(organ || "");

    const hasWall = /ścian/i.test(desc || line);
    if (!hasWall) {
      kept.push(line);
      continue;
    }

    const isHollow = HOLLOW_ORGANS.some((o) => organNorm === o || organNorm.includes(o));
    if (isHollow) {
      kept.push(line);
      continue;
    }

    rejected.push({
      rule: "wall_assignment",
      organ: organ || undefined,
      finding: line,
      reason:
        'Wykryto "ścian(…)" przy narządzie miąższowym. Reguła: ściana tylko dla narządów pustych.',
    });
  }

  return { kept, rejected };
}

function detectAcousticShadow(findingsLines: string[]) {
  const warnings: LogicRejection[] = [];

  for (const line of findingsLines) {
    const lower = line.toLowerCase();
    if (!lower.includes("cień akustyczny")) continue;

    const hasSolid = SOLID_KEYWORDS.some((k) => lower.includes(k));
    if (!hasSolid) {
      const { organ } = parseFindingLine(line);
      warnings.push({
        rule: "acoustic_shadow",
        organ: organ || undefined,
        finding: line,
        reason:
          'Wykryto "cień akustyczny" bez jasnego sąsiedztwa (kamień/złóg/zwapnienie). Do weryfikacji w kontekście.',
      });
    }
  }

  return warnings;
}

export function enforceLogicLayerOnFacts(facts: any) {
  const findingsLines: string[] = Array.isArray(facts?.findingsLines)
    ? facts.findingsLines
    : Array.isArray(facts?.findings)
      ? facts.findings
      : [];

  const wall = enforceWallAssignment(findingsLines);
  const shadowWarnings = detectAcousticShadow(wall.kept);

  facts.findingsLines = wall.kept;
  facts.findings = wall.kept;

  const rejections = [...wall.rejected, ...shadowWarnings];
  return { facts, logicRejections: rejections };
}

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

  // ❗ Nie wywołujemy db.settings() – bo wali "only once".
  // Zamiast tego: stripUndefinedDeep przed zapisem.
  return getFirestore(app);
}

/* ================= LM Studio ================= */

function getLmConfig(modelOverride?: string) {
  const baseUrl = process.env.LMSTUDIO_BASE_URL || "http://127.0.0.1:11434";
  const model = modelOverride || process.env.LMSTUDIO_MODEL || "qwen2.5-14b-instruct-1m";
  const apiKey = process.env.LMSTUDIO_API_KEY || "lm-studio";
  return { baseUrl, model, apiKey };
}

/* ================= PROMPT ================= */

function buildSystemPrompt() {
  return `Jesteś asystentem dokumentacji medycznej (weterynaria).

ETAP A — EKSTRAKCJA FAKTÓW z transkrypcji badania USG.
Zwróć WYŁĄCZNIE jeden poprawny obiekt JSON {}. Bez markdown. Bez komentarzy.

JĘZYK:
- wszystkie wartości tekstowe po POLSKU
- jeśli niepewne / brak → null albo [] (zgodnie z polem)
- NIE interpretuj, NIE diagnozuj, NIE formułuj wniosków

WYMAGANE POLA:
1) exam:
   - bodyRegion: string|null
   - reason: string|null (powód wizyty; tylko jeśli padło wprost lub wynika z anamnezy właściciela; bez dopisywania)
2) conditions: obiekt
   - sedation: string|null (np. "bez sedacji")
   - position: string|null (np. "pozycja boczna", "pozycja grzbietowa")
   - limitations: string[] (np. "pacjent niespokojny", jeśli padło)
3) findings: string[]
   - Lista ZDAŃ "Narząd: opis" (np. "Wątroba: jednorodna, bez zmian ogniskowych").
   - Tylko to, co padło wprost.
   - Jeśli brak opisów → []
4) measurements: tablica (OBOWIĄZKOWE)
   - Każdy element:
     { structure: string, location: string|null, value: number[], unit: string, meta?: object }
   - value ZAWSZE tablica liczb
   - Jeśli nie da się zachować formatu → measurements = []

Jeżeli pojawi się inny język niż polski — zwróć {}.`;
}

/* ================= LLM CALL ================= */

async function callLmStudio(args: {
  systemPrompt: string;
  userContent: string;
  maxTokens?: number;
  timeoutMs?: number;
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
    temperature: 0.0,
    max_tokens: args.maxTokens ?? 1800,
  };

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), args.timeoutMs ?? LM_TIMEOUT_MS);

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
      throw new Error(`LM Studio error (${res.status}): ${rawText.slice(0, 2000)}`);
    }

    const data = JSON.parse(rawText);
    const content = data?.choices?.[0]?.message?.content;
    if (!content || typeof content !== "string") {
      throw new Error("LM Studio returned empty content");
    }

    return {
      content,
      modelUsed: model,
      baseUrl,
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

function isPlainObject(v: any): v is Record<string, any> {
  return v && typeof v === "object" && !Array.isArray(v);
}

function uniqTrim(lines: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of lines) {
    const s = String(raw ?? "").replace(/\s+/g, " ").trim();
    if (!s) continue;
    const key = s.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(s);
  }
  return out;
}

function dropEmptyKeyOnly(lines: string[]): string[] {
  return lines.filter((l) => {
    const s = String(l ?? "").trim();
    if (!s) return false;
    if (/^[^:]{2,}:\s*$/.test(s)) return false;
    return true;
  });
}

/**
 * Stabilna normalizacja measurements:
 * - usuwa śmieci
 * - nie dopuszcza undefined w polach
 * - meta dodaje tylko jeśli jest obiektem i po stripowaniu nie jest puste
 * - TS: bez implicit any
 */
function normalizeMeasurements(input: unknown): any[] {
  if (!Array.isArray(input)) return [];

  const out: any[] = [];

  for (const m of input as unknown[]) {
    if (!m || typeof m !== "object") continue;

    const mm = m as any;

    const structure = typeof mm.structure === "string" ? mm.structure.trim() : "";
    const location =
      typeof mm.location === "string" && mm.location.trim() ? mm.location.trim() : null;
    const unit = typeof mm.unit === "string" ? mm.unit.trim() : "";

    const rawValue: unknown[] = Array.isArray(mm.value) ? (mm.value as unknown[]) : [];
    const value: number[] = rawValue
      .map((x: unknown) => (typeof x === "number" && Number.isFinite(x) ? x : null))
      .filter((x): x is number => x !== null);

    if (!structure) continue;
    if (!unit) continue;
    if (!value.length) continue;

    const item: any = { structure, location, value, unit };

    if (mm.meta && typeof mm.meta === "object" && !Array.isArray(mm.meta)) {
      const meta = stripUndefinedDeep(mm.meta);
      if (meta && typeof meta === "object" && Object.keys(meta).length > 0) {
        item.meta = meta;
      }
    }

    out.push(item);
  }

  return out;
}

// Zbiera klucze typu "conditions.sedation" -> { sedation: ... }
function collectDotKeys(obj: Record<string, any>, prefix: string): Record<string, any> {
  const out: Record<string, any> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (!k.startsWith(prefix + ".")) continue;
    const sub = k.slice(prefix.length + 1);
    if (!sub) continue;
    out[sub] = v;
  }
  return out;
}

function normalizeToLines(input: any, opts?: { includeKeys?: boolean }): string[] {
  const includeKeys = Boolean(opts?.includeKeys);
  if (!input) return [];

  if (typeof input === "string") return dropEmptyKeyOnly(uniqTrim([input]));

  if (Array.isArray(input)) {
    const lines: string[] = [];
    for (const item of input) {
      if (!item) continue;
      if (typeof item === "string") lines.push(item);
      else if (isPlainObject(item)) {
        const structure =
          item.structure || item.organ || item.narzad || item.name || item.part;
        const desc =
          item.desc ||
          item.description ||
          item.finding ||
          item.findings ||
          item.text ||
          item.value;

        if (structure && typeof desc === "string") {
          lines.push(`${String(structure)}: ${desc}`);
        } else {
          try {
            lines.push(JSON.stringify(item));
          } catch {}
        }
      } else lines.push(String(item));
    }
    return dropEmptyKeyOnly(uniqTrim(lines));
  }

  if (isPlainObject(input)) {
    const lines: string[] = [];
    for (const [k, v] of Object.entries(input)) {
      if (v === null || v === undefined) continue;

      if (typeof v === "string") {
        lines.push(includeKeys ? `${k}: ${v}` : v);
      } else if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
        const joined = v.filter(Boolean).join(", ");
        lines.push(includeKeys ? `${k}: ${joined}` : joined);
      } else {
        try {
          lines.push(includeKeys ? `${k}: ${JSON.stringify(v)}` : JSON.stringify(v));
        } catch {}
      }
    }
    return dropEmptyKeyOnly(uniqTrim(lines));
  }

  try {
    return dropEmptyKeyOnly(uniqTrim([JSON.stringify(input)]));
  } catch {
    return [];
  }
}

function normalizeFactsForReport(facts: any) {
  let conditionsObj: any = facts?.conditions;
  if (!conditionsObj && isPlainObject(facts)) {
    const dot = collectDotKeys(facts, "conditions");
    if (Object.keys(dot).length) conditionsObj = dot;
  }
  if (!conditionsObj) conditionsObj = {};

  const conditionsLines = normalizeToLines(conditionsObj, { includeKeys: true });

  const srcFindings =
    facts?.findings ?? facts?.findingsByOrgan ?? facts?.organs ?? facts?.findingsText;

  const findingsLines = normalizeToLines(srcFindings, { includeKeys: true });

  facts.conditions = conditionsLines;
  facts.findings = findingsLines;
  facts.conditionsLines = conditionsLines;
  facts.findingsLines = findingsLines;

  return facts;
}

/* ================= ENDPOINT ================= */

export async function POST(req: NextRequest) {
  try {
    const { clinicId, patientId, examId, useAltModel } =
      (await req.json()) as {
        clinicId?: string;
        patientId?: string;
        examId?: string;
        useAltModel?: boolean;
      };

    if (!patientId || !examId) {
      return NextResponse.json({ error: "Missing patientId or examId" }, { status: 400 });
    }

    const requestedModelName = useAltModel
      ? process.env.LMSTUDIO_MODEL_ALT || process.env.LMSTUDIO_MODEL
      : process.env.LMSTUDIO_MODEL;

    const adminDb = await getAdminDb();

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
      return NextResponse.json({ error: "Exam not found" }, { status: 404 });
    }

    const exam = snap.data() as any;
    const transcriptRaw = String(exam?.transcriptRaw || exam?.transcript || "").trim();

    if (!transcriptRaw) {
      return NextResponse.json({ error: "No transcript on exam" }, { status: 400 });
    }

    // preprocess BEFORE extract-facts
    const pre = preprocessTranscript(transcriptRaw);
    const transcriptPreprocessed = pre.text;

    const input =
      transcriptPreprocessed.length > MAX_LLM_INPUT_CHARS
        ? transcriptPreprocessed.slice(0, MAX_LLM_INPUT_CHARS)
        : transcriptPreprocessed;

    const lm = await callLmStudio({
      systemPrompt: buildSystemPrompt(),
      userContent: `TRANSKRYPCJA (po korekcie STT):\n${input}`,
      modelOverride: requestedModelName,
    });

    const raw = String(lm.content || "");
    let facts: any = null;

    try {
      facts = JSON.parse(raw);
    } catch {
      const extracted = extractJsonObject(raw);
      if (!extracted) {
        return NextResponse.json(
          { error: "Model returned non-JSON", preview: raw.slice(0, 400) },
          { status: 502 }
        );
      }
      facts = JSON.parse(extracted);
    }

    if (!facts || typeof facts !== "object" || Array.isArray(facts)) facts = {};

    facts.measurements = normalizeMeasurements(facts.measurements);

    facts = normalizeFactsForReport(facts);

    // reason + patientName z preprocessingu (deterministycznie)
    if (!facts.exam || typeof facts.exam !== "object") facts.exam = {};
    if (!facts.exam.reason && pre.reasonCandidate) facts.exam.reason = pre.reasonCandidate;
    if (!facts.exam.patientName && pre.patientNameCandidate)
      facts.exam.patientName = pre.patientNameCandidate;

    // mirror: facts.reason (ułatwia report)
    if (!facts.reason && pre.reasonCandidate) facts.reason = pre.reasonCandidate;

    // logic layer after normalization
    const logic = enforceLogicLayerOnFacts(facts);

    for (const r of logic.logicRejections) {
      console.warn(
        `[vetvoice][extract-facts][logic:${r.rule}] organ=${r.organ ?? "-"} reason=${r.reason} finding=${r.finding ?? "-"}`
      );
    }

    // ✅ Firestore-safe: strip undefined everywhere
    const factsClean = stripUndefinedDeep(logic.facts);
    const factsMetaClean = stripUndefinedDeep({
      at: new Date(),
      version: PROMPT_VERSION,
      modelUsed: lm.modelUsed,
      baseUrl: lm.baseUrl,
      tookMs: lm.tookMs,
      preprocess: {
        ...pre,
        inputChars: input.length,
      },
      logicLayer: {
        rejections: logic.logicRejections,
        rejectionsCount: logic.logicRejections.length,
      },
      normalized: true,
      normalizedFields: [
        "facts.findings",
        "facts.conditions",
        "facts.findingsLines",
        "facts.conditionsLines",
      ],
    });

    await examRef.update({
      facts: factsClean,
      factsMeta: factsMetaClean,
    });

    return NextResponse.json({
      ok: true,
      docPath: examRef.path,
      facts: factsClean,
      preprocess: {
        dictionaryApplied: pre.dictionaryApplied,
        loopsRemoved: pre.loopsRemoved,
        reasonCandidate: pre.reasonCandidate,
        patientNameCandidate: pre.patientNameCandidate,
      },
      logicLayer: { rejections: logic.logicRejections },
      tookMs: lm.tookMs,
    });
  } catch (e: any) {
    return NextResponse.json({ error: e?.message ?? "Unknown error" }, { status: 500 });
  }
}

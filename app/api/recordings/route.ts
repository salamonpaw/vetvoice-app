import { NextResponse } from "next/server";
import path from "path";
import { mkdir, writeFile } from "fs/promises";

export const runtime = "nodejs"; // MUSI być node (fs)

type Ok = {
  ok: true;
  storage: "local";
  savedAt: string;
  absolutePath: string;
  relativePath: string;
  size: number;
  mimeType: string;
  clinicId: string;
  patientId: string;
  examId: string;
  durationMs?: number;
};

type Err = {
  ok: false;
  error: string;
};

function sanitizeSegment(input: string) {
  // bezpieczne segmenty ścieżki: tylko litery/cyfry/_-
  return (input || "").replace(/[^a-zA-Z0-9_-]/g, "_");
}

export async function POST(req: Request) {
  try {
    const form = await req.formData();

    const file = form.get("file");
    const clinicId = String(form.get("clinicId") || "");
    const patientId = String(form.get("patientId") || "");
    const examId = String(form.get("examId") || "");
    const durationMsRaw = form.get("durationMs");

    if (!file || !(file instanceof Blob)) {
      return NextResponse.json<Err>(
        { ok: false, error: 'Brak pliku. Oczekuję pola formData: "file".' },
        { status: 400 }
      );
    }
    if (!clinicId || !patientId || !examId) {
      return NextResponse.json<Err>(
        {
          ok: false,
          error:
            'Brak wymaganych pól. Oczekuję: "clinicId", "patientId", "examId".',
        },
        { status: 400 }
      );
    }

    const durationMs =
      typeof durationMsRaw === "string" && durationMsRaw.trim() !== ""
        ? Number(durationMsRaw)
        : undefined;

    const mimeType = file.type || "application/octet-stream";

    // rozszerzenie po MIME (minimum dla PoC)
    const ext =
      mimeType.includes("ogg") ? "ogg" : mimeType.includes("wav") ? "wav" : "webm";

    const safeClinicId = sanitizeSegment(clinicId);
    const safePatientId = sanitizeSegment(patientId);
    const safeExamId = sanitizeSegment(examId);

    // katalog docelowy
    // <root>/data/clinics/{clinicId}/patients/{patientId}/exams/{examId}/
    const baseDir = path.join(
      process.cwd(),
      "data",
      "clinics",
      safeClinicId,
      "patients",
      safePatientId,
      "exams",
      safeExamId
    );

    await mkdir(baseDir, { recursive: true });

    const ts = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `recording-${ts}.${ext}`;
    const absolutePath = path.join(baseDir, filename);

    // zapis pliku
    const buf = Buffer.from(await file.arrayBuffer());
    await writeFile(absolutePath, buf);

    const relativePath = path
      .relative(process.cwd(), absolutePath)
      .split(path.sep)
      .join("/");

    const res: Ok = {
      ok: true,
      storage: "local",
      savedAt: new Date().toISOString(),
      absolutePath,
      relativePath,
      size: buf.length,
      mimeType,
      clinicId,
      patientId,
      examId,
      durationMs,
    };

    return NextResponse.json(res);
  } catch (e: any) {
    return NextResponse.json<Err>(
      { ok: false, error: e?.message ?? "Nieznany błąd zapisu nagrania." },
      { status: 500 }
    );
  }
}

export async function GET() {
  // prosty healthcheck
  return NextResponse.json({ ok: true, route: "/api/recordings" });
}

import { NextResponse } from "next/server";
import path from "path";
import { readFile } from "fs/promises";

export const runtime = "nodejs";

function guessContentType(p: string) {
  const ext = (p.split(".").pop() || "").toLowerCase();
  if (ext === "webm") return "audio/webm";
  if (ext === "ogg") return "audio/ogg";
  if (ext === "wav") return "audio/wav";
  return "application/octet-stream";
}

export async function GET(req: Request) {
  try {
    const url = new URL(req.url);
    const rel = url.searchParams.get("path");

    if (!rel) {
      return NextResponse.json(
        { ok: false, error: 'Brak parametru "path".' },
        { status: 400 }
      );
    }

    // normalizujemy i blokujemy próby ../
    const normalized = rel.replace(/\\/g, "/");
    const relPath = path.normalize(normalized);

    // wymagamy żeby to było w katalogu data/
    const base = path.join(process.cwd(), "data");
    const abs = path.join(process.cwd(), relPath);

    // sprawdź czy abs jest pod base
    const absResolved = path.resolve(abs);
    const baseResolved = path.resolve(base);

    if (!absResolved.startsWith(baseResolved + path.sep) && absResolved !== baseResolved) {
      return NextResponse.json(
        { ok: false, error: "Niedozwolona ścieżka (poza katalogiem data/)." },
        { status: 403 }
      );
    }

    const buf = await readFile(absResolved);
    const ct = guessContentType(absResolved);

    return new NextResponse(buf, {
      status: 200,
      headers: {
        "Content-Type": ct,
        "Content-Length": String(buf.length),
        // pozwalamy na cache off w PoC
        "Cache-Control": "no-store",
      },
    });
  } catch (e: any) {
    return NextResponse.json(
      { ok: false, error: e?.message ?? "Nie udało się odczytać pliku." },
      { status: 500 }
    );
  }
}

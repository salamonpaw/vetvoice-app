"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

const EXAM_TYPES = ["USG jamy brzusznej", "USG ciąży", "RTG", "Echo serca", "Badanie ogólne", "Inne"] as const;

type ExamType = (typeof EXAM_TYPES)[number];

export default function NewExamPage() {
  const router = useRouter();
  const params = useParams<{ id: string | string[] }>();

  const patientId = useMemo(() => {
    const raw = params?.id;
    if (!raw) return "";
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");

  const [examType, setExamType] = useState<ExamType>("USG jamy brzusznej");
  const [examTypeOther, setExamTypeOther] = useState("");

  const finalExamType = examType === "Inne" ? examTypeOther.trim() : examType.trim();
  const canSubmit = !saving && !!patientId && !!finalExamType;

  async function onStart(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    setError("");

    if (!patientId) return setError("Brak ID pacjenta w URL.");
    if (!finalExamType) return setError("Wybierz typ badania (lub wpisz własny).");

    try {
      setSaving(true);

      const clinicId = await getMyClinicId();

      const docRef = await addDoc(collection(db, "patients", patientId, "exams"), {
        clinicId,
        patientId,
        type: finalExamType,
        status: "draft",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      });

      router.push(`/patients/${patientId}/exams/${docRef.id}`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex items-center gap-3">
        <Link
          href={patientId ? `/patients/${patientId}` : "/patients"}
          className="text-sm text-slate-600 hover:text-slate-900"
        >
          ← Wróć do pacjenta
        </Link>
        <div className="text-lg font-semibold tracking-tight">Nowe badanie</div>
      </div>

      <form onSubmit={onStart} className="space-y-4">
        <section className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm space-y-4">
          <div>
            <div className="text-sm font-semibold text-slate-900">Typ badania</div>
            <div className="mt-1 text-xs text-slate-500">Wybierz typ, aby rozpocząć. „Inne” pozwala wpisać własną nazwę.</div>
          </div>

          {/* Select-cards */}
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            {EXAM_TYPES.map((t) => {
              const active = examType === t;

              return (
                <button
                  key={t}
                  type="button"
                  onClick={() => setExamType(t)}
                  className={[
                    "text-left rounded-2xl border p-4 transition",
                    "hover:bg-slate-50 hover:border-slate-300",
                    "focus:outline-none focus:ring-2 focus:ring-slate-200",
                    active ? "border-slate-900 bg-white" : "border-slate-200 bg-white",
                  ].join(" ")}
                  aria-pressed={active}
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <div className="text-sm font-semibold text-slate-900">{t}</div>
                      <div className="mt-1 text-xs text-slate-500">
                        {t === "Inne" ? "Wpisz własny typ badania" : "Szybki start"}
                      </div>
                    </div>

                    <span
                      className={[
                        "mt-0.5 inline-flex h-5 w-5 items-center justify-center rounded-full border text-xs",
                        active ? "border-slate-900 bg-slate-900 text-white" : "border-slate-200 bg-white text-transparent",
                      ].join(" ")}
                      aria-hidden="true"
                    >
                      ✓
                    </span>
                  </div>
                </button>
              );
            })}
          </div>

          {/* Other input */}
          {examType === "Inne" && (
            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-4">
              <label className="grid gap-2">
                <span className="text-sm font-semibold text-slate-900">Nazwa badania</span>
                <input
                  value={examTypeOther}
                  onChange={(e) => setExamTypeOther(e.target.value)}
                  placeholder="np. USG tarczycy"
                  className="w-full rounded-xl border border-slate-200 bg-white px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-slate-200"
                />
                <div className="text-xs text-slate-500">Wpisz krótko i rzeczowo, np. „USG tarczycy”.</div>
              </label>
            </div>
          )}

          {/* Error */}
          {error && (
            <div className="rounded-2xl border border-red-200 bg-red-50 p-3 text-sm text-red-800">
              <div className="font-semibold">Błąd</div>
              <div className="mt-1">{error}</div>
            </div>
          )}

          {/* Submit */}
          <div className="flex flex-col gap-2 sm:flex-row sm:items-center sm:justify-between">
            <button
              type="submit"
              disabled={!canSubmit}
              className={[
                "rounded-xl px-4 py-2 text-sm font-medium transition",
                canSubmit ? "bg-slate-900 text-white hover:bg-slate-800" : "bg-slate-200 text-slate-500 cursor-not-allowed",
              ].join(" ")}
            >
              {saving ? "Tworzenie…" : "Start badania"}
            </button>

            <div className="text-xs text-slate-500">
              Zapiszemy szkic badania w:{" "}
              <span className="font-mono">patients/{patientId || ":id"}/exams</span>
            </div>
          </div>
        </section>
      </form>
    </div>
  );
}

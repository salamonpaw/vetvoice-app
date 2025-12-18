"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

const EXAM_TYPES = [
  "USG jamy brzusznej",
  "USG ciąży",
  "RTG",
  "Echo serca",
  "Badanie ogólne",
  "Inne",
] as const;

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
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 720 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Nowe badanie</h1>
        <Link href={patientId ? `/patients/${patientId}` : "/patients"}>← Wróć do pacjenta</Link>
      </div>

      <form onSubmit={onStart} style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <div
          style={{
            padding: 12,
            borderRadius: 12,
            border: "1px solid rgba(255,255,255,0.18)",
            background: "rgba(255,255,255,0.06)",
            display: "grid",
            gap: 12,
          }}
        >
          <div style={{ display: "grid", gap: 8 }}>
            <div style={{ fontWeight: 800 }}>Typ badania *</div>

            {/* Kafelki wyboru */}
            <div style={{ display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))", gap: 10 }}>
              {EXAM_TYPES.map((t) => {
                const active = examType === t;
                return (
                  <button
                    key={t}
                    type="button"
                    onClick={() => setExamType(t)}
                    style={{
                      padding: 12,
                      borderRadius: 12,
                      border: active ? "1px solid rgba(255,255,255,0.55)" : "1px solid rgba(255,255,255,0.18)",
                      background: active ? "rgba(255,255,255,0.14)" : "rgba(255,255,255,0.06)",
                      textAlign: "left",
                      cursor: "pointer",
                    }}
                  >
                    <div style={{ fontWeight: 800 }}>{t}</div>
                    <div style={{ fontSize: 12, opacity: 0.75, marginTop: 4 }}>
                      {t === "Inne" ? "Wpisz własny typ" : "Szybki start"}
                    </div>
                  </button>
                );
              })}
            </div>

            {examType === "Inne" && (
              <label style={{ display: "grid", gap: 6, marginTop: 4 }}>
                <span style={{ fontSize: 13, opacity: 0.85 }}>Nazwa badania *</span>
                <input
                  value={examTypeOther}
                  onChange={(e) => setExamTypeOther(e.target.value)}
                  placeholder="np. USG tarczycy"
                  style={{
                    padding: 10,
                    borderRadius: 8,
                    border: "1px solid #333",
                    background: "transparent",
                  }}
                />
              </label>
            )}
          </div>

          <button
            type="submit"
            disabled={saving}
            style={{
              padding: 12,
              borderRadius: 10,
              border: "1px solid #333",
              background: saving ? "rgba(255,255,255,0.06)" : "rgba(255,255,255,0.12)",
              cursor: saving ? "not-allowed" : "pointer",
            }}
          >
            {saving ? "Tworzenie..." : "Start badania"}
          </button>

          {error && <p style={{ color: "tomato", margin: 0 }}>Błąd: {error}</p>}

          <p style={{ margin: 0, fontSize: 12, opacity: 0.7 }}>
            Zapiszemy szkic badania w: <code>patients/{patientId || ":id"}/exams</code>
          </p>
        </div>
      </form>
    </div>
  );
}

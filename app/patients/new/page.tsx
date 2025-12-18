"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

export default function NewPatientPage() {
  const router = useRouter();

  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>("");
  const [ok, setOk] = useState<string>("");

  const [name, setName] = useState("");
  const [species, setSpecies] = useState("pies");
  const [breed, setBreed] = useState("");
  const [ownerName, setOwnerName] = useState("");

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (saving) return;

    setError("");
    setOk("");

    if (!name.trim()) return setError("Wpisz imię pacjenta.");
    if (!species.trim()) return setError("Wpisz gatunek.");

    try {
      setSaving(true);

      const clinicId = await getMyClinicId();

      const docRef = await addDoc(collection(db, "patients"), {
        clinicId,
        name: name.trim(),
        species: species.trim(),
        breed: breed.trim() || null,
        ownerName: ownerName.trim() || null,
        createdAt: serverTimestamp(),
      });

      // Minimalny, logiczny redirect po zapisie:
      router.push(`/patients/${docRef.id}`);
    } catch (e: any) {
      console.error(e);
      setError(e?.message || String(e));
      setSaving(false);
    }
  }

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 520 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Dodaj pacjenta</h1>
        <Link href="/patients">← Wróć</Link>
      </div>

      <form onSubmit={onSubmit} style={{ marginTop: 16, display: "grid", gap: 12 }}>
        <label style={{ display: "grid", gap: 6 }}>
          <span>Imię pacjenta *</span>
          <input
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="np. Figa"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #333", background: "transparent" }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Gatunek *</span>
          <input
            value={species}
            onChange={(e) => setSpecies(e.target.value)}
            placeholder="np. pies / kot"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #333", background: "transparent" }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Rasa</span>
          <input
            value={breed}
            onChange={(e) => setBreed(e.target.value)}
            placeholder="opcjonalnie"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #333", background: "transparent" }}
          />
        </label>

        <label style={{ display: "grid", gap: 6 }}>
          <span>Właściciel</span>
          <input
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="opcjonalnie"
            style={{ padding: 10, borderRadius: 8, border: "1px solid #333", background: "transparent" }}
          />
        </label>

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
          {saving ? "Zapisywanie..." : "Zapisz pacjenta"}
        </button>

        {error && <p style={{ color: "tomato", margin: 0 }}>Błąd: {error}</p>}
        {ok && <p style={{ color: "lightgreen", margin: 0 }}>{ok}</p>}
      </form>
    </div>
  );
}

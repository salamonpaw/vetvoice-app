"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { collection, getDocs, query, where, orderBy } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId, USER_TS_VERSION } from "@/lib/firebase/user";

type Patient = {
  id: string;
  name?: string;
  species?: string;
  breed?: string | null;
  ownerName?: string | null;
};

export default function PatientsPage() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");
  const [patients, setPatients] = useState<Patient[]>([]);

  useEffect(() => {
    (async () => {
      try {
        setLoading(true);
        setError("");

        const clinicId = await getMyClinicId();

        const q = query(
          collection(db, "patients"),
          where("clinicId", "==", clinicId),
          orderBy("createdAt", "desc")
        );

        const snap = await getDocs(q);
        const rows = snap.docs.map((d) => ({ id: d.id, ...(d.data() as any) }));
        setPatients(rows as Patient[]);
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
      } finally {
        setLoading(false);
      }
    })();
  }, []);

  return (
    <div style={{ padding: 24, fontFamily: "system-ui", maxWidth: 780 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "center" }}>
        <h1 style={{ margin: 0 }}>Pacjenci</h1>
        <Link href="/patients/new">➕ Dodaj pacjenta</Link>
      </div>

      <p style={{ fontSize: 12, opacity: 0.7, marginTop: 6 }}>
        user.ts version: {USER_TS_VERSION}
      </p>

      {loading && <p>Ładowanie...</p>}
      {error && <p style={{ color: "tomato" }}>Błąd: {error}</p>}

      {!loading && !error && patients.length === 0 && (
        <p>Brak pacjentów w tej klinice.</p>
      )}

      {!loading && !error && patients.length > 0 && (
        <div style={{ marginTop: 14, display: "grid", gap: 10 }}>
          {patients.map((p) => {
            const name = (p.name || "").trim() || "Bez imienia";
            const species = (p.species || "").trim() || "nieznany gatunek";
            const breed = (p.breed || "").toString().trim();
            const ownerName = (p.ownerName || "").toString().trim();

            return (
              <Link
                key={p.id}
                href={`/patients/${p.id}`}
                style={{
                  display: "block",
                  padding: 12,
                  borderRadius: 12,
                  border: "1px solid rgba(255,255,255,0.18)",
                  textDecoration: "none",
                  color: "inherit",
                  background: "rgba(255,255,255,0.06)",
                }}
              >
                <div style={{ display: "flex", justifyContent: "space-between", gap: 12 }}>
                  <div style={{ display: "grid", gap: 4 }}>
                    <div style={{ fontSize: 16, fontWeight: 700 }}>{name}</div>

                    <div style={{ opacity: 0.85 }}>
                      {species}
                      {breed ? ` • ${breed}` : ""}
                    </div>

                    {ownerName ? (
                      <div style={{ fontSize: 12, opacity: 0.75 }}>Właściciel: {ownerName}</div>
                    ) : null}
                  </div>

                  <div style={{ opacity: 0.6, whiteSpace: "nowrap" }}>→</div>
                </div>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}

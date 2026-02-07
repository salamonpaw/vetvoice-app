"use client";

import { useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { Box, Stack, TextField, Typography } from "@mui/material";
import SectionCard from "@/app/_components/SectionCard";
import { PrimaryButton, SecondaryButton } from "@/app/_components/Buttons";
import FormStack from "@/app/_components/FormStack";
import PersonAddOutlinedIcon from "@mui/icons-material/PersonAddOutlined";
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
    <Stack spacing={3} sx={{ maxWidth: 560 }}>
      <Stack direction="row" spacing={2} alignItems="center">
        <SecondaryButton component={Link} href="/patients" variant="text">
          ← Wróć
        </SecondaryButton>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Dodaj pacjenta
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Uzupełnij dane podstawowe i przejdź do karty pacjenta.
          </Typography>
        </Box>
      </Stack>

      <SectionCard
        title="Dane pacjenta"
        subtitle="Uzupełnij podstawowe informacje."
        icon={<PersonAddOutlinedIcon />}
      >
        <FormStack component="form" onSubmit={onSubmit}>
          <TextField
            label="Imię pacjenta"
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="np. Figa"
            required
            fullWidth
          />

          <TextField
            label="Gatunek"
            value={species}
            onChange={(e) => setSpecies(e.target.value)}
            placeholder="np. pies / kot"
            required
            fullWidth
          />

          <TextField
            label="Rasa"
            value={breed}
            onChange={(e) => setBreed(e.target.value)}
            placeholder="opcjonalnie"
            fullWidth
          />

          <TextField
            label="Właściciel"
            value={ownerName}
            onChange={(e) => setOwnerName(e.target.value)}
            placeholder="opcjonalnie"
            fullWidth
          />

          <PrimaryButton type="submit" size="large" disabled={saving}>
            {saving ? "Zapisywanie..." : "Zapisz pacjenta"}
          </PrimaryButton>

          {error && (
            <Typography color="error" variant="body2">
              Błąd: {error}
            </Typography>
          )}
          {ok && (
            <Typography color="success.main" variant="body2">
              {ok}
            </Typography>
          )}
        </FormStack>
      </SectionCard>
    </Stack>
  );
}

"use client";

import { useMemo, useState } from "react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Box, Grid, Paper, Stack, TextField, Typography } from "@mui/material";
import SectionCard from "@/app/_components/SectionCard";
import { PrimaryButton, SecondaryButton } from "@/app/_components/Buttons";
import FormStack from "@/app/_components/FormStack";
import AddCircleOutlineIcon from "@mui/icons-material/AddCircleOutline";
import { addDoc, collection, serverTimestamp } from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

const EXAM_TYPES = [
  "USG jamy brzusznej",
  "Badanie ogólne",
  "Inne",
  "USG ciąży",
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

  const finalExamType =
    examType === "Inne" ? examTypeOther.trim() : examType.trim();
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
    <Stack spacing={3}>
      <Stack direction="row" spacing={2} alignItems="center">
        <SecondaryButton
          component={Link}
          href={patientId ? `/patients/${patientId}` : "/patients"}
        >
          ← Wróć do pacjenta
        </SecondaryButton>
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Nowe badanie
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Wybierz typ badania i rozpocznij dokumentację.
          </Typography>
        </Box>
      </Stack>

      <SectionCard
        title="Typ badania"
        subtitle="Wybierz typ, aby rozpocząć. „Inne” pozwala wpisać własną nazwę."
        icon={<AddCircleOutlineIcon />}
        actions={
          <Typography variant="caption" color="text.secondary">
            {patientId ? `Pacjent: ${patientId}` : "Brak pacjenta"}
          </Typography>
        }
      >
        <FormStack component="form" onSubmit={onStart}>

          <Grid container spacing={2}>
            {EXAM_TYPES.map((t) => {
              const active = examType === t;

              return (
                <Grid item xs={12} sm={6} key={t}>
                  <Box
                    component="button"
                    type="button"
                    onClick={() => setExamType(t)}
                    aria-pressed={active}
                    sx={{
                      width: "100%",
                      textAlign: "left",
                      p: 2,
                      borderRadius: 3,
                      border: "1px solid",
                      borderColor: active ? "primary.main" : "divider",
                      backgroundColor: active
                        ? "rgba(29, 78, 216, 0.06)"
                        : "background.paper",
                      transition: "all 150ms ease",
                      "&:hover": {
                        borderColor: "primary.light",
                        boxShadow: "0 10px 24px rgba(15, 23, 42, 0.08)",
                      },
                    }}
                  >
                    <Stack direction="row" spacing={2} alignItems="flex-start">
                      <Box sx={{ flex: 1 }}>
                        <Typography fontWeight={600}>{t}</Typography>
                        <Typography variant="caption" color="text.secondary">
                          {t === "Inne" ? "Wpisz własny typ badania" : "Szybki start"}
                        </Typography>
                      </Box>
                      <Box
                        sx={{
                          width: 20,
                          height: 20,
                          borderRadius: "50%",
                          border: "1px solid",
                          borderColor: active ? "primary.main" : "divider",
                          bgcolor: active ? "primary.main" : "transparent",
                          color: "white",
                          display: "grid",
                          placeItems: "center",
                          fontSize: 12,
                        }}
                      >
                        {active ? "✓" : ""}
                      </Box>
                    </Stack>
                  </Box>
                </Grid>
              );
            })}
          </Grid>

          {examType === "Inne" && (
            <Paper variant="outlined" sx={{ p: 2, bgcolor: "background.default" }}>
              <Stack spacing={1}>
                <Typography fontWeight={600} variant="body2">
                  Nazwa badania
                </Typography>
                <TextField
                  value={examTypeOther}
                  onChange={(e) => setExamTypeOther(e.target.value)}
                  placeholder="np. USG tarczycy"
                  fullWidth
                />
                <Typography variant="caption" color="text.secondary">
                  Wpisz krótko i rzeczowo, np. „USG tarczycy”.
                </Typography>
              </Stack>
            </Paper>
          )}

          {error && (
            <Paper
              variant="outlined"
              sx={{ p: 2, borderColor: "error.light", bgcolor: "error.50" }}
            >
              <Typography fontWeight={600}>Błąd</Typography>
              <Typography variant="body2" sx={{ mt: 1 }}>
                {error}
              </Typography>
            </Paper>
          )}

          <Stack
            direction={{ xs: "column", sm: "row" }}
            spacing={2}
            justifyContent="space-between"
            alignItems={{ sm: "center" }}
          >
            <PrimaryButton type="submit" disabled={!canSubmit}>
              {saving ? "Tworzenie…" : "Start badania"}
            </PrimaryButton>
            <Typography variant="caption" color="text.secondary">
              Zapiszemy szkic badania w:{" "}
              <Box component="span" sx={{ fontFamily: "monospace" }}>
                patients/{patientId || ":id"}/exams
              </Box>
            </Typography>
          </Stack>
        </FormStack>
      </SectionCard>
    </Stack>
  );
}

"use client";

import { useEffect, useMemo, useState } from "react";
import Link from "next/link";
import { useParams } from "next/navigation";
import { Box, Chip, Grid, Paper, Stack, Typography } from "@mui/material";
import SectionCard from "@/app/_components/SectionCard";
import { PrimaryButton, SecondaryButton } from "@/app/_components/Buttons";
import AssignmentOutlinedIcon from "@mui/icons-material/AssignmentOutlined";
import PetsOutlinedIcon from "@mui/icons-material/PetsOutlined";
import {
  collection,
  doc,
  getDoc,
  getDocs,
  orderBy,
  query,
  Timestamp,
} from "firebase/firestore";
import { db } from "@/lib/firebase/client";
import { getMyClinicId } from "@/lib/firebase/user";

type Patient = {
  id: string;
  clinicId: string;
  name?: string;
  species?: string;
  breed?: string | null;
  ownerName?: string | null;
};

type ExamListItem = {
  id: string;
  type?: string;
  status?: string;
  createdAt?: Timestamp | null;
};

function statusLabel(status?: string) {
  const s = (status || "draft").toLowerCase();
  if (s === "in_progress") return "w trakcie";
  if (s === "done") return "zakończone";
  return "szkic";
}

function statusChipColor(status?: string) {
  const s = (status || "draft").toLowerCase();
  if (s === "in_progress") return "warning";
  if (s === "done") return "success";
  return "default";
}

export default function PatientDetailsPage() {
  const params = useParams<{ id: string | string[] }>();

  const patientId = useMemo(() => {
    const raw = params?.id;
    if (!raw) return "";
    return Array.isArray(raw) ? raw[0] : raw;
  }, [params]);

  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>("");

  const [patient, setPatient] = useState<Patient | null>(null);

  const [examsLoading, setExamsLoading] = useState(false);
  const [examsError, setExamsError] = useState<string>("");
  const [exams, setExams] = useState<ExamListItem[]>([]);

  useEffect(() => {
    if (!patientId) return;

    let cancelled = false;

    (async () => {
      try {
        setLoading(true);
        setError("");
        setPatient(null);

        setExamsLoading(true);
        setExamsError("");
        setExams([]);

        const clinicId = await getMyClinicId();
        if (cancelled) return;

        // 1) Pacjent
        const patientRef = doc(db, "patients", patientId);
        const patientSnap = await getDoc(patientRef);

        if (!patientSnap.exists()) {
          setError("Nie znaleziono pacjenta.");
          return;
        }

        const p = patientSnap.data() as any;

        if (p?.clinicId && p.clinicId !== clinicId) {
          setError("Brak dostępu do tego pacjenta (inna klinika).");
          return;
        }

        setPatient({
          id: patientSnap.id,
          clinicId: p?.clinicId,
          name: p?.name,
          species: p?.species,
          breed: p?.breed ?? null,
          ownerName: p?.ownerName ?? null,
        });

        // 2) Badania
        const examsQ = query(
          collection(db, "patients", patientId, "exams"),
          orderBy("createdAt", "desc")
        );
        const examsSnap = await getDocs(examsQ);
        if (cancelled) return;

        const examRows = examsSnap.docs.map((d) => {
          const data = d.data() as any;
          return {
            id: d.id,
            type: data?.type,
            status: data?.status,
            createdAt: (data?.createdAt as Timestamp) ?? null,
          } satisfies ExamListItem;
        });

        setExams(examRows);
      } catch (e: any) {
        console.error(e);
        setError(e?.message || String(e));
      } finally {
        if (!cancelled) {
          setLoading(false);
          setExamsLoading(false);
        }
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [patientId]);

  const examNewHref = patientId ? `/patients/${patientId}/exams/new` : "/patients";

  return (
    <Stack spacing={3}>
      <Stack
        direction={{ xs: "column", sm: "row" }}
        spacing={2}
        justifyContent="space-between"
      >
        <Stack direction="row" spacing={2} alignItems="center">
          <SecondaryButton component={Link} href="/patients" variant="text">
            ← Wróć
          </SecondaryButton>
          <Box>
            <Typography variant="h5" fontWeight={700}>
              Karta pacjenta
            </Typography>
            <Typography variant="body2" color="text.secondary">
              Dane pacjenta i lista badań.
            </Typography>
          </Box>
        </Stack>

        <PrimaryButton component={Link} href={examNewHref}>
          Rozpocznij badanie
        </PrimaryButton>
      </Stack>

      {/* Alerts */}
      {loading && (
        <Paper variant="outlined" sx={{ p: 3 }}>
          <Typography variant="body2">Ładowanie…</Typography>
        </Paper>
      )}
      {error && !loading && (
        <Paper
          variant="outlined"
          sx={{ p: 3, borderColor: "error.light", bgcolor: "error.50" }}
        >
          <Typography fontWeight={600}>Błąd</Typography>
          <Typography variant="body2" sx={{ mt: 1 }}>
            {error}
          </Typography>
        </Paper>
      )}

      {!loading && !error && patient && (
        <Grid container spacing={3}>
          {/* Patient card */}
          <Grid item xs={12} lg={4}>
            <SectionCard
              title="Pacjent"
              subtitle="Najważniejsze dane pacjenta."
              icon={<PetsOutlinedIcon />}
              fullHeight
            >
              <Box>
                <Typography variant="h6" fontWeight={700}>
                  {patient.name?.trim() || "Bez imienia"}
                </Typography>

                <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                  {(patient.species?.trim() || "nieznany gatunek") +
                    (patient.breed?.toString().trim()
                      ? ` • ${patient.breed.toString().trim()}`
                      : "")}
                </Typography>

                {patient.ownerName?.toString().trim() ? (
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 1.5 }}>
                    <Box component="span" color="text.disabled">
                      Właściciel:
                    </Box>{" "}
                    {patient.ownerName.toString().trim()}
                  </Typography>
                ) : null}

                <Paper variant="outlined" sx={{ mt: 2, p: 2, bgcolor: "background.default" }}>
                  <Typography variant="caption" color="text.secondary">
                    ID
                  </Typography>
                  <Typography
                    variant="caption"
                    sx={{ display: "block", mt: 0.5, fontFamily: "monospace" }}
                  >
                    {patient.id}
                  </Typography>
                </Paper>
              </Box>
            </SectionCard>
          </Grid>

          {/* Exams */}
          <Grid item xs={12} lg={8}>
            <SectionCard
              title="Badania"
              subtitle="Kliknij badanie, aby wejść do nagrania i raportu."
              icon={<AssignmentOutlinedIcon />}
              fullHeight
            >

              {examsLoading && (
                <Typography variant="body2" color="text.secondary" sx={{ mt: 1 }}>
                  Ładowanie badań…
                </Typography>
              )}
              {examsError && !examsLoading && (
                <Paper
                  variant="outlined"
                  sx={{ mt: 1, p: 2, borderColor: "error.light", bgcolor: "error.50" }}
                >
                  <Typography fontWeight={600}>Błąd</Typography>
                  <Typography variant="body2" sx={{ mt: 1 }}>
                    {examsError}
                  </Typography>
                </Paper>
              )}

              {!examsLoading && !examsError && exams.length === 0 && (
                <Paper
                  variant="outlined"
                  sx={{ mt: 1, p: 2, bgcolor: "background.default" }}
                >
                  <Typography fontWeight={600}>Brak badań</Typography>
                  <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
                    Utwórz pierwsze badanie, aby rozpocząć dokumentowanie wizyty.
                  </Typography>
                </Paper>
              )}

              {!examsLoading && !examsError && exams.length > 0 && (
                <Stack spacing={2} sx={{ mt: 1 }}>
                  {exams.map((ex) => (
                    <Paper
                      key={ex.id}
                      component={Link}
                      href={`/patients/${patientId}/exams/${ex.id}`}
                      variant="outlined"
                      sx={{
                        p: 2,
                        textDecoration: "none",
                        display: "block",
                        transition: "all 150ms ease",
                        "&:hover": {
                          borderColor: "primary.light",
                          boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
                        },
                      }}
                    >
                      <Stack
                        direction={{ xs: "column", sm: "row" }}
                        spacing={2}
                        justifyContent="space-between"
                        alignItems={{ sm: "center" }}
                      >
                        <Box sx={{ minWidth: 0 }}>
                          <Typography fontWeight={600}>
                            {(ex.type || "Badanie").toString()}
                          </Typography>

                          <Stack direction="row" spacing={1} sx={{ mt: 1 }} alignItems="center">
                            <Chip
                              size="small"
                              label={statusLabel(ex.status)}
                              color={statusChipColor(ex.status)}
                              variant="outlined"
                            />
                            <Typography variant="caption" color="text.secondary">
                              {ex.createdAt
                                ? ex.createdAt.toDate().toLocaleString()
                                : ""}
                            </Typography>
                          </Stack>
                        </Box>

                        <Typography color="text.disabled">→</Typography>
                      </Stack>
                    </Paper>
                  ))}
                </Stack>
              )}
            </SectionCard>
          </Grid>
        </Grid>
      )}
    </Stack>
  );
}

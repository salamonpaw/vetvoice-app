"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Box, Chip, Grid, Paper, Stack, TextField, Typography } from "@mui/material";
import { PrimaryButton } from "@/app/_components/Buttons";
import SectionCard from "@/app/_components/SectionCard";
import PeopleAltOutlinedIcon from "@mui/icons-material/PeopleAltOutlined";
import PersonSearchOutlinedIcon from "@mui/icons-material/PersonSearchOutlined";
import SearchOutlinedIcon from "@mui/icons-material/SearchOutlined";
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
  const [queryText, setQueryText] = useState("");

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

  const filteredPatients = patients.filter((p) => {
    const q = queryText.trim().toLowerCase();
    if (!q) return true;
    const hay = [
      p.name,
      p.species,
      p.breed,
      p.ownerName,
      p.id,
    ]
      .map((v) => (v || "").toString().toLowerCase())
      .join(" ");
    return hay.includes(q);
  });

  return (
    <Stack spacing={3}>
      <Stack direction={{ xs: "column", sm: "row" }} spacing={2} justifyContent="space-between">
        <Box>
          <Typography variant="h5" fontWeight={700}>
            Pacjenci
          </Typography>
          <Typography variant="body2" color="text.secondary">
            Zarządzaj kartami pacjentów i badaniami.
          </Typography>
        </Box>

        <Stack direction={{ xs: "column", sm: "row" }} spacing={1} alignItems={{ xs: "stretch", sm: "center" }}>
          <TextField
            value={queryText}
            onChange={(e) => setQueryText(e.target.value)}
            placeholder="Szukaj pacjenta..."
            size="small"
            InputProps={{
              startAdornment: (
                <Box sx={{ color: "text.secondary", mr: 1, display: "grid", placeItems: "center" }}>
                  <SearchOutlinedIcon fontSize="small" />
                </Box>
              ),
            }}
            sx={{ minWidth: { xs: "100%", sm: 260 } }}
          />
          <Chip
            label={`user.ts v${USER_TS_VERSION}`}
            size="small"
            variant="outlined"
          />
          <PrimaryButton
            component={Link}
            href="/patients/new"
            size="medium"
          >
            Dodaj pacjenta
          </PrimaryButton>
        </Stack>
      </Stack>

      {/* Loading / Error */}
      {loading && (
        <SectionCard
          title="Ładowanie"
          subtitle="Pobieranie listy pacjentów."
          icon={<PersonSearchOutlinedIcon />}
        >
          <Typography variant="body2">Ładowanie…</Typography>
        </SectionCard>
      )}

      {error && !loading && (
        <Paper
          variant="outlined"
          sx={{ p: 3, borderColor: "error.light", bgcolor: "error.50" }}
        >
          <Typography fontWeight={600}>Błąd</Typography>
          <Typography variant="body2" sx={{ mt: 1, whiteSpace: "pre-wrap" }}>
            {error}
          </Typography>
        </Paper>
      )}

      {/* Empty */}
      {!loading && !error && patients.length === 0 && (
        <SectionCard
          title="Brak pacjentów"
          subtitle="Dodaj pierwszego pacjenta, aby rozpocząć pracę."
          icon={<PeopleAltOutlinedIcon />}
        >
          <Typography variant="body2" color="text.secondary">
            Użyj przycisku „Dodaj pacjenta”.
          </Typography>
        </SectionCard>
      )}

      {/* List */}
      {!loading && !error && patients.length > 0 && (
        <SectionCard
          title="Lista pacjentów"
          subtitle="Kliknij pacjenta, aby przejść do karty i badań."
          icon={<PeopleAltOutlinedIcon />}
        >
          {filteredPatients.length === 0 ? (
            <Typography variant="body2" color="text.secondary">
              Brak wyników dla „{queryText}”.
            </Typography>
          ) : (
            <Grid container spacing={2}>
              {filteredPatients.map((p) => {
                const name = (p.name || "").trim() || "Bez imienia";
                const species = (p.species || "").trim() || "nieznany gatunek";
                const breed = (p.breed || "").toString().trim();
                const ownerName = (p.ownerName || "").toString().trim();

                return (
                  <Grid key={p.id} item xs={12} sm="auto" md="auto">
                    <Paper
                      component={Link}
                      href={`/patients/${p.id}`}
                      variant="outlined"
                      sx={{
                        p: 2,
                        textDecoration: "none",
                        display: "flex",
                        flexDirection: "column",
                        gap: 1,
                        width: { xs: "100%", sm: 160 },
                        height: 160,
                        overflow: "hidden",
                        transition: "all 150ms ease",
                        "&:hover": {
                          borderColor: "primary.light",
                          boxShadow: "0 12px 30px rgba(15, 23, 42, 0.08)",
                        },
                      }}
                    >
                      <Typography fontWeight={700} sx={{ lineHeight: 1.2, wordBreak: "break-word" }}>
                        {name}
                      </Typography>
                      <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-word" }}>
                        {species}
                        {breed ? ` • ${breed}` : ""}
                      </Typography>
                      {ownerName ? (
                        <Typography variant="body2" color="text.secondary" sx={{ wordBreak: "break-word" }}>
                          <Box component="span" color="text.disabled">
                            Właściciel:
                          </Box>{" "}
                          {ownerName}
                        </Typography>
                      ) : null}
                      <Box sx={{ mt: "auto", color: "text.disabled" }}>→</Box>
                    </Paper>
                  </Grid>
                );
              })}
            </Grid>
          )}
        </SectionCard>
      )}
    </Stack>
  );
}

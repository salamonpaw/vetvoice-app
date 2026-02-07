"use client";

import { Box, Chip, Divider, Grid, Stack, Typography } from "@mui/material";
import Link from "next/link";
import { PrimaryButton, SecondaryButton } from "@/app/_components/Buttons";

export default function Home() {
  return (
    <Box>
      <Grid container spacing={4} alignItems="center">
        <Grid item xs={12} md={6}>
          <Stack spacing={3}>
            <Stack direction="row" spacing={1} alignItems="center">
              <Chip label="Nowy standard dokumentacji" color="secondary" />
              <Chip label="PL • PoC" variant="outlined" />
            </Stack>
            <Typography variant="h3" component="h1">
              VetVoice usprawnia dokumentację badań weterynaryjnych
            </Typography>
            <Typography variant="body1" color="text.secondary">
              Kompletny proces od nagrania, przez transkrypcję, po raport i
              wnioski. W jednym miejscu, z dbałością o spójność i jakość danych.
            </Typography>
            <Stack direction={{ xs: "column", sm: "row" }} spacing={2}>
              <PrimaryButton
                component={Link}
                href="/patients"
                size="large"
              >
                Przejdź do pacjentów
              </PrimaryButton>
              <SecondaryButton
                component={Link}
                href="/patients/new"
                size="large"
              >
                Dodaj pacjenta
              </SecondaryButton>
            </Stack>
          </Stack>
        </Grid>
        <Grid item xs={12} md={6}>
          <Box
            sx={{
              borderRadius: 4,
              border: "1px solid #e4ecff",
              background:
                "linear-gradient(135deg, rgba(29,78,216,0.08) 0%, rgba(14,165,233,0.12) 60%, rgba(255,255,255,1) 100%)",
              p: { xs: 2.5, md: 3.5 },
            }}
          >
            <Stack spacing={2.5}>
              <Typography variant="h6">Szybki start</Typography>
              <Divider />
              <Stack spacing={2}>
                <Box>
                  <Typography fontWeight={600}>1. Dodaj pacjenta</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Stwórz profil pacjenta i rozpocznij nowe badanie.
                  </Typography>
                </Box>
                <Box>
                  <Typography fontWeight={600}>2. Dodaj nagranie</Typography>
                  <Typography variant="body2" color="text.secondary">
                    System przygotuje transkrypcję i wstępne dane.
                  </Typography>
                </Box>
                <Box>
                  <Typography fontWeight={600}>3. Zweryfikuj raport</Typography>
                  <Typography variant="body2" color="text.secondary">
                    Edytuj raport i zapisz finalną wersję badania.
                  </Typography>
                </Box>
              </Stack>
            </Stack>
          </Box>
        </Grid>
      </Grid>
    </Box>
  );
}

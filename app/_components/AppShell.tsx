"use client";

import {
  AppBar,
  Box,
  Button,
  Chip,
  Container,
  Stack,
  Toolbar,
  Typography,
} from "@mui/material";
import Link from "next/link";

type Props = {
  children: React.ReactNode;
};

export default function AppShell({ children }: Props) {
  return (
    <Box
      sx={{
        minHeight: "100vh",
        background:
          "linear-gradient(180deg, rgba(245,248,255,1) 0%, rgba(255,255,255,1) 45%, rgba(245,248,255,1) 100%)",
        position: "relative",
        overflow: "hidden",
      }}
    >
      <Box
        aria-hidden
        sx={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(60% 40% at 10% 0%, rgba(96,165,250,0.20) 0%, rgba(96,165,250,0) 70%), radial-gradient(50% 30% at 90% 10%, rgba(14,165,233,0.15) 0%, rgba(14,165,233,0) 65%)",
          pointerEvents: "none",
        }}
      />

      <AppBar position="sticky">
        <Toolbar sx={{ gap: 2, flexWrap: "wrap" }}>
          <Stack direction="row" spacing={1} alignItems="center">
            <Box
              sx={{
                width: 36,
                height: 36,
                borderRadius: "12px",
                background:
                  "linear-gradient(135deg, #1d4ed8 0%, #0ea5e9 100%)",
                display: "grid",
                placeItems: "center",
                color: "white",
                fontWeight: 700,
                letterSpacing: "-0.02em",
              }}
            >
              VV
            </Box>
            <Box>
              <Typography variant="h6">VetVoice</Typography>
              <Typography variant="caption" color="text.secondary">
                Dokumentacja badań weterynaryjnych
              </Typography>
            </Box>
          </Stack>

          <Stack
            direction="row"
            spacing={1}
            sx={{ ml: "auto", flexWrap: "wrap" }}
          >
            <Button component={Link} href="/" color="primary">
              Panel
            </Button>
            <Button component={Link} href="/patients" color="primary">
              Pacjenci
            </Button>
            <Button component={Link} href="/patients/new" color="primary">
              Nowy pacjent
            </Button>
            <Button component={Link} href="/firebase-test" color="primary">
              Test Firebase
            </Button>
            <Chip label="PoC" color="secondary" size="small" />
          </Stack>
        </Toolbar>
      </AppBar>

      <Container
        maxWidth={false}
        sx={{
          position: "relative",
          py: { xs: 3, md: 5 },
          px: { xs: 2, sm: 3, md: 4 },
          mx: "auto",
          maxWidth: { xs: "100%", lg: "1440px", xl: "1600px" },
          "@media (min-width:1920px)": {
            maxWidth: "1760px",
          },
        }}
      >
        <Box
          sx={{
            backgroundColor: "rgba(255,255,255,0.92)",
            backdropFilter: "blur(6px)",
            borderRadius: { xs: 2, md: 3 },
            border: "1px solid #e4ecff",
            boxShadow:
              "0 20px 60px rgba(15, 23, 42, 0.08), 0 4px 10px rgba(30, 64, 175, 0.08)",
            px: { xs: 2, md: 4 },
            py: { xs: 2, md: 4 },
          }}
        >
          {children}
        </Box>
      </Container>
    </Box>
  );
}

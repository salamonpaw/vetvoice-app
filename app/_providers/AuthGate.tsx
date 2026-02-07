"use client";

import React, { useEffect, useMemo, useState } from "react";
import {
  Alert,
  Box,
  Button,
  Checkbox,
  FormControlLabel,
  Paper,
  Stack,
  TextField,
  Typography,
} from "@mui/material";

type Props = {
  children: React.ReactNode;
};

/**
 * PoC auth gate: login + PIN.
 * Uwaga: to nie jest produkcyjne bezpieczeństwo.
 */
export default function AuthGate({ children }: Props) {
  const [ready, setReady] = useState(false);
  const [authed, setAuthed] = useState(false);

  const [login, setLogin] = useState("");
  const [pin, setPin] = useState("");
  const [remember, setRemember] = useState(false);

  const [err, setErr] = useState("");

  // W PoC możesz trzymać to na sztywno.
  // Jak zechcesz lepiej: przeniesiemy do env (NEXT_PUBLIC_AUTH_LOGIN / NEXT_PUBLIC_AUTH_PIN)
  const AUTH_LOGIN = "alk@alk.pl";
  const AUTH_PIN = "Test123";

  const storage = useMemo(() => {
    if (typeof window === "undefined") return null;
    return remember ? window.localStorage : window.sessionStorage;
  }, [remember]);

  useEffect(() => {
    // sprawdź istniejącą sesję (najpierw localStorage, potem sessionStorage)
    try {
      const tokenLocal = window.localStorage.getItem("vv_auth");
      const tokenSession = window.sessionStorage.getItem("vv_auth");
      if (tokenLocal === "1" || tokenSession === "1") {
        setAuthed(true);
      }
    } catch {}
    setReady(true);
  }, []);

  function logout() {
    try {
      window.localStorage.removeItem("vv_auth");
      window.sessionStorage.removeItem("vv_auth");
    } catch {}
    setAuthed(false);
    setLogin("");
    setPin("");
    setErr("");
  }

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setErr("");

    const l = login.trim();
    const p = pin;

    if (!l || !p) {
      setErr("Podaj login i PIN.");
      return;
    }

    if (l !== AUTH_LOGIN || p !== AUTH_PIN) {
      setErr("Nieprawidłowy login lub PIN.");
      return;
    }

    try {
      // zapis sesji
      storage?.setItem("vv_auth", "1");
    } catch {}

    setAuthed(true);
  }

  if (!ready) {
    return <Box sx={{ minHeight: "100vh" }} />;
  }

  if (authed) {
    // Mały pasek u góry (opcjonalny, ale UX-owo wygodny)
    return (
      <Box>
        <Stack direction="row" justifyContent="flex-end" sx={{ mb: 2 }}>
          <Button variant="outlined" size="small" onClick={logout}>
            Wyloguj
          </Button>
        </Stack>
        {children}
      </Box>
    );
  }

  return (
    <Box
      sx={{
        minHeight: { xs: "70vh", md: "75vh" },
        display: "grid",
        placeItems: "center",
      }}
    >
      <Paper
        elevation={0}
        sx={{
          width: "100%",
          maxWidth: 420,
          p: 4,
          borderRadius: 3,
        }}
      >
        <Stack spacing={1} sx={{ mb: 3 }}>
          <Typography variant="h5" fontWeight={700}>
            Zaloguj się
          </Typography>
          <Typography variant="body2" color="text.secondary">
            VetVoice (PoC)
          </Typography>
        </Stack>

        {err ? (
          <Alert severity="error" sx={{ mb: 2 }}>
            {err}
          </Alert>
        ) : null}

        <Box component="form" onSubmit={onSubmit}>
          <Stack spacing={2}>
            <TextField
              label="Login"
              value={login}
              onChange={(e) => setLogin(e.target.value)}
              placeholder="np. alk@alk.pl"
              autoComplete="username"
              fullWidth
            />
            <TextField
              label="PIN"
              value={pin}
              onChange={(e) => setPin(e.target.value)}
              placeholder="••••••"
              type="password"
              autoComplete="current-password"
              fullWidth
            />
            <FormControlLabel
              control={
                <Checkbox
                  checked={remember}
                  onChange={(e) => setRemember(e.target.checked)}
                />
              }
              label="Zapamiętaj mnie"
            />
            <Button type="submit" variant="contained" size="large">
              Zaloguj
            </Button>
          </Stack>
        </Box>
      </Paper>
    </Box>
  );
}

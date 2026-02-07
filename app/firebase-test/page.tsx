"use client";

import { useEffect, useState } from "react";
import { Box, Stack, Typography } from "@mui/material";
import SectionCard from "@/app/_components/SectionCard";
import CloudDoneOutlinedIcon from "@mui/icons-material/CloudDoneOutlined";
import { auth, db } from "@/lib/firebase/client";
import { signInAnonymously } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

export default function FirebaseTestPage() {
  const [status, setStatus] = useState("start...");

  useEffect(() => {
    (async () => {
      try {
        setStatus("logowanie anonimowe...");
        const cred = await signInAnonymously(auth);

        setStatus("zapis do Firestore...");
        await setDoc(doc(db, "debug", cred.user.uid), {
          hello: "world",
          createdAt: serverTimestamp(),
        });

        setStatus("OK ✅ Firebase Auth + Firestore działają");
      } catch (e: any) {
        console.error(e);
        setStatus(`Błąd: ${e?.code || ""} ${e?.message || e}`);
      }
    })();
  }, []);

  return (
    <Stack spacing={3} sx={{ maxWidth: 720 }}>
      <Box>
        <Typography variant="h5" fontWeight={700}>
          Firebase test
        </Typography>
        <Typography variant="body2" color="text.secondary">
          Szybki test połączenia z Firebase Auth i Firestore.
        </Typography>
      </Box>

      <SectionCard title="Status połączenia" icon={<CloudDoneOutlinedIcon />}>
        <Typography variant="body2">{status}</Typography>
      </SectionCard>
    </Stack>
  );
}

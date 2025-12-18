"use client";

import { useEffect, useState } from "react";
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
    <div style={{ padding: 24, fontFamily: "system-ui" }}>
      <h1>Firebase test</h1>
      <p>{status}</p>
    </div>
  );
}

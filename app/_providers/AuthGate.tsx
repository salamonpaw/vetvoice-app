"use client";

import { useEffect, useState } from "react";
import { auth, db } from "@/lib/firebase/client";
import { onAuthStateChanged, signInAnonymously, User } from "firebase/auth";
import { doc, setDoc, serverTimestamp } from "firebase/firestore";

export default function AuthGate({ children }: { children: React.ReactNode }) {
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;

    const ensureUserProfile = async (user: User) => {
      // ZAWSZE zapewnij /users/{uid}
      const userRef = doc(db, "users", user.uid);

      await setDoc(
        userRef,
        {
          id: user.uid,
          role: "vet",
          clinicId: "demo-clinic",
          // createdAt ustaw tylko jeśli nie istnieje – ale merge i serverTimestamp są ok na demo
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp(),
        },
        { merge: true }
      );
    };

    const unsub = onAuthStateChanged(auth, async (user) => {
      try {
        // Jeśli nie ma usera, zaloguj anon
        if (!user) {
          const cred = await signInAnonymously(auth);
          user = cred.user;
        }

        await ensureUserProfile(user);
      } catch (e) {
        console.error("AuthGate error:", e);
      } finally {
        if (!cancelled) setReady(true);
      }
    });

    return () => {
      cancelled = true;
      unsub();
    };
  }, []);

  if (!ready) return <div style={{ padding: 24 }}>Ładowanie sesji...</div>;
  return <>{children}</>;
}

import { auth, db } from "./client";
import { doc, getDoc, setDoc, serverTimestamp } from "firebase/firestore";
import { onAuthStateChanged, User } from "firebase/auth";

export const USER_TS_VERSION = "2025-12-14-FINAL-FIX";

function waitForAuthUser(timeoutMs = 8000): Promise<User> {
  return new Promise((resolve, reject) => {
    const unsub = onAuthStateChanged(
      auth,
      (user) => {
        if (user) {
          unsub();
          resolve(user);
        }
      },
      (err) => {
        unsub();
        reject(err);
      }
    );

    setTimeout(() => {
      unsub();
      reject(new Error("Timeout auth"));
    }, timeoutMs);
  });
}

async function ensureUser(uid: string) {
  const ref = doc(db, "users", uid);
  const snap = await getDoc(ref);

  if (!snap.exists()) {
    await setDoc(
      ref,
      {
        id: uid,
        role: "vet",
        clinicId: "demo-clinic",
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp(),
      },
      { merge: true }
    );
  }

  return ref;
}

export async function getMyClinicId(): Promise<string> {
  const user = auth.currentUser ?? (await waitForAuthUser());
  const ref = await ensureUser(user.uid);
  const snap = await getDoc(ref);

  const data = snap.data() as any;
  return data?.clinicId ?? "demo-clinic";
}


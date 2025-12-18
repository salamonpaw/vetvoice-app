import { auth, db } from "./client";
import { doc, getDoc } from "firebase/firestore";
import { onAuthStateChanged, User } from "firebase/auth";

function waitForAuthUser(): Promise<User> {
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

    // zabezpieczenie: jeśli nic się nie stanie
    setTimeout(() => {
      unsub();
      reject(new Error("Timeout: nie udało się pobrać zalogowanego użytkownika."));
    }, 5000);
  });
}

export async function getMyClinicId(): Promise<string> {
  const user = auth.currentUser ?? (await waitForAuthUser());

  const snap = await getDoc(doc(db, "users", user.uid));
  if (!snap.exists()) {
    throw new Error("Brak profilu użytkownika w /users.");
  }

  const data = snap.data() as any;
  if (!data.clinicId) {
    throw new Error("Użytkownik nie ma clinicId.");
  }

  return data.clinicId as string;
}

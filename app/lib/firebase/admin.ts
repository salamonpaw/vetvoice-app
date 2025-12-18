import { cert, getApps, initializeApp } from "firebase-admin/app";
import { getFirestore } from "firebase-admin/firestore";

function getServiceAccount() {
  const raw = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
  if (!raw) throw new Error("Missing env FIREBASE_SERVICE_ACCOUNT_JSON");
  return JSON.parse(raw);
}

const app =
  getApps().length > 0
    ? getApps()[0]
    : initializeApp({ credential: cert(getServiceAccount()) });

export const adminDb = getFirestore(app);

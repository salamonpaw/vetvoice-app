import { initializeApp, getApps } from "firebase/app";
import { getAuth } from "firebase/auth";
import { getFirestore } from "firebase/firestore";
import { getStorage } from "firebase/storage";

const firebaseConfig = {
  apiKey: "AIzaSyCePSvJ54CR6G45wUe2T_DQ9ZclMt-3ipo",
  authDomain: "studio-6513862363-32617.firebaseapp.com",
  projectId: "studio-6513862363-32617",
  storageBucket: "studio-6513862363-32617.firebasestorage.app",
  messagingSenderId: "132096520516",
  appId: "1:132096520516:web:4160b7ba29d67fb2402711"
};

export const app =
  getApps().length > 0 ? getApps()[0] : initializeApp(firebaseConfig);

export const auth = getAuth(app);
export const db = getFirestore(app);
export const storage = getStorage(app);


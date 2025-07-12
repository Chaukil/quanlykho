// Import Firebase modules
import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import { getAuth } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-auth.js';
import { getFirestore } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

// Firebase configuration
const firebaseConfig = {
  apiKey: "AIzaSyBVBzFLMK36nU1MfwF4P3seE2QpKkI0Oz8",
  authDomain: "quankho-c81a1.firebaseapp.com",
  projectId: "quankho-c81a1",
  storageBucket: "quankho-c81a1.firebasestorage.app",
  messagingSenderId: "64582787796",
  appId: "1:64582787796:web:455047396c827997445141",
  measurementId: "G-1M9HXEW3GQ"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// Export app for other modules
export default app;

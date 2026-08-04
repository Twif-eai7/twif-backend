// File: ../firebaseConfig.js

const admin = require("firebase-admin");
const dotenv = require("dotenv");
dotenv.config();

// Firebase is currently only used by the Shopify customer/mobile-app route
// (routes/customers.js). It's optional for the rest of the backend, so a
// missing SERVICE credential no longer crashes the whole server — routes
// that depend on `db`/Firebase Auth will simply fail at call time until
// SERVICE is configured.
let db = null;

if (!process.env.SERVICE) {
  console.warn("Firebase SERVICE environment variable is not set — Firebase/Firestore features are disabled.");
} else {
  try {
    const serviceAccountJson = Buffer.from(process.env.SERVICE, "base64").toString("utf8");
    const serviceAccount = JSON.parse(serviceAccountJson);

    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount),
        databaseId: '(default)' // Use '(default)' unless you have a specific named database
      });
    }

    db = admin.firestore();
    console.log("Firebase initialized and Firestore instance is ready.");
  } catch (err) {
    console.error("Failed to initialize Firebase from SERVICE env var — Firebase/Firestore features are disabled.", err.message);
  }
}

module.exports = { admin, db };
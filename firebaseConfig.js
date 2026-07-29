// File: ../firebaseConfig.js

const admin = require("firebase-admin");
const dotenv = require("dotenv");
dotenv.config();

// Make sure your SERVICE env variable is loaded
if (!process.env.SERVICE) {
  console.error("FATAL ERROR: Firebase SERVICE environment variable is not defined.");
  // Exit the process if the key is missing, to prevent silent failures
  process.exit(1); 
}

const serviceAccountJson = Buffer.from(process.env.SERVICE, "base64").toString("utf8");
const serviceAccount = JSON.parse(serviceAccountJson);

// Initialize Firebase Admin SDK if not already initialized
if (!admin.apps.length) {
  admin.initializeApp({
    credential: admin.credential.cert(serviceAccount),
    databaseId: '(default)' // Use '(default)' unless you have a specific named database
  });
}

// ✅ Get the Firestore instance
const db = admin.firestore();

console.log("Firebase initialized and Firestore instance is ready.");

// ✅ Export the db object so other files can import it
module.exports = { admin,db };
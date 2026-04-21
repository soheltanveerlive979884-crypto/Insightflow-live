import express from "express";
import { createServer as createViteServer } from "vite";
import path from "path";
import { fileURLToPath } from "url";
import { performSearch } from "./src/lib/gemini"; 
import admin from 'firebase-admin';
import { getFirestore } from 'firebase-admin/firestore';
import fs from 'fs';
import Razorpay from 'razorpay';
import crypto from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

async function startServer() {
  const app = express();
  const PORT = 3000;

  app.use(express.json());

  // Initialize Firebase Admin
  const firebaseConfigPath = path.join(__dirname, 'firebase-applet-config.json');
  let db: any = null;
  
  if (fs.existsSync(firebaseConfigPath)) {
    try {
      const firebaseConfig = JSON.parse(fs.readFileSync(firebaseConfigPath, 'utf8'));
      
      // Initialize admin
      admin.initializeApp({
        projectId: firebaseConfig.projectId
      });
      
      // Properly getting the named database for 2nd Gen Firestore
      db = getFirestore(firebaseConfig.firestoreDatabaseId);
      
      console.log("Firebase Admin initialized on server with database:", firebaseConfig.firestoreDatabaseId);
    } catch (err) {
      console.error("Failed to initialize Firebase Admin:", err);
    }
  }

  // Health check
  app.get("/api/health", (req, res) => {
    res.json({ status: "ok" });
  });

  // Background Tasks API
  app.post("/api/tasks", async (req, res) => {
    const { userId, query, model, persona, useDeepThinking, media } = req.body;
    
    if (!userId || !query || !db) {
      return res.status(400).json({ 
        error: !db ? "Firebase Admin not initialized on server" : "Missing required fields" 
      });
    }

    const taskId = `task_${Date.now()}`;

    // 1. Create the task in "pending" state using Admin SDK (bypasses rules)
    try {
      await db.collection("users").doc(userId).collection("tasks").doc(taskId).set({
        id: taskId,
        query,
        status: "pending",
        createdAt: new Date().toISOString(),
        progress: 0
      });

      // 2. Return immediately to the client
      res.json({ taskId });

      // 3. Process in background (async)
      console.log(`Starting background task ${taskId} for user ${userId}`);
      
      (async () => {
        try {
          const result = await performSearch(query, (chunk) => {
            // Optional: update progress or partials if needed
          }, media, model, persona, useDeepThinking);

          await db!.collection("users").doc(userId).collection("tasks").doc(taskId).update({
            status: "completed",
            result,
            completedAt: new Date().toISOString(),
            progress: 100
          });
          
          console.log(`Task ${taskId} completed`);
        } catch (error: any) {
          console.error(`Task ${taskId} failed:`, error);
          await db!.collection("users").doc(userId).collection("tasks").doc(taskId).update({
            status: "failed",
            error: error.message || "Unknown error during background generation",
            progress: 0
          });
        }
      })();

    } catch (e: any) {
      console.error("Error starting task:", e);
      res.status(500).json({ error: e.message });
    }
  });

  // --- Razorpay & Admin Settings ---
  
  const getRazorpayInstance = async () => {
    if (!db) return null;
    const settings = await db.collection("system").doc("settings").get();
    const data = settings.data();
    if (data?.razorpay_key_id && data?.razorpay_key_secret) {
      return new Razorpay({
        key_id: data.razorpay_key_id,
        key_secret: data.razorpay_key_secret,
      });
    }
    // Fallback to env if set
    if (process.env.RAZORPAY_KEY_ID && process.env.RAZORPAY_KEY_SECRET) {
      return new Razorpay({
        key_id: process.env.RAZORPAY_KEY_ID,
        key_secret: process.env.RAZORPAY_KEY_SECRET,
      });
    }
    return null;
  };

  app.get("/api/pay-config", async (req, res) => {
    if (!db) return res.status(500).json({ error: "DB not ready" });
    const settings = await db.collection("system").doc("settings").get();
    const data = settings.data();
    res.json({ 
      hasKeys: !!(data?.razorpay_key_id || process.env.RAZORPAY_KEY_ID),
      keyId: data?.razorpay_key_id || process.env.RAZORPAY_KEY_ID || null
    });
  });

  app.post("/api/create-order", async (req, res) => {
    const { amount, currency = "INR" } = req.body;
    try {
      const razorpay = await getRazorpayInstance();
      if (!razorpay) return res.status(500).json({ error: "Razorpay not configured" });

      const options = {
        amount: amount * 100, // amount in the smallest currency unit
        currency,
        receipt: `receipt_${Date.now()}`,
      };
      
      const order = await razorpay.orders.create(options);
      res.json(order);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/verify-payment", async (req, res) => {
    const { razorpay_order_id, razorpay_payment_id, razorpay_signature, userId, plan } = req.body;
    
    try {
      const settings = await db!.collection("system").doc("settings").get();
      const secret = settings.data()?.razorpay_key_secret || process.env.RAZORPAY_KEY_SECRET;
      
      const hmac = crypto.createHmac('sha256', secret);
      hmac.update(razorpay_order_id + "|" + razorpay_payment_id);
      const generated_signature = hmac.digest('hex');
      
      if (generated_signature === razorpay_signature) {
        // Payment verified! Update user status in Firestore
        await db!.collection("users").doc(userId).update({
          isPro: true,
          plan: plan,
          subscriptionDate: new Date().toISOString()
        });
        res.json({ status: "success" });
      } else {
        res.status(400).json({ status: "verification_failed" });
      }
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  app.post("/api/admin/save-settings", async (req, res) => {
    const { razorpay_key_id, razorpay_key_secret, adminEmail } = req.body;
    
    // Simple admin check
    const allowedAdmins = ["admin@example.com", "soheltanveerlive979884@gmail.com"];
    if (!allowedAdmins.includes(adminEmail?.toLowerCase())) {
      return res.status(403).json({ error: "Unauthorized" });
    }

    try {
      await db!.collection("system").doc("settings").set({
        razorpay_key_id,
        razorpay_key_secret,
        updatedAt: new Date().toISOString()
      }, { merge: true });
      
      res.json({ status: "success" });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  });

  // Vite middleware for development
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on http://localhost:${PORT}`);
  });
}

startServer();

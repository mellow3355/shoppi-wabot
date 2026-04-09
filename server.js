// API REST + boot del WA bot multi-tenant.
// Auth: verifica Firebase ID token (Authorization: Bearer <idToken>) y chequea
// que el user este mapeado a ese tenantId via userTenantMap (igual que admin.html).

const express = require("express");
const cors = require("cors");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");
const { getFirestore } = require("firebase-admin/firestore");
const { startTenant, stopTenant, getStatus, bootAll } = require("./waManager");

initializeApp();

const app = express();
app.use(cors({ origin: true }));
app.use(express.json());

async function authMiddleware(req, res, next) {
  try {
    const authHeader = req.headers.authorization || "";
    const m = authHeader.match(/^Bearer (.+)$/);
    if (!m) return res.status(401).json({ error: "missing token" });
    const decoded = await getAuth().verifyIdToken(m[1]);
    req.user = decoded;
    next();
  } catch (e) {
    res.status(401).json({ error: "invalid token: " + e.message });
  }
}

// Verifica que el user este vinculado al tenantId solicitado.
// userTenantMap/{email}.tenantId === req.params.id
async function tenantAuthMiddleware(req, res, next) {
  try {
    const email = req.user.email;
    if (!email) return res.status(403).json({ error: "user without email" });
    const db = getFirestore();
    const map = await db.collection("userTenantMap").doc(email).get();
    if (!map.exists) return res.status(403).json({ error: "user not mapped to any tenant" });
    const userTenantId = map.data().tenantId;
    if (userTenantId !== req.params.id) {
      return res.status(403).json({ error: "user not authorized for this tenant" });
    }
    next();
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
}

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post("/tenants/:id/start", authMiddleware, tenantAuthMiddleware, async (req, res) => {
  try {
    await startTenant(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tenants/:id/stop", authMiddleware, tenantAuthMiddleware, async (req, res) => {
  await stopTenant(req.params.id);
  res.json({ ok: true });
});

app.get("/tenants/:id/status", authMiddleware, tenantAuthMiddleware, (req, res) => {
  res.json(getStatus(req.params.id));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`shoppi-wabot listening on :${PORT}`);
  bootAll().catch(e => console.error("bootAll failed:", e.message));
});

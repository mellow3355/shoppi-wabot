// API REST + boot del WA bot multi-tenant.
// Endpoints (todos requieren X-Admin-Token salvo /health):
//   POST /tenants/:id/start
//   POST /tenants/:id/stop
//   GET  /tenants/:id/status
//   GET  /health

const express = require("express");
const cors = require("cors");
const { initializeApp } = require("firebase-admin/app");
const { startTenant, stopTenant, getStatus, bootAll } = require("./waManager");

initializeApp();

const app = express();
app.use(cors());
app.use(express.json());

const ADMIN_TOKEN = process.env.ADMIN_TOKEN || "changeme";

function requireAdmin(req, res, next) {
  if (req.headers["x-admin-token"] !== ADMIN_TOKEN) {
    return res.status(401).json({ error: "unauthorized" });
  }
  next();
}

app.get("/health", (req, res) => res.json({ ok: true, ts: Date.now() }));

app.post("/tenants/:id/start", requireAdmin, async (req, res) => {
  try {
    await startTenant(req.params.id);
    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

app.post("/tenants/:id/stop", requireAdmin, async (req, res) => {
  await stopTenant(req.params.id);
  res.json({ ok: true });
});

app.get("/tenants/:id/status", requireAdmin, (req, res) => {
  res.json(getStatus(req.params.id));
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => {
  console.log(`shoppi-wabot listening on :${PORT}`);
  bootAll().catch(e => console.error("bootAll failed:", e.message));
});

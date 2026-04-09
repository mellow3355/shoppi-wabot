// Maneja una instancia de whatsapp-web.js por tenant.
// Cada tenant tiene su propio Client + sesion + estado (qr, ready, etc.).

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const path = require("path");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { generateReply, welcomeMessage } = require("./llm");

const SESSIONS_DIR = process.env.SESSIONS_DIR || "/tmp/wa-sessions";

// Map<tenantId, { client, status, qrDataUrl, tenant }>
const instances = new Map();

// In-memory historia de chat por (tenantId + chatId). Se persiste a Firestore opcionalmente.
const chatHistory = new Map();
function histKey(tenantId, chatId) { return `${tenantId}:${chatId}`; }

async function loadTenant(tenantId) {
  const db = getFirestore();
  const tDoc = await db.collection("tenants").doc(tenantId).get();
  if (!tDoc.exists) throw new Error("tenant not found");
  const t = tDoc.data();

  const waSnap = await db.collection("tenants").doc(tenantId).collection("settings").doc("whatsapp").get();
  const wa = waSnap.exists ? waSnap.data() : {};

  return {
    id: tenantId,
    name: t.name || "Tienda",
    subdomain: t.subdomain || tenantId,
    customPrompt: wa.customPrompt || "",
    enabled: !!wa.enabled,
    onlyAfterHours: !!wa.onlyAfterHours, // si true, bot solo responde fuera de horario
    scheduleText: wa.scheduleText || "",
  };
}

async function isWithinBusinessHours(tenantId) {
  // Lee tenants/{id}/settings/schedule_default y verifica si el momento actual cae dentro
  try {
    const db = getFirestore();
    const snap = await db.collection("tenants").doc(tenantId).collection("settings").doc("schedule_default").get();
    if (!snap.exists) return false;
    const sched = snap.data();
    if (!sched.days || !Array.isArray(sched.days)) return false;
    if (sched.manualClosed) return false;

    const now = new Date(Date.now() - 4 * 60 * 60 * 1000); // UTC-4 Venezuela
    const dayIdx = (now.getUTCDay() + 6) % 7; // 0=Lunes
    const day = sched.days[dayIdx];
    if (!day || !day.active) return false;

    const hh = now.getUTCHours();
    const mm = now.getUTCMinutes();
    const cur = hh * 60 + mm;
    const [oh, om] = (day.open || "00:00").split(":").map(Number);
    const [ch, cm] = (day.close || "23:59").split(":").map(Number);
    return cur >= oh * 60 + om && cur <= ch * 60 + cm;
  } catch (e) {
    console.error("schedule check failed:", e.message);
    return false;
  }
}

async function logIncoming(tenantId, chatId, fromName, body) {
  try {
    const db = getFirestore();
    await db.collection("tenants").doc(tenantId).collection("waLogs").add({
      chatId,
      from: fromName,
      body,
      direction: "in",
      ts: FieldValue.serverTimestamp(),
    });
  } catch (e) { /* ignore */ }
}

async function logOutgoing(tenantId, chatId, body, kind) {
  try {
    const db = getFirestore();
    await db.collection("tenants").doc(tenantId).collection("waLogs").add({
      chatId,
      body,
      direction: "out",
      kind, // 'welcome' | 'llm' | 'manual'
      ts: FieldValue.serverTimestamp(),
    });
  } catch (e) { /* ignore */ }
}

async function shouldSendWelcome(tenantId, chatId) {
  // Welcome se manda solo si no hay welcome del mismo chat en las ultimas 12 horas
  const db = getFirestore();
  const since = Timestamp.fromMillis(Date.now() - 12 * 60 * 60 * 1000);
  const q = await db.collection("tenants").doc(tenantId).collection("waLogs")
    .where("chatId", "==", chatId)
    .where("kind", "==", "welcome")
    .where("ts", ">=", since)
    .limit(1)
    .get();
  return q.empty;
}

async function startTenant(tenantId) {
  if (instances.has(tenantId)) return instances.get(tenantId);

  const tenant = await loadTenant(tenantId);
  const inst = { tenant, status: "starting", qrDataUrl: null, client: null };
  instances.set(tenantId, inst);

  const client = new Client({
    authStrategy: new LocalAuth({
      clientId: tenantId,
      dataPath: SESSIONS_DIR,
    }),
    puppeteer: {
      headless: true,
      protocolTimeout: 240000, // 4 min — WA Web tarda en cargar en Cloud Run
      timeout: 180000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--single-process",
        "--disable-gpu",
      ],
    },
  });

  client.on("qr", async (qr) => {
    inst.status = "qr";
    inst.qrDataUrl = await qrcode.toDataURL(qr);
    console.log(`[${tenantId}] QR generado`);
  });

  client.on("ready", () => {
    inst.status = "ready";
    inst.qrDataUrl = null;
    console.log(`[${tenantId}] WA conectado`);
  });

  client.on("authenticated", () => {
    console.log(`[${tenantId}] autenticado`);
  });

  client.on("auth_failure", (m) => {
    inst.status = "auth_failure";
    console.error(`[${tenantId}] auth failure:`, m);
  });

  client.on("disconnected", (reason) => {
    inst.status = "disconnected";
    console.log(`[${tenantId}] desconectado:`, reason);
  });

  client.on("message", async (msg) => {
    try {
      // Ignorar mensajes propios, grupos, status
      if (msg.fromMe) return;
      if (msg.from.endsWith("@g.us")) return;
      if (msg.from === "status@broadcast") return;

      const fresh = await loadTenant(tenantId);
      if (!fresh.enabled) return;

      const chatId = msg.from;
      const body = (msg.body || "").trim();
      if (!body) return;

      const contact = await msg.getContact();
      const fromName = contact.pushname || contact.name || chatId;

      await logIncoming(tenantId, chatId, fromName, body);

      // 1. Mandar bienvenida si no se mando hoy
      const sendWelcome = await shouldSendWelcome(tenantId, chatId);
      if (sendWelcome) {
        const welcome = welcomeMessage(fresh);
        await sleep(800 + Math.random() * 1200);
        await msg.reply(welcome);
        await logOutgoing(tenantId, chatId, welcome, "welcome");
      }

      // 2. Si esta en horario y onlyAfterHours esta activado → calla, las chicas atienden
      if (fresh.onlyAfterHours) {
        const open = await isWithinBusinessHours(tenantId);
        if (open) {
          console.log(`[${tenantId}] en horario, no responde con LLM`);
          return;
        }
      }

      // 3. Generar respuesta con LLM
      const key = histKey(tenantId, chatId);
      const hist = chatHistory.get(key) || [];
      hist.push({ role: "user", content: body });

      const reply = await generateReply(fresh, hist);
      if (reply) {
        await sleep(1000 + Math.random() * 2000);
        await msg.reply(reply);
        hist.push({ role: "assistant", content: reply });
        chatHistory.set(key, hist.slice(-20));
        await logOutgoing(tenantId, chatId, reply, "llm");
      }
    } catch (err) {
      console.error(`[${tenantId}] error procesando mensaje:`, err.message);
    }
  });

  inst.client = client;
  client.initialize().catch(err => {
    console.error(`[${tenantId}] init error:`, err.message);
    inst.status = "error";
  });

  return inst;
}

async function stopTenant(tenantId) {
  const inst = instances.get(tenantId);
  if (!inst) return;
  try { await inst.client.destroy(); } catch (e) {}
  instances.delete(tenantId);
}

function getStatus(tenantId) {
  const inst = instances.get(tenantId);
  if (!inst) return { status: "stopped" };
  return {
    status: inst.status,
    qr: inst.qrDataUrl,
  };
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}

// Boot — al arrancar el servicio, levanta todos los tenants con whatsapp.enabled = true
async function bootAll() {
  const db = getFirestore();
  const tenants = await db.collection("tenants").get();
  for (const t of tenants.docs) {
    try {
      const wa = await db.collection("tenants").doc(t.id).collection("settings").doc("whatsapp").get();
      if (wa.exists && wa.data().enabled) {
        console.log(`Boot: levantando ${t.id}`);
        await startTenant(t.id);
      }
    } catch (e) {
      console.error(`Boot error ${t.id}:`, e.message);
    }
  }
}

module.exports = { startTenant, stopTenant, getStatus, bootAll };

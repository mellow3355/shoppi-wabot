// Maneja una instancia de whatsapp-web.js por tenant.
// Cada tenant tiene su propio Client + sesion + estado (qr, ready, etc.).

const { Client, LocalAuth } = require("whatsapp-web.js");
const qrcode = require("qrcode");
const path = require("path");
const { getFirestore, FieldValue, Timestamp } = require("firebase-admin/firestore");
const { generateReply, welcomeMessage } = require("./llm");

const SESSIONS_DIR = process.env.SESSIONS_DIR || "/tmp/wa-sessions";

// ── Relay a Upstash Redis (para la bandeja CRM en shoppi.vip/whatsapp.html) ──
const REDIS_URL   = process.env.KV_REST_API_URL   || process.env.UPSTASH_REDIS_REST_URL;
const REDIS_TOKEN = process.env.KV_REST_API_TOKEN || process.env.UPSTASH_REDIS_REST_TOKEN;
const RELAY_ENABLED = !!(REDIS_URL && REDIS_TOKEN);

async function redis(cmd) {
  if (!RELAY_ENABLED) return null;
  const r = await fetch(REDIS_URL, {
    method: "POST",
    headers: { Authorization: `Bearer ${REDIS_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify(cmd),
  });
  const j = await r.json();
  if (j.error) throw new Error("Redis: " + j.error);
  return j.result;
}

function chatIdToPhone(chatId) {
  return String(chatId).replace(/@.*$/, "").replace(/\D/g, "");
}

async function relayIncoming(msg, fromName) {
  if (!RELAY_ENABLED) return;
  try {
    const phone = chatIdToPhone(msg.from);
    if (!phone) return;
    const ts = (msg.timestamp || Math.floor(Date.now() / 1000)) * 1000;
    const tipo = msg.type === "chat" ? "text" : (msg.type || "text");
    const texto = (msg.body || "").slice(0, 4000);
    const stored = {
      id: msg.id?._serialized || msg.id?.id || "in-" + Date.now(),
      de: phone,
      ts,
      tipo,
      direccion: "entrante",
      texto,
      nombre: fromName || "",
      numeroNegocio: process.env.WABOT_BUSINESS_NUMBER || "",
    };
    await redis(["RPUSH", `wa:msgs:${phone}`, JSON.stringify(stored)]);
    await redis(["LTRIM", `wa:msgs:${phone}`, -500, -1]);
    await redis(["ZADD", "wa:convs", ts, phone]);
    await redis(["HSET", `wa:conv:${phone}`,
      "nombre", fromName || "",
      "ultimo", texto ? texto.slice(0, 120) : "[" + tipo + "]",
      "ts", String(ts),
      "tipo", tipo]);
    await redis(["HINCRBY", `wa:conv:${phone}`, "sinLeer", 1]);
  } catch (e) {
    console.error("relay incoming failed:", e.message);
  }
}

async function relayOutgoing(phone, texto, id) {
  if (!RELAY_ENABLED) return null;
  try {
    const ts = Date.now();
    const stored = {
      id: id || "out-" + ts,
      de: phone,
      ts,
      tipo: "text",
      direccion: "saliente",
      texto,
      estado: "enviado",
    };
    await redis(["RPUSH", `wa:msgs:${phone}`, JSON.stringify(stored)]);
    await redis(["ZADD", "wa:convs", ts, phone]);
    await redis(["HSET", `wa:conv:${phone}`,
      "ultimo", "Tú: " + texto.slice(0, 110),
      "ts", String(ts),
      "tipo", "text"]);
    return stored;
  } catch (e) {
    console.error("relay outgoing failed:", e.message);
    return null;
  }
}

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
    // authTimeoutMs default 0 (infinito) — subimos qrMaxRetries para dar mas margen.
    qrMaxRetries: 5,
    puppeteer: {
      headless: true,
      // executablePath explicito para no depender de que puppeteer resuelva el binario.
      // El Dockerfile instala chromium en /usr/bin/chromium y setea la env, pero
      // pasarlo aca elimina cualquier ambigüedad.
      executablePath: process.env.PUPPETEER_EXECUTABLE_PATH || "/usr/bin/chromium",
      protocolTimeout: 300000,
      timeout: 240000,
      args: [
        "--no-sandbox",
        "--disable-setuid-sandbox",
        "--disable-dev-shm-usage",
        "--disable-accelerated-2d-canvas",
        "--no-first-run",
        "--no-zygote",
        "--disable-gpu",
        "--disable-software-rasterizer",
        // Cloud Run tiene /dev/shm de 64MB por default → forzar via /tmp evita
        // que Chrome muera al cargar web.whatsapp.com.
        "--disable-features=IsolateOrigins,site-per-process",
        "--single-process",
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

      const chatId = msg.from;
      const body = (msg.body || "").trim();
      const contact = await msg.getContact();
      const fromName = contact.pushname || contact.name || chatId;

      // Relay a Upstash SIEMPRE (bandeja CRM en shoppi.vip/whatsapp.html).
      // Corre antes del gate de wa.enabled para que el CRM funcione aunque el LLM esté apagado.
      await relayIncoming(msg, fromName);

      const fresh = await loadTenant(tenantId);
      if (!fresh.enabled) return;
      if (!body) return;

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
  console.log(`[${tenantId}] llamando client.initialize()...`);
  client.initialize()
    .then(() => console.log(`[${tenantId}] initialize() resuelto`))
    .catch(err => {
      console.error(`[${tenantId}] init error:`, err.message, err.stack);
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

// Envío manual desde la bandeja CRM. Server-to-server (Vercel inbox.js → wabot).
async function sendManual(tenantId, to, body) {
  const inst = instances.get(tenantId);
  if (!inst) throw new Error("tenant no está corriendo; llamá /start primero");
  if (inst.status !== "ready") throw new Error("bot no está listo (estado: " + inst.status + ")");
  const phone = String(to).replace(/\D/g, "");
  if (!phone) throw new Error("número inválido");
  const texto = String(body || "").trim();
  if (!texto) throw new Error("texto vacío");

  const chatId = phone + "@c.us";
  const sent = await inst.client.sendMessage(chatId, texto);
  const id = sent?.id?._serialized || sent?.id?.id || null;
  const stored = await relayOutgoing(phone, texto, id);
  return { ok: true, id, mensaje: stored };
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

module.exports = { startTenant, stopTenant, getStatus, bootAll, sendManual };

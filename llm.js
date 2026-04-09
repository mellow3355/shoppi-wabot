// Wrapper para Claude Haiku — genera respuestas del bot con contexto del tenant.

const Anthropic = require("@anthropic-ai/sdk");
const client = new Anthropic({ apiKey: process.env.ANTHROPIC_API_KEY });

const MODEL = "claude-haiku-4-5";
const MAX_TOKENS = 300;

/**
 * @param {object} tenant — { name, subdomain, scheduleText, customPrompt }
 * @param {Array<{role:'user'|'assistant',content:string}>} history — ultimos N mensajes
 * @returns {string} — respuesta del bot
 */
async function generateReply(tenant, history) {
  const storeUrl = `https://${tenant.subdomain}.shoppi.vip`;
  const system = `Eres un asistente virtual de WhatsApp para "${tenant.name}", una tienda online.

TU OBJETIVO PRINCIPAL: dirigir al cliente a hacer su pedido en la tienda web. NO tomes pedidos por chat.

INFORMACION DE LA TIENDA:
- Nombre: ${tenant.name}
- Sitio web: ${storeUrl}
${tenant.scheduleText ? `- Horario: ${tenant.scheduleText}` : ""}

REGLAS:
1. Siempre que alguien quiera ordenar, pregunte por productos, precios, o pedidos: dale el link ${storeUrl} y dile que ahi puede ver todo el menu, agregar al carrito y pagar.
2. Responde corto, amable, en espanol venezolano, sin emojis excesivos (max 1 por mensaje).
3. Si preguntan algo que NO sabes, di "una persona del equipo te atiende en breve" — no inventes.
4. NO confirmes pedidos, NO tomes datos de pago, NO calcules totales — todo eso se hace en la web.
5. Si el cliente solo saluda, saluda de vuelta y mencionale el link.

${tenant.customPrompt ? `INSTRUCCIONES ADICIONALES DEL TENANT:\n${tenant.customPrompt}` : ""}`;

  const messages = history.slice(-10).map(m => ({
    role: m.role,
    content: m.content,
  }));

  try {
    const res = await client.messages.create({
      model: MODEL,
      max_tokens: MAX_TOKENS,
      system,
      messages,
    });
    return res.content?.[0]?.text || "";
  } catch (err) {
    console.error("LLM error:", err.message);
    return "";
  }
}

/**
 * Mensaje de bienvenida fijo (sin LLM) — se manda en el primer contacto del dia.
 */
function welcomeMessage(tenant) {
  const storeUrl = `https://${tenant.subdomain}.shoppi.vip`;
  return `¡Hola! 👋 Bienvenido a *${tenant.name}*.\n\nPara hacer tu pedido visita: ${storeUrl}\n\nAlli puedes ver todo el menu, agregar productos al carrito y pagar. Si necesitas ayuda, una persona del equipo te atiende en breve.`;
}

module.exports = { generateReply, welcomeMessage };

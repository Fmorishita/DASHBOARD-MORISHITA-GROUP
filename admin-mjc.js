// ═══════════════════════════════════════════════════════
//  AGENTE ADMIN MJC — Corte semanal + reporte diario
//  Lee WhatsApp "Compras y gastos Morishita" via Green API
//  Procesa con Claude Vision (tickets) + texto
//  Reporta a Fran via Telegram
// ═══════════════════════════════════════════════════════

const GROUP_ID = '120363404195165746@g.us';
const GREEN_INSTANCE = process.env.GREEN_INSTANCE || '7107598670';
const GREEN_TOKEN = process.env.GREEN_TOKEN || '38114b4ee18048ea9c472c18842d4ead3f1efe991e9a46ef8c';
const GREEN_API = `https://7107.api.greenapi.com`;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const BOT_TOKEN = process.env.BOT_TOKEN;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;

// In-memory store (replace with Supabase later)
let expensesDB = [];
let incomesDB = [];
let lastProcessedTs = Date.now() - (7 * 24 * 60 * 60 * 1000); // last 7 days on first run

// ─── Green API helpers ───
async function waGetHistory(count = 100) {
  const res = await fetch(`${GREEN_API}/waInstance${GREEN_INSTANCE}/getChatHistory/${GREEN_TOKEN}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chatId: GROUP_ID, count })
  });
  return res.json();
}

async function waGetMedia(msgId) {
  try {
    const res = await fetch(`${GREEN_API}/waInstance${GREEN_INSTANCE}/downloadFile/${GREEN_TOKEN}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chatId: GROUP_ID, idMessage: msgId })
    });
    const data = await res.json();
    return data.downloadUrl || null;
  } catch(e) { return null; }
}

// ─── Claude helpers ───
async function callClaude(system, user, model = 'claude-haiku-4-5', maxTokens = 1024) {
  const res = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({ model, max_tokens: maxTokens, system, messages: [{ role: 'user', content: user }] })
  });
  const d = await res.json();
  if (!d.content) throw new Error(d.error?.message || 'Claude error');
  return d.content[0].text;
}

async function analyzeTicketImage(imageUrl) {
  try {
    // Fetch image as base64
    const imgRes = await fetch(imageUrl);
    const buf = await imgRes.arrayBuffer();
    const b64 = Buffer.from(buf).toString('base64');
    const contentType = imgRes.headers.get('content-type') || 'image/jpeg';

    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'x-api-key': ANTHROPIC_KEY,
        'anthropic-version': '2023-06-01',
        'content-type': 'application/json'
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5',
        max_tokens: 256,
        messages: [{
          role: 'user',
          content: [
            { type: 'image', source: { type: 'base64', media_type: contentType, data: b64 } },
            { type: 'text', text: 'Extrae del ticket/recibo: descripción del producto/servicio y monto total en pesos mexicanos. Responde SOLO en JSON: {"descripcion":"...","monto":0,"moneda":"MXN"}. Si no es un ticket, responde {"descripcion":null,"monto":null}' }
          ]
        }]
      })
    });
    const d = await res.json();
    const text = d.content?.[0]?.text || '{}';
    const match = text.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { descripcion: null, monto: null };
  } catch(e) {
    console.error('Image analysis error:', e.message);
    return { descripcion: null, monto: null };
  }
}

// ─── Parse text expenses ───
async function parseTextExpense(text) {
  try {
    const result = await callClaude(
      'Eres un parser de gastos para un restaurante japonés premium en México. Extrae gastos de mensajes informales.',
      `Extrae el gasto de este mensaje: "${text}"\n\nResponde SOLO en JSON: {"descripcion":"...","monto":0,"moneda":"MXN","categoria":"ingredientes|suministros|servicios|personal|otros"}\nSi no hay gasto claro, responde {"descripcion":null,"monto":null}`,
      'claude-haiku-4-5', 256
    );
    const match = result.match(/\{[\s\S]*\}/);
    return match ? JSON.parse(match[0]) : { descripcion: null, monto: null };
  } catch(e) { return { descripcion: null, monto: null }; }
}

// ─── Process WhatsApp messages ───
async function processNewMessages() {
  console.log('📱 Leyendo mensajes de WhatsApp...');
  const msgs = await waGetHistory(100);
  if (!Array.isArray(msgs)) { console.error('WA error:', msgs); return []; }

  const newExpenses = [];
  const newMsgs = msgs.filter(m => (m.timestamp * 1000) > lastProcessedTs);

  console.log(`  Nuevos mensajes: ${newMsgs.length}`);

  for (const msg of newMsgs) {
    const ts = new Date(msg.timestamp * 1000).toISOString();
    const sender = msg.senderName || msg.sender || '?';

    // Text message
    if (msg.textMessage && msg.textMessage.trim()) {
      const text = msg.textMessage.trim();
      // Skip non-expense messages
      if (/reserva|mándame|chansita|aguanta|faltan|falta|transfirieron|utilidades/i.test(text)) continue;

      const parsed = await parseTextExpense(text);
      if (parsed.monto && parsed.monto > 0) {
        const expense = { id: msg.idMessage, ts, sender, descripcion: parsed.descripcion, monto: parsed.monto, categoria: parsed.categoria || 'otros', fuente: 'texto', raw: text };
        newExpenses.push(expense);
        console.log(`  ✅ Gasto texto: ${parsed.descripcion} $${parsed.monto}`);
      }
    }

    // Image/media message (ticket)
    if (msg.type === 'image' || msg.typeMessage === 'imageMessage') {
      const mediaUrl = await waGetMedia(msg.idMessage);
      if (mediaUrl) {
        const parsed = await analyzeTicketImage(mediaUrl);
        if (parsed.monto && parsed.monto > 0) {
          const expense = { id: msg.idMessage, ts, sender, descripcion: parsed.descripcion, monto: parsed.monto, categoria: 'ingredientes', fuente: 'ticket', mediaUrl };
          newExpenses.push(expense);
          console.log(`  ✅ Gasto ticket: ${parsed.descripcion} $${parsed.monto}`);
        }
      }
    }

    await sleep(300); // Rate limit
  }

  if (newMsgs.length > 0) {
    lastProcessedTs = Math.max(...newMsgs.map(m => m.timestamp * 1000));
  }

  expensesDB.push(...newExpenses);
  return newExpenses;
}

// ─── Generate report ───
async function generateReport(type = 'daily') {
  const now = new Date();
  const cutoff = type === 'weekly'
    ? new Date(now - 7 * 24 * 60 * 60 * 1000)
    : new Date(now - 24 * 60 * 60 * 1000);

  const periodExpenses = expensesDB.filter(e => new Date(e.ts) >= cutoff);
  const totalGastos = periodExpenses.reduce((s, e) => s + (e.monto || 0), 0);
  const totalIngresos = incomesDB.filter(i => new Date(i.ts) >= cutoff).reduce((s, i) => s + (i.monto || 0), 0);
  const utilidad = totalIngresos - totalGastos;
  const margen = totalIngresos > 0 ? ((utilidad / totalIngresos) * 100).toFixed(1) : 0;

  // Group expenses by category
  const byCategory = {};
  periodExpenses.forEach(e => {
    byCategory[e.categoria] = (byCategory[e.categoria] || 0) + e.monto;
  });

  const catStr = Object.entries(byCategory)
    .sort((a,b) => b[1]-a[1])
    .map(([cat, amt]) => `  • ${cat}: $${amt.toLocaleString('es-MX')}`)
    .join('\n') || '  • Sin gastos registrados';

  // Get Claude recommendation
  const recommendation = await callClaude(
    'Eres Paco IA, director financiero de Morishita Japanese Cuisine. Das recomendaciones ejecutivas breves y accionables.',
    `Datos financieros del período:\n- Gastos: $${totalGastos.toLocaleString('es-MX')}\n- Ingresos: $${totalIngresos.toLocaleString('es-MX')}\n- Utilidad: $${utilidad.toLocaleString('es-MX')}\n- Margen: ${margen}%\n\nDa 2-3 recomendaciones concretas en máximo 100 palabras. Si hay utilidad, sugiere cómo reinvertir.`,
    'claude-haiku-4-5', 300
  );

  const periodLabel = type === 'weekly' ? 'Semana' : 'Día';
  const emoji = utilidad >= 0 ? '📈' : '📉';
  const icon = type === 'weekly' ? '📊' : '🌅';

  return `${icon} <b>Reporte ${periodLabel} — Morishita Japanese Cuisine</b>
${new Date().toLocaleDateString('es-MX', { weekday:'long', year:'numeric', month:'long', day:'numeric' })}

💰 <b>Ingresos:</b> $${totalIngresos.toLocaleString('es-MX')}
🧾 <b>Gastos:</b> $${totalGastos.toLocaleString('es-MX')}
${emoji} <b>Utilidad:</b> $${utilidad.toLocaleString('es-MX')} (${margen}%)

📋 <b>Gastos por categoría:</b>
${catStr}

🤖 <b>Paco recomienda:</b>
${recommendation}

<i>Fuente: ${periodExpenses.length} gastos de WhatsApp "Compras y gastos Morishita"</i>`;
}

// ─── Telegram notify ───
async function tgSend(text) {
  if (!BOT_TOKEN || !ALLOWED_CHAT_ID) return;
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: ALLOWED_CHAT_ID, text, parse_mode: 'HTML' })
  });
}

// ─── Register income ───
async function registerIncome(amount, description) {
  const income = { id: Date.now().toString(), ts: new Date().toISOString(), monto: amount, descripcion: description };
  incomesDB.push(income);
  return income;
}

// ─── Scheduled jobs ───
// Lógica:
// - Leer WhatsApp SOLO lunes y martes a las 10AM (UTC-6 = 16:00 UTC)
//   para capturar gastos del fin de semana + lunes adicionales
// - Reporte semanal SOLO lunes a las 9AM (antes de la lectura)
//   así el martes puede complementar si faltaron gastos
// - Sin reportes diarios
function startScheduler(broadcast) {

  // Check every day at 10AM Mexico (16:00 UTC) — but only execute on Mon/Tue
  scheduleDailyAt(16, 0, async () => {
    const dayUTC = new Date().getUTCDay(); // 0=Sun,1=Mon,2=Tue
    const isMon = dayUTC === 1;
    const isTue = dayUTC === 2;

    if (!isMon && !isTue) {
      console.log('⏭ Hoy no es lunes/martes — omitiendo lectura de WhatsApp');
      return;
    }

    console.log(`📱 ${isMon ? 'Lunes' : 'Martes'} — Leyendo gastos del fin de semana...`);
    try {
      const newExpenses = await processNewMessages();
      if (newExpenses.length > 0) {
        broadcast({ type: 'expenses_updated', count: newExpenses.length, expenses: newExpenses });
        console.log(`💰 ${newExpenses.length} gastos procesados`);
      } else {
        console.log('💰 Sin gastos nuevos en WhatsApp');
      }
    } catch(e) { console.error('WA sync error:', e.message); }
  });

  // Weekly report: Monday 9AM Mexico (15:00 UTC)
  // Runs BEFORE the 10AM WhatsApp read — captures Wed-Sun gastos
  // Tuesday's read will add any Monday/late additions (visible next week)
  scheduleWeeklyMonday(15, 0, async () => {
    console.log('📊 Generando reporte semanal (lunes 9AM)...');
    try {
      // First do a quick sync to catch anything posted Mon morning
      await processNewMessages();
      const report = await generateReport('weekly');
      await tgSend(report);
      console.log('✅ Reporte semanal enviado a Fran');
    } catch(e) { console.error('Weekly report error:', e.message); }
  });

  const nextMon = msUntilNextWeekday(1, 15, 0);
  const nextTue = msUntilNextWeekday(2, 16, 0);
  console.log(`⏰ Scheduler MJC iniciado:`);
  console.log(`   📊 Próximo reporte semanal: lunes en ${Math.round(nextMon/3600000)}h`);
  console.log(`   📱 Próxima lectura WA: ${nextTue < nextMon ? 'martes' : 'lunes'} en ${Math.round(Math.min(nextMon,nextTue)/3600000)}h`);
}

function scheduleDailyAt(hourUTC, minUTC, fn) {
  const now = new Date();
  const next = new Date();
  next.setUTCHours(hourUTC, minUTC, 0, 0);
  if (next <= now) next.setUTCDate(next.getUTCDate() + 1);
  const delay = next - now;
  setTimeout(() => { fn(); setInterval(fn, 24 * 60 * 60 * 1000); }, delay);
}

function scheduleWeeklyMonday(hourUTC, minUTC, fn) {
  const delay = msUntilNextWeekday(1, hourUTC, minUTC);
  setTimeout(() => { fn(); setInterval(fn, 7 * 24 * 60 * 60 * 1000); }, delay);
}

function msUntilNextWeekday(weekday, hourUTC, minUTC) {
  const now = new Date();
  const day = now.getUTCDay();
  let daysUntil = (weekday - day + 7) % 7;
  if (daysUntil === 0) {
    const todayTarget = new Date();
    todayTarget.setUTCHours(hourUTC, minUTC, 0, 0);
    if (todayTarget <= now) daysUntil = 7; // already passed today, next week
  }
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntil);
  next.setUTCHours(hourUTC, minUTC, 0, 0);
  return next - now;
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

module.exports = { startScheduler, processNewMessages, generateReport, registerIncome, expensesDB, incomesDB };

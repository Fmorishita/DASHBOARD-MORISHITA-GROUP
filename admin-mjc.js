// ────── Admin MJC Agent ──────
// Lee gastos desde WhatsApp "Compras y gastos Morishita" via Green API
// Genera reportes semanales y los envía a Telegram

const https = require('https');

// Green API credentials
const GREEN_INSTANCE = process.env.GREEN_INSTANCE || '7107598670';
const GREEN_TOKEN = process.env.GREEN_TOKEN || '38114b4ee18048ea9c472c18842d4ead3f1efe991e9a46ef8c';
const GROUP_ID = '120363404195165746@g.us';
const TG_BOT_TOKEN = process.env.BOT_TOKEN;
const TG_CHAT_ID = process.env.ALLOWED_CHAT_ID || '1475348027';

// In-memory databases
const expensesDB = [];
const incomesDB = [];
const lastProcessedTimestamp = {};

// ────── Green API ──────
function greenAPI(method, body = {}) {
  return new Promise((resolve, reject) => {
    const path = `/waInstance${GREEN_INSTANCE}/${method}/${GREEN_TOKEN}`;
    const options = {
      hostname: '7107.api.greenapi.com',
      path: path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          resolve(JSON.parse(data));
        } catch {
          resolve([]);
        }
      });
    });
    
    req.on('error', reject);
    req.write(JSON.stringify(body));
    req.end();
  });
}

// ────── Parse amounts from text ──────
function parseAmounts(text) {
  const matches = text.match(/\$?\s*(\d+(?:[,\.]\d+)?)/g);
  const amounts = [];
  if (matches) {
    matches.forEach(m => {
      const num = parseFloat(m.replace(/[$,\s]/g, ''));
      if (num > 100 && num < 100000) {
        amounts.push(num);
      }
    });
  }
  return amounts;
}

// ────── Week calculation ──────
function getWeekRange(timestamp) {
  const date = new Date(timestamp * 1000);
  const day = date.getDay();
  const diff = date.getDate() - day + (day === 0 ? -6 : 1);
  const monday = new Date(date.setDate(diff));
  const sunday = new Date(monday);
  sunday.setDate(sunday.getDate() + 6);
  return {
    start: monday,
    end: sunday,
    key: monday.toLocaleDateString('es-MX')
  };
}

// ────── Telegram notification ──────
async function tgSend(message) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify({
      chat_id: TG_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    });

    const options = {
      hostname: 'api.telegram.org',
      path: `/bot${TG_BOT_TOKEN}/sendMessage`,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': body.length
      }
    };

    const req = https.request(options, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try {
          const result = JSON.parse(data);
          resolve(result.ok ? { ok: true } : { ok: false, error: result.description });
        } catch {
          resolve({ ok: true });
        }
      });
    });

    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

// ────── Process WhatsApp messages ──────
async function processNewMessages() {
  const newExpenses = [];
  try {
    console.log('📱 Leyendo grupo WhatsApp...');
    const history = await greenAPI('GetChatHistory', {
      chatId: GROUP_ID,
      count: 200
    });

    if (!Array.isArray(history)) {
      console.error('Error: respuesta no es array', history);
      return newExpenses;
    }

    const textMessages = history.filter(m => m.typeMessage === 'textMessage' && m.textMessage);
    console.log(`✅ ${textMessages.length} mensajes de texto encontrados`);

    textMessages.forEach(msg => {
      const msgKey = msg.idMessage;
      
      if (lastProcessedTimestamp[msgKey]) return;
      
      const amounts = parseAmounts(msg.textMessage);
      amounts.forEach(amount => {
        const expense = {
          id: `${msg.idMessage}_${amount}`,
          date: new Date(msg.timestamp * 1000).toLocaleDateString('es-MX'),
          description: msg.textMessage.substring(0, 100),
          amount: amount,
          category: msg.textMessage.includes('atún') ? 'Atún' : 
                    msg.textMessage.includes('Wagyu') ? 'Wagyu' : 
                    msg.textMessage.includes('gas') ? 'Servicios' : 'Ingredientes',
          source: 'whatsapp',
          timestamp: msg.timestamp
        };
        
        if (!expensesDB.find(e => e.id === expense.id)) {
          expensesDB.push(expense);
          newExpenses.push(expense);
        }
      });
      
      lastProcessedTimestamp[msgKey] = true;
    });

  } catch(e) {
    console.error('❌ Error en processNewMessages:', e.message);
  }
  return newExpenses;
}

// ────── Generate weekly report ──────
async function generateReport(type) {
  if (type !== 'weekly') return '';

  const weeks = {};
  let totalGeneral = 0;

  expensesDB.forEach(exp => {
    const range = getWeekRange(exp.timestamp || Math.floor(new Date().getTime() / 1000));
    const weekKey = range.key;
    
    if (!weeks[weekKey]) {
      weeks[weekKey] = {
        start: range.start.toLocaleDateString('es-MX'),
        end: range.end.toLocaleDateString('es-MX'),
        items: [],
        total: 0
      };
    }

    weeks[weekKey].items.push(exp);
    weeks[weekKey].total += exp.amount;
    totalGeneral += exp.amount;
  });

  const sortedWeeks = Object.values(weeks).sort((a, b) => {
    const dateA = new Date(a.start.split('/').reverse().join('-'));
    const dateB = new Date(b.start.split('/').reverse().join('-'));
    return dateB - dateA;
  });

  let report = `<b>📋 CORTE SEMANAL MORISHITA JAPANESE CUISINE</b>\n`;
  
  if (sortedWeeks.length > 0) {
    const currentWeek = sortedWeeks[0];
    report += `<b>Semana: ${currentWeek.start} → ${currentWeek.end}</b>\n\n`;
    
    report += `<b>💰 Gastos esta semana:</b>\n`;
    currentWeek.items.forEach(item => {
      report += `  • ${item.description.substring(0, 30)}: $${item.amount.toLocaleString()} MXN\n`;
    });
    report += `\n<b>Subtotal: $${currentWeek.total.toLocaleString()} MXN</b>\n\n`;
  }

  report += `<b>📈 Total histórico:</b> $${totalGeneral.toLocaleString()} MXN\n`;
  report += `<b>📅 Semanas registradas:</b> ${sortedWeeks.length}\n\n`;

  report += `<b>💡 Recomendación Paco IA:</b>\n`;
  if (sortedWeeks[0]?.total > 5000) {
    report += `⚠️  Gastos altos esta semana. Revisar proveedores y volúmenes.\n`;
  } else if (sortedWeeks[0]?.total > 0) {
    report += `✅ Gastos dentro de rango normal.\n`;
  }
  
  if (incomesDB.length === 0) {
    report += `⚠️  No hay ingresos registrados aún (requiere input manual).\n`;
  } else {
    const totalIncome = incomesDB.reduce((sum, inc) => sum + inc.amount, 0);
    const utilidad = totalIncome - (sortedWeeks[0]?.total || 0);
    report += `✅ Ingresos semana: $${totalIncome.toLocaleString()} MXN\n`;
    report += `📊 Utilidad estimada: $${utilidad.toLocaleString()} MXN\n`;
  }

  return report;
}

// ────── Register income ──────
function registerIncome(amount, description = '') {
  const income = {
    id: `inc_${Date.now()}_${Math.random().toString(36).slice(2)}`,
    date: new Date().toLocaleDateString('es-MX'),
    amount: parseFloat(amount),
    description: description || 'Ingreso manual',
    source: 'manual'
  };
  incomesDB.push(income);
  console.log(`✅ Ingreso registrado: $${amount} — ${description}`);
  return income;
}

// ────── Schedulers ──────
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
    if (todayTarget <= now) daysUntil = 7;
  }
  const next = new Date(now);
  next.setUTCDate(now.getUTCDate() + daysUntil);
  next.setUTCHours(hourUTC, minUTC, 0, 0);
  return next - now;
}

// ────── Start scheduler ──────
function startScheduler(broadcastWS = null) {
  scheduleDailyAt(16, 0, async () => {
    const dayUTC = new Date().getUTCDay();
    const isMon = dayUTC === 1;
    const isTue = dayUTC === 2;

    if (!isMon && !isTue) {
      console.log('✋ No es lunes/martes — omitiendo lectura');
      return;
    }

    console.log(`📱 ${isMon ? 'Lunes' : 'Martes'} 10AM — Leyendo gastos...`);
    try {
      const newExpenses = await processNewMessages();
      if (newExpenses.length > 0) {
        if (broadcastWS) broadcastWS({ type: 'expenses_updated', count: newExpenses.length, expenses: newExpenses });
        console.log(`💰 ${newExpenses.length} gastos nuevos`);
      }
    } catch(e) { console.error('WA sync error:', e.message); }
  });

  scheduleWeeklyMonday(15, 0, async () => {
    console.log('📋 Lunes 9AM — Generando reporte semanal...');
    try {
      await processNewMessages();
      const report = await generateReport('weekly');
      if (report) await tgSend(report);
      console.log('✅ Reporte enviado a Fran');
    } catch(e) { console.error('Report error:', e.message); }
  });

  const nextMon = msUntilNextWeekday(1, 15, 0);
  const nextTue = msUntilNextWeekday(2, 16, 0);
  console.log(`⏰ Admin MJC scheduler iniciado`);
  console.log(`   📋 Próximo reporte: en ${Math.round(nextMon/3600000)}h`);
  console.log(`   📱 Próxima lectura: en ${Math.round(Math.min(nextMon,nextTue)/3600000)}h`);
}

module.exports = {
  startScheduler,
  processNewMessages,
  generateReport,
  registerIncome,
  expensesDB,
  incomesDB,
  tgSend
};

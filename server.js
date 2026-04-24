const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors());
app.use(express.json());

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Store connected dashboard clients
const clients = new Set();

// Store tasks in memory (replace with Supabase later)
let tasks = [];
let messages = [];

wss.on('connection', (ws) => {
  clients.add(ws);
  console.log('Dashboard connected. Total:', clients.size);
  
  // Send current state to new client
  ws.send(JSON.stringify({ type: 'init', tasks, messages }));
  
  ws.on('close', () => {
    clients.delete(ws);
    console.log('Dashboard disconnected. Total:', clients.size);
  });

  // Handle messages from dashboard
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleDashboardEvent(msg);
    } catch(e) { console.error('WS parse error:', e); }
  });
});

function broadcast(event) {
  const data = JSON.stringify(event);
  clients.forEach(client => {
    if (client.readyState === 1) client.send(data);
  });
}

// Telegram webhook endpoint
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;
  
  const text = update.message.text;
  const from = update.message.from.first_name;
  const chatId = update.message.chat.id;
  
  console.log(`Telegram message from ${from}: ${text}`);
  
  // Store message
  const msg = {
    id: Date.now().toString(),
    from,
    text,
    ts: new Date().toISOString(),
    direction: 'inbound'
  };
  messages.push(msg);
  
  // Broadcast to dashboard
  broadcast({ type: 'telegram_message', message: msg });
  
  // Paco analyzes and creates tasks
  await pacoAnalyze(text, chatId);
});

// REST endpoint for dashboard to send messages back to Telegram
app.post('/api/send-telegram', async (req, res) => {
  const { chatId, text } = req.body;
  if (!process.env.BOT_TOKEN || !chatId) return res.json({ ok: false });
  
  try {
    const r = await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
    const data = await r.json();
    res.json(data);
  } catch(e) {
    res.json({ ok: false, error: e.message });
  }
});

// Dashboard creates a task → broadcast to all dashboards
app.post('/api/tasks', (req, res) => {
  const task = { ...req.body, id: Date.now().toString(), ts: new Date().toISOString() };
  tasks.push(task);
  broadcast({ type: 'task_created', task });
  res.json({ ok: true, task });
});

// Dashboard updates task status
app.patch('/api/tasks/:id', (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.json({ ok: false });
  Object.assign(task, req.body, { updatedAt: new Date().toISOString() });
  broadcast({ type: 'task_updated', task });
  res.json({ ok: true, task });
});

// Health check
app.get('/', (req, res) => res.json({ status: 'ok', clients: clients.size, tasks: tasks.length }));

// Paco AI analysis (rule-based for now, Claude API later)
async function pacoAnalyze(text, chatId) {
  const lower = text.toLowerCase();
  
  // Detect intent and create tasks
  const newTasks = [];
  
  if (/investigar|research|analiz|proveed/i.test(lower)) {
    newTasks.push({ title: extractTitle(text, 'research'), agent: 'atlas', priority: 'high', col: 'todo', company: detectCompany(lower), tags: ['research','paco'], estMin: 60 });
  }
  if (/email|correo|newsletter|enviar/i.test(lower)) {
    newTasks.push({ title: extractTitle(text, 'email'), agent: 'mercury', priority: 'high', col: 'todo', company: detectCompany(lower), tags: ['email','paco'], estMin: 45 });
  }
  if (/instagram|redes|social|post|contenido/i.test(lower)) {
    newTasks.push({ title: extractTitle(text, 'social'), agent: 'hana', priority: 'medium', col: 'todo', company: detectCompany(lower), tags: ['social','paco'], estMin: 90 });
  }
  if (/código|app|web|api|dashboard|automatiz/i.test(lower)) {
    newTasks.push({ title: extractTitle(text, 'code'), agent: 'codex', priority: 'high', col: 'todo', company: detectCompany(lower), tags: ['code','paco'], estMin: 60 });
  }
  
  // If no specific intent, create strategic task for Paco
  if (newTasks.length === 0) {
    newTasks.push({ title: text.slice(0, 60), agent: 'paco', priority: 'medium', col: 'todo', company: detectCompany(lower), tags: ['estrategia','paco'], estMin: 30 });
  }
  
  // Broadcast Paco thinking
  broadcast({ type: 'paco_thinking', text: `🧠 Analizando: "${text.slice(0,40)}..."` });
  
  await sleep(2000);
  
  // Create tasks and broadcast
  for (const t of newTasks) {
    const task = { ...t, id: Date.now().toString()+Math.random().toString(36).slice(2,5), ts: new Date().toISOString() };
    tasks.push(task);
    broadcast({ type: 'task_created', task });
    await sleep(800);
  }
  
  // Paco confirms via Telegram
  const agentNames = { atlas: 'Atlas', mercury: 'Mercury', hana: 'Hana', codex: 'Codex', nova: 'Nova', paco: 'Paco' };
  const summary = newTasks.map(t => `• ${t.title.slice(0,40)} → ${agentNames[t.agent]}`).join('\n');
  
  if (process.env.BOT_TOKEN && chatId) {
    await fetch(`https://api.telegram.org/bot${process.env.BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        chat_id: chatId,
        text: `♟️ <b>Paco IA</b>\n\nRecibido. Creé ${newTasks.length} tarea(s) en el dashboard:\n\n${summary}\n\n✅ Ya aparecen en el Kanban.`,
        parse_mode: 'HTML'
      })
    });
  }
  
  broadcast({ type: 'paco_done', count: newTasks.length });
}

function extractTitle(text, type) {
  const clean = text.replace(/[^\w\sáéíóúüñÁÉÍÓÚÜÑ]/g, '').trim();
  return clean.length > 55 ? clean.slice(0, 55) + '...' : clean;
}

function detectCompany(text) {
  if (/wagyu fest|festival/i.test(text)) return 'mwf';
  if (/meat|carne/i.test(text)) return 'mm';
  if (/japanese|omakase|restaurante|mjc/i.test(text)) return 'mjc';
  return 'mjc';
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`Morishita Backend running on port ${PORT}`));

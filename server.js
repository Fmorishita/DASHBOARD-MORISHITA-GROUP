const express = require('express');
const { WebSocketServer } = require('ws');
const cors = require('cors');
const http = require('http');

const app = express();
app.use(cors({ origin: '*' }));
app.use(express.json());
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Headers', 'Content-Type');
  next();
});

const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const BOT_TOKEN = process.env.BOT_TOKEN;
const ANTHROPIC_KEY = process.env.ANTHROPIC_KEY;
const ALLOWED_CHAT_ID = process.env.ALLOWED_CHAT_ID;
const API_URL = 'https://api.anthropic.com/v1/messages';

let clients = new Set();
let tasks = [];
let messages = [];

// ─── WebSocket ───
wss.on('connection', (ws) => {
  clients.add(ws);
  console.log(`Dashboard conectado. Total: ${clients.size}`);
  ws.send(JSON.stringify({ type: 'init', tasks, messages }));
  ws.on('close', () => { clients.delete(ws); });
  ws.on('message', (data) => {
    try { handleDashboardEvent(JSON.parse(data)); } catch(e) {}
  });
});

function broadcast(event) {
  const data = JSON.stringify(event);
  clients.forEach(c => { if (c.readyState === 1) c.send(data); });
}

function handleDashboardEvent(msg) {
  if (msg.type === 'task_updated') {
    const t = tasks.find(x => x.id === msg.task.id);
    if (t) Object.assign(t, msg.task);
    broadcast({ type: 'task_updated', task: msg.task });
  }
}

// ─── Telegram API ───
async function tgSend(chatId, text) {
  if (!BOT_TOKEN) return;
  try {
    await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: 'HTML' })
    });
  } catch(e) { console.error('tgSend error:', e.message); }
}

// ─── Claude API ───
async function callClaude(systemPrompt, userMsg, model = 'claude-haiku-4-5', maxTokens = 1024) {
  const res = await fetch(API_URL, {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json'
    },
    body: JSON.stringify({
      model,
      max_tokens: maxTokens,
      system: systemPrompt,
      messages: [{ role: 'user', content: userMsg }]
    })
  });
  const data = await res.json();
  if (!data.content) throw new Error(data.error?.message || 'Claude error');
  return data.content[0].text;
}

// ─── Move card + notify ───
async function moveTask(taskId, newCol, chatId) {
  const task = tasks.find(t => t.id === taskId);
  if (!task) return;
  task.col = newCol;
  task.updatedAt = new Date().toISOString();
  if (newCol === 'progress' && !task.startedAt) task.startedAt = new Date().toISOString();
  broadcast({ type: 'task_updated', task });
  console.log(`Task "${task.title}" → ${newCol}`);

  // Notify Telegram when done or in review
  if ((newCol === 'done' || newCol === 'review') && chatId) {
    const icon = newCol === 'done' ? '✅' : '👀';
    const verb = newCol === 'done' ? 'completó' : 'envió a revisión';
    const agents = { paco:'Paco IA', hana:'Hana', atlas:'Atlas', codex:'Codex', nova:'Nova', mercury:'Mercury' };
    await tgSend(chatId, `${icon} <b>${agents[task.agent] || task.agent}</b> ${verb}:\n\n<b>${task.title}</b>\n\n✅ Reflejado en el dashboard.`);
  }
}

// ─── Execute task with Claude ───
async function executeTask(task, chatId) {
  const agentPrompts = {
    atlas:   'Eres Atlas, especialista en research y análisis de mercados para Morishita Group. Sé conciso y profesional.',
    mercury: 'Eres Mercury, especialista en email marketing para Morishita Group. Redacta textos persuasivos y profesionales.',
    hana:    'Eres Hana, especialista en redes sociales para Morishita Group. Crea contenido atractivo y moderno.',
    nova:    'Eres Nova, especialista en contenido SEO y blogs para Morishita Group. Escribe de forma clara y optimizada.',
    codex:   'Eres Codex, desarrollador de software para Morishita Group. Proporciona soluciones técnicas precisas.',
    paco:    'Eres Paco IA, Director General de Morishita Group. Analiza estratégicamente y toma decisiones ejecutivas.'
  };

  try {
    // Move to progress
    await moveTask(task.id, 'progress', null);
    broadcast({ type: 'paco_thinking', text: `⚙️ ${task.agent} ejecutando: "${task.title}"` });

    const systemPrompt = agentPrompts[task.agent] || agentPrompts.paco;
    const userMsg = `Ejecuta esta tarea y entrega el resultado en máximo 200 palabras:\n\nTarea: ${task.title}\nDescripción: ${task.desc || task.title}\nEmpresa: ${task.company}`;

    // Execute with Claude
    const result = await callClaude(systemPrompt, userMsg, 'claude-haiku-4-5', 512);

    // Store result in task
    task.result = result;
    task.completedAt = new Date().toISOString();

    // Move to review
    await moveTask(task.id, 'review', chatId);

    // Send result to Telegram
    if (chatId) {
      const agents = { paco:'Paco IA', hana:'Hana', atlas:'Atlas', codex:'Codex', nova:'Nova', mercury:'Mercury' };
      const shortResult = result.length > 600 ? result.slice(0, 600) + '...' : result;
      await tgSend(chatId, `👀 <b>${agents[task.agent] || task.agent} completó: ${task.title}</b>\n\n${shortResult}\n\n¿Apruebas? Responde ✅ para marcar como Done o ❌ para ajustes.`);
    }

  } catch(err) {
    console.error('Execute error:', err.message);
    task.error = err.message;
    broadcast({ type: 'task_updated', task });
    if (chatId) await tgSend(chatId, `❌ Error ejecutando "${task.title}": ${err.message}`);
  }
}

// ─── Paco analyzes message with Claude ───
async function pacoAnalyze(text, chatId) {
  broadcast({ type: 'paco_thinking', text: `🧠 Analizando: "${text.slice(0,40)}..."` });

  let parsed = null;

  try {
    const systemPrompt = `Eres Paco IA, Director General de Morishita Group con 4 empresas:
- mjc: Morishita Japanese Cuisine (restaurante omakase premium)
- mm: Morishita Meat (cortes wagyu premium)  
- mwf: Morishita Wagyu Fest (festival gastronómico)
- fran: Pendientes Fran (tareas estratégicas del founder)

Agentes disponibles: atlas (research), mercury (email), hana (redes sociales), nova (contenido/blog), codex (código), paco (estrategia)

Analiza el mensaje y responde SOLO con JSON válido, sin texto adicional:
{
  "tasks": [
    {
      "title": "título corto max 50 chars",
      "desc": "descripción clara de qué hacer",
      "agent": "atlas|mercury|hana|nova|codex|paco",
      "priority": "low|medium|high|critical",
      "company": "mjc|mm|mwf|fran",
      "estMin": 30,
      "tags": ["tag1","tag2"]
    }
  ],
  "pacoResponse": "respuesta breve de Paco confirmando las tareas creadas"
}`;

    const raw = await callClaude(systemPrompt, text, 'claude-haiku-4-5', 1024);

    // Extract JSON safely
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) throw new Error('No JSON in response');
    parsed = JSON.parse(match[0]);

  } catch(err) {
    console.error('Paco analyze error:', err.message);
    // Fallback: create one strategic task
    parsed = {
      tasks: [{
        title: text.slice(0, 50),
        desc: text,
        agent: 'paco',
        priority: 'medium',
        company: 'fran',
        estMin: 30,
        tags: ['telegram']
      }],
      pacoResponse: `Recibido. Creé la tarea en el dashboard para analizarla.`
    };
  }

  // Create tasks
  const created = [];
  for (const t of (parsed.tasks || [])) {
    const task = {
      ...t,
      id: Date.now().toString() + Math.random().toString(36).slice(2, 5),
      col: 'todo',
      ts: new Date().toISOString(),
      startedAt: null
    };
    tasks.push(task);
    broadcast({ type: 'task_created', task });
    created.push(task);
    await sleep(400);
  }

  // Paco confirms in Telegram
  const agentNames = { atlas:'Atlas', mercury:'Mercury', hana:'Hana', nova:'Nova', codex:'Codex', paco:'Paco IA' };
  const summary = created.map(t => `• <b>${t.title}</b> → ${agentNames[t.agent] || t.agent}`).join('\n');
  const response = parsed.pacoResponse || `Creé ${created.length} tarea(s) en el dashboard.`;

  await tgSend(chatId, `♟️ <b>Paco IA</b>\n\n${response}\n\n${summary}\n\n<i>¿Ejecuto las tareas ahora? Responde /ejecutar para arrancar.</i>`);

  broadcast({ type: 'paco_done', count: created.length });

  return created;
}

// ─── Webhook Telegram ───
app.post('/webhook/telegram', async (req, res) => {
  res.sendStatus(200);
  const update = req.body;
  if (!update.message) return;

  const text = update.message.text || '';
  const chatId = update.message.chat.id.toString();
  const from = update.message.from.first_name || 'Fran';

  // Security: only allowed chat
  if (ALLOWED_CHAT_ID && chatId !== ALLOWED_CHAT_ID) return;

  console.log(`Telegram [${from}]: ${text}`);

  const msg = { id: Date.now().toString(), from, text, ts: new Date().toISOString(), direction: 'inbound' };
  messages.push(msg);
  broadcast({ type: 'telegram_message', message: msg });

  // Commands
  if (text === '/ejecutar') {
    const pending = tasks.filter(t => t.col === 'todo');
    if (!pending.length) { await tgSend(chatId, '⚠️ No hay tareas en To Do para ejecutar.'); return; }
    await tgSend(chatId, `🚀 Ejecutando ${pending.length} tarea(s)...`);
    for (const t of pending) { await executeTask(t, chatId); await sleep(1000); }
    return;
  }

  if (text === '/estado') {
    const byCol = { backlog:0, todo:0, progress:0, review:0, done:0 };
    tasks.forEach(t => { if (byCol[t.col] !== undefined) byCol[t.col]++; });
    await tgSend(chatId, `📊 <b>Estado del Dashboard</b>\n\n📥 Backlog: ${byCol.backlog}\n📋 To Do: ${byCol.todo}\n⚙️ En Progreso: ${byCol.progress}\n👀 Revisión: ${byCol.review}\n✅ Done: ${byCol.done}\n\n<b>Total:</b> ${tasks.length} tareas`);
    return;
  }

  if (text === '/limpiar') {
    tasks = [];
    broadcast({ type: 'init', tasks: [], messages });
    await tgSend(chatId, '🗑️ Board limpiado.');
    return;
  }

  if (text.startsWith('/')) return; // ignore unknown commands

  // Normal message → Paco analyzes
  await pacoAnalyze(text, chatId);
});

// ─── REST API ───
app.get('/', (req, res) => res.json({ status: 'ok', clients: clients.size, tasks: tasks.length }));

app.post('/api/tasks', (req, res) => {
  const task = { ...req.body, id: Date.now().toString() + Math.random().toString(36).slice(2,4), ts: new Date().toISOString() };
  tasks.push(task);
  broadcast({ type: 'task_created', task });
  res.json({ ok: true, task });
});

app.patch('/api/tasks/:id', (req, res) => {
  const task = tasks.find(t => t.id === req.params.id);
  if (!task) return res.json({ ok: false });
  Object.assign(task, req.body, { updatedAt: new Date().toISOString() });
  broadcast({ type: 'task_updated', task });
  res.json({ ok: true, task });
});

app.get('/api/tasks', (req, res) => res.json({ tasks }));

// ─── Utils ───
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => console.log(`✅ Morishita Backend on port ${PORT}`));

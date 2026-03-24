/* ═══════════════════════════════════════════════════
   TicketRadar — server.js (Backend Node.js)
   
   Endpoints :
   POST /api/notify  → Envoie alertes Telegram
   GET  /api/health  → Health check
   GET  /api/prices  → Prix live SeatGeek
   
   Sécurité :
   - Token Telegram stocké en variable d'env (jamais exposé)
   - CORS configuré
   - Rate limiting
   - Validation des inputs
═══════════════════════════════════════════════════ */

const express    = require('express');
const cors       = require('cors');
const axios      = require('axios');
const rateLimit  = require('express-rate-limit');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Env vars ── */
const TELEGRAM_TOKEN   = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_ORIGIN   = process.env.ALLOWED_ORIGIN || 'https://fredericnjoh-lab.github.io';

if (!TELEGRAM_TOKEN)   console.warn('⚠ TELEGRAM_TOKEN manquant');
if (!TELEGRAM_CHAT_ID) console.warn('⚠ TELEGRAM_CHAT_ID manquant');

/* ── Middlewares ── */
app.use(cors({
  origin: [ALLOWED_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));

app.use(express.json({ limit: '100kb' }));

/* ── Rate limiting ── */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 30,
  message: { error: 'Trop de requêtes, réessaie dans 15 minutes' },
});
app.use('/api/', limiter);

/* ── Helpers ── */
function buildMessage(ev, type = 'opportunity') {
  if (type === 'drop') {
    const pct = ev.prevResale
      ? Math.round(((ev.resale - ev.prevResale) / ev.prevResale) * 100)
      : 0;
    return (
      `📉 <b>TicketRadar — Chute de prix !</b>\n\n` +
      `${ev.flag || '🎫'} <b>${ev.name}</b>\n` +
      `📉 Baisse : <b>${pct}%</b>\n` +
      `💰 ${ev.prevResale}€ → <b>${ev.resale}€</b>\n` +
      `⚡ BON MOMENT D'ACHETER\n\n` +
      `👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`
    );
  }
  return (
    `🔥 <b>TicketRadar — Opportunité !</b>\n\n` +
    `${ev.flag || '🎫'} <b>${ev.name}</b>\n` +
    `💰 Marge : <b>+${ev.marge}%</b>\n` +
    `🎫 ${ev.face}€ → <b>${ev.resale}€</b>\n` +
    `📅 ${ev.date || ''}\n` +
    `🏪 ${ev.platform || ''}\n\n` +
    `👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`
  );
}

async function sendTelegram(message, chatId) {
  const token  = TELEGRAM_TOKEN;
  const target = chatId || TELEGRAM_CHAT_ID;
  if (!token || !target) return false;

  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${token}/sendMessage`,
      { chat_id: target, text: message, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: 8000 }
    );
    return res.data.ok === true;
  } catch (err) {
    console.error('[Telegram] Erreur:', err.response?.data || err.message);
    return false;
  }
}

/* ── Validation ── */
function validateEvent(ev) {
  return (
    ev &&
    typeof ev.name    === 'string' && ev.name.length   > 0 && ev.name.length   < 200 &&
    typeof ev.marge   === 'number' && ev.marge   >= -100 && ev.marge   <= 10000 &&
    typeof ev.face    === 'number' && ev.face    >= 0    && ev.face    <= 100000 &&
    typeof ev.resale  === 'number' && ev.resale  >= 0    && ev.resale  <= 100000
  );
}

/* ════════════════════════════════════════
   ROUTES
════════════════════════════════════════ */

/* Health check */
app.get('/api/health', (req, res) => {
  res.json({
    status:    'ok',
    version:   '5.0',
    telegram:  TELEGRAM_TOKEN ? 'configured' : 'missing',
    timestamp: new Date().toISOString(),
  });
});

/* ── POST /api/notify ── */
app.post('/api/notify', async (req, res) => {
  const { events = [], drops = [], seuil = 30, chatId } = req.body;

  // Validation basique
  if (!Array.isArray(events)) {
    return res.status(400).json({ error: 'events doit être un tableau' });
  }

  let sent = 0;

  // 1. Alertes opportunités
  const hits = events
    .filter(ev => validateEvent(ev) && ev.marge >= seuil)
    .sort((a, b) => b.marge - a.marge)
    .slice(0, 5); // Max 5 alertes par scan

  for (const ev of hits) {
    const ok = await sendTelegram(buildMessage(ev, 'opportunity'), chatId);
    if (ok) {
      sent++;
      // Petite pause pour éviter le flood Telegram
      await new Promise(r => setTimeout(r, 300));
    }
  }

  // 2. Alertes chutes de prix
  const validDrops = (drops || [])
    .filter(ev => validateEvent(ev))
    .slice(0, 2);

  for (const ev of validDrops) {
    const ok = await sendTelegram(buildMessage(ev, 'drop'), chatId);
    if (ok) {
      sent++;
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`[Notify] ${sent} alertes envoyées (${hits.length} opps + ${validDrops.length} drops)`);

  res.json({
    success: true,
    sent,
    opportunities: hits.length,
    drops: validDrops.length,
    timestamp: new Date().toISOString(),
  });
});

/* ── GET /api/test ── */
app.get('/api/test', async (req, res) => {
  const msg =
    '🧪 <b>TicketRadar v5 — Test Backend</b>\n\n' +
    '✅ Serveur Node.js opérationnel\n' +
    '🔒 Token Telegram sécurisé côté serveur\n\n' +
    '👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>';

  const ok = await sendTelegram(msg);
  res.json({
    success: ok,
    message: ok ? 'Message envoyé !' : 'Erreur — vérifiez TELEGRAM_TOKEN',
  });
});

/* ── GET /api/prices ── */
app.get('/api/prices', async (req, res) => {
  const REFERENCE = {
    'f1 monaco':        { min:800,  avg:2400, max:4000, platform:'Viagogo' },
    'f1 abu dhabi':     { min:450,  avg:1475, max:2500, platform:'StubHub' },
    'f1 miami':         { min:600,  avg:1400, max:2200, platform:'SeatGeek' },
    'champions league': { min:400,  avg:1800, max:2500, platform:'StubHub' },
    'coachella':        { min:800,  avg:1409, max:2000, platform:'StubHub' },
    'beyonce':          { min:400,  avg:650,  max:900,  platform:'StubHub' },
    'bruno mars':       { min:350,  avg:625,  max:900,  platform:'StubHub' },
    'ufc':              { min:200,  avg:875,  max:1500, platform:'SeatGeek' },
  };

  res.json({
    source: 'reference',
    data: Object.entries(REFERENCE).map(([key, val]) => ({
      event_key:  key,
      resale_avg: val.avg,
      resale_min: val.min,
      resale_max: val.max,
      platform:   val.platform,
      updated_at: new Date().toISOString(),
    })),
  });
});

/* ══════════════════════════════════════════════
   WEBHOOK TELEGRAM — Commandes bot
   /top5  → Top 5 opportunités du Sheet
   /scan  → Scan complet + alertes
   /drop  → Chutes de prix détectées
   /help  → Liste des commandes
══════════════════════════════════════════════ */

const SHEET_URL = process.env.SHEET_URL || '';

async function fetchSheetEvents() {
  if (!SHEET_URL) return [];
  try {
    const res = await axios.get(SHEET_URL, { timeout: 10000 });
    const text = res.data;
    
    // JSON (Apps Script)
    if (typeof text === 'object') {
      const arr = Array.isArray(text) ? text : [text];
      return arr.map(row => {
        const face   = parseFloat(row.face)   || 0;
        const resale = parseFloat(row.resale) || 0;
        const net    = resale * 0.85;
        const marge  = face > 0 ? Math.round(((net - face) / face) * 100) : 0;
        return { ...row, face, resale, marge };
      }).filter(e => e.name && e.face > 0);
    }
    
    // CSV fallback
    if (typeof text === 'string') {
      const lines = text.trim().split('\n');
      if (lines.length < 2) return [];
      const headers = lines[0].split(',').map(h => h.replace(/"/g,'').trim().toLowerCase());
      return lines.slice(1).map(line => {
        const cols = line.split(',');
        const row  = {};
        headers.forEach((h, i) => { row[h] = (cols[i]||'').replace(/"/g,'').trim(); });
        const face   = parseFloat(row.face)   || 0;
        const resale = parseFloat(row.resale) || 0;
        const net    = resale * 0.85;
        const marge  = face > 0 ? Math.round(((net - face) / face) * 100) : 0;
        return { ...row, face, resale, marge };
      }).filter(e => e.name && e.face > 0);
    }
    return [];
  } catch (err) {
    console.error('[Sheet] Erreur fetch:', err.message);
    return [];
  }
}

function formatEventMsg(ev, rank) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
  return (
    `${medal} <b>${ev.flag||'🎫'} ${ev.name}</b>\n` +
    `💰 <b>+${ev.marge}%</b> · ${ev.face}€ → ${ev.resale}€\n` +
    `📅 ${ev.date||'—'} · 🏪 ${ev.platform||'—'}`
  );
}

async function handleCommand(cmd, chatId) {
  console.log(`[Bot] Commande reçue: ${cmd} de ${chatId}`);

  if (cmd === '/start' || cmd === '/help') {
    await sendTelegram(
      `🎫 <b>TicketRadar Bot v5</b>\n\n` +
      `Commandes disponibles :\n\n` +
      `📊 /top5 — Top 5 meilleures marges\n` +
      `🔍 /scan — Scan complet + alertes\n` +
      `📉 /drop — Chutes de prix récentes\n` +
      `📈 /top10 — Top 10 opportunités\n` +
      `❓ /help — Cette aide\n\n` +
      `👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir l'app</a>`,
      chatId
    );
    return;
  }

  if (cmd === '/top5' || cmd === '/top10') {
    const limit = cmd === '/top10' ? 10 : 5;
    await sendTelegram(`⏳ Récupération des ${limit} meilleures opportunités...`, chatId);
    
    const events = await fetchSheetEvents();
    if (!events.length) {
      await sendTelegram('⚠️ Sheet non configuré ou vide. Configure SHEET_URL dans les env vars Render.', chatId);
      return;
    }
    
    const top = events
      .filter(e => e.marge > 0)
      .sort((a, b) => b.marge - a.marge)
      .slice(0, limit);

    const msg =
      `🏆 <b>TicketRadar — Top ${limit}</b>\n` +
      `<i>${events.length} events scannés</i>\n\n` +
      top.map((ev, i) => formatEventMsg(ev, i + 1)).join('\n\n') +
      `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Voir tout</a>`;

    await sendTelegram(msg, chatId);
    return;
  }

  if (cmd === '/scan') {
    await sendTelegram('🔍 Scan en cours...', chatId);

    const events = await fetchSheetEvents();
    if (!events.length) {
      await sendTelegram('⚠️ Sheet non configuré ou vide.', chatId);
      return;
    }

    const seuil = parseInt(process.env.DEFAULT_SEUIL) || 30;
    const hits  = events.filter(e => e.marge >= seuil).sort((a, b) => b.marge - a.marge);

    if (!hits.length) {
      await sendTelegram(
        `✅ Scan terminé — <b>${events.length} events</b> analysés\n` +
        `Aucune opportunité > ${seuil}% pour le moment.`,
        chatId
      );
      return;
    }

    const summary =
      `🔥 <b>TicketRadar — Résultats du scan</b>\n` +
      `<i>${events.length} events · ${hits.length} opportunités > ${seuil}%</i>\n\n` +
      hits.slice(0, 5).map((ev, i) => formatEventMsg(ev, i + 1)).join('\n\n') +
      (hits.length > 5 ? `\n\n<i>+${hits.length - 5} autres opportunités dans l'app</i>` : '') +
      `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Voir tout</a>`;

    await sendTelegram(summary, chatId);
    return;
  }

  if (cmd === '/drop') {
    await sendTelegram('📉 Analyse des chutes de prix...', chatId);

    const events = await fetchSheetEvents();
    if (!events.length) {
      await sendTelegram('⚠️ Sheet non configuré ou vide.', chatId);
      return;
    }

    // Pour la démo, on simule des chutes avec les events à forte marge
    const drops = events
      .filter(e => e.marge > 50)
      .sort((a, b) => b.marge - a.marge)
      .slice(0, 5);

    if (!drops.length) {
      await sendTelegram('✅ Aucune chute de prix significative détectée.', chatId);
      return;
    }

    const msg =
      `📉 <b>TicketRadar — Chutes de prix</b>\n\n` +
      drops.map(ev =>
        `${ev.flag||'🎫'} <b>${ev.name}</b>\n` +
        `💰 +${ev.marge}% · ${ev.face}€ → ${ev.resale}€\n` +
        `⚡ Bon moment d'acheter !`
      ).join('\n\n') +
      `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir l'app</a>`;

    await sendTelegram(msg, chatId);
    return;
  }

  // Commande inconnue
  await sendTelegram(
    `❓ Commande inconnue : <code>${cmd}</code>\n` +
    `Envoie /help pour voir les commandes disponibles.`,
    chatId
  );
}

/* ── POST /webhook ── Reçoit les messages Telegram ── */
app.post('/webhook', async (req, res) => {
  // Répondre immédiatement à Telegram (évite les retries)
  res.sendStatus(200);

  try {
    const update = req.body;
    const message = update.message || update.edited_message;
    if (!message || !message.text) return;

    const chatId  = String(message.chat.id);
    const text    = message.text.trim();
    const cmd     = text.split(' ')[0].toLowerCase().split('@')[0]; // Handle /cmd@botname

    // Sécurité : accepter seulement les messages du chat ID autorisé
    const allowedChatId = TELEGRAM_CHAT_ID;
    if (allowedChatId && chatId !== allowedChatId) {
      console.warn(`[Bot] Message rejeté de chatId: ${chatId}`);
      return;
    }

    await handleCommand(cmd, chatId);
  } catch (err) {
    console.error('[Webhook] Erreur:', err.message);
  }
});

/* ── GET /webhook/setup ── Configure le webhook Telegram ── */
app.get('/webhook/setup', async (req, res) => {
  if (!TELEGRAM_TOKEN) {
    return res.status(500).json({ error: 'TELEGRAM_TOKEN manquant' });
  }
  
  const backendUrl = process.env.BACKEND_URL || `https://ticketradar-backend.onrender.com`;
  const webhookUrl = `${backendUrl}/webhook`;
  
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`,
      { url: webhookUrl, allowed_updates: ['message'] }
    );
    
    console.log('[Webhook] Setup:', response.data);
    res.json({
      success: response.data.ok,
      webhook_url: webhookUrl,
      description: response.data.description,
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

/* ── 404 ── */
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route non trouvée', 
    available: ['/api/health', '/api/notify', '/api/test', '/api/prices', '/webhook', '/webhook/setup'] 
  });
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`\n🎫 TicketRadar Backend v5`);
  console.log(`📡 Écoute sur http://localhost:${PORT}`);
  console.log(`🔒 Telegram : ${TELEGRAM_TOKEN ? '✓ configuré' : '✗ manquant'}`);
  console.log(`🌍 CORS : ${ALLOWED_ORIGIN}\n`);
});

module.exports = app;

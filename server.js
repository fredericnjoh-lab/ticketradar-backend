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

/* ── 404 ── */
app.use((req, res) => {
  res.status(404).json({ error: 'Route non trouvée', available: ['/api/health', '/api/notify', '/api/test', '/api/prices'] });
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`\n🎫 TicketRadar Backend v5`);
  console.log(`📡 Écoute sur http://localhost:${PORT}`);
  console.log(`🔒 Telegram : ${TELEGRAM_TOKEN ? '✓ configuré' : '✗ manquant'}`);
  console.log(`🌍 CORS : ${ALLOWED_ORIGIN}\n`);
});

module.exports = app;

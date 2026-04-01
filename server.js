/* ═══════════════════════════════════════════════════
   TicketRadar — server.js (Backend Node.js) v6.1
   Endpoints :
   GET  /api/health        → Health check
   GET  /api/scan          → Scanner TM + SeatGeek + Sheet
   GET  /api/scan/top      → Top opportunités rapide
   POST /api/notify        → Alertes Telegram
   POST /api/ai            → Proxy Anthropic API
   POST /api/countdown     → Alertes J-7/J-3/J-1
   GET  /api/countdown/check
   POST /webhook           → Bot Telegram
═══════════════════════════════════════════════════ */

const express   = require('express');
const cors      = require('cors');
const axios     = require('axios');
const rateLimit = require('express-rate-limit');
require('dotenv').config();

const app  = express();
const PORT = process.env.PORT || 3000;

/* ── Env vars ── */
const TELEGRAM_TOKEN         = process.env.TELEGRAM_TOKEN;
const TELEGRAM_CHAT_ID       = process.env.TELEGRAM_CHAT_ID;
const ALLOWED_ORIGIN         = process.env.ALLOWED_ORIGIN || 'https://fredericnjoh-lab.github.io';
const SEATGEEK_CLIENT_ID     = process.env.SEATGEEK_CLIENT_ID     || '';
const SEATGEEK_CLIENT_SECRET = process.env.SEATGEEK_CLIENT_SECRET || '';
const TICKETMASTER_API_KEY   = process.env.TICKETMASTER_API_KEY   || '';
const ANTHROPIC_API_KEY      = process.env.ANTHROPIC_API_KEY      || '';
const SHEET_URL              = process.env.SHEET_URL              || '';

if (!TELEGRAM_TOKEN)       console.warn('⚠ TELEGRAM_TOKEN manquant');
if (!TELEGRAM_CHAT_ID)     console.warn('⚠ TELEGRAM_CHAT_ID manquant');
if (!SEATGEEK_CLIENT_ID)   console.warn('⚠ SEATGEEK_CLIENT_ID manquant — /api/scan limité');
if (!TICKETMASTER_API_KEY) console.warn('⚠ TICKETMASTER_API_KEY manquant — /api/scan limité');
if (!ANTHROPIC_API_KEY)    console.warn('⚠ ANTHROPIC_API_KEY manquant — /api/ai désactivé');

/* ── Middlewares ── */
app.set('trust proxy', 1);
app.use(cors({
  origin: [ALLOWED_ORIGIN, 'http://localhost:3000', 'http://127.0.0.1:5500'],
  methods: ['GET', 'POST'],
  allowedHeaders: ['Content-Type'],
}));
app.use(express.json({ limit: '100kb' }));

/* ── Rate limiting ── */
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 100,
  message: { error: 'Trop de requêtes, réessaie dans 15 minutes' },
});
app.use('/api/', limiter);

/* ══════════════════════════════════════════════
   HELPERS
══════════════════════════════════════════════ */

function countryToFlag(code) {
  const map = {
    FR:'🇫🇷', GB:'🇬🇧', UK:'🇬🇧', US:'🇺🇸', DE:'🇩🇪', ES:'🇪🇸',
    IT:'🇮🇹', NL:'🇳🇱', BE:'🇧🇪', CH:'🇨🇭', MC:'🇲🇨', JP:'🇯🇵',
    AU:'🇦🇺', CA:'🇨🇦', PT:'🇵🇹', AT:'🇦🇹', SE:'🇸🇪', NO:'🇳🇴',
  };
  return map[(code || '').toUpperCase()] || '🎫';
}

function validateEvent(ev) {
  return (
    ev &&
    typeof ev.name   === 'string' && ev.name.length > 0 && ev.name.length < 200 &&
    typeof ev.marge  === 'number' && ev.marge  >= -100 && ev.marge  <= 10000 &&
    typeof ev.face   === 'number' && ev.face   >= 0    && ev.face   <= 100000 &&
    typeof ev.resale === 'number' && ev.resale >= 0    && ev.resale <= 100000
  );
}

function formatEventMsg(ev, rank) {
  const medal = rank === 1 ? '🥇' : rank === 2 ? '🥈' : rank === 3 ? '🥉' : `${rank}.`;
  return (
    `${medal} <b>${ev.flag||'🎫'} ${ev.name}</b>\n` +
    `💰 <b>+${ev.marge}%</b> · ${ev.face}€ → ${ev.resale}€\n` +
    `📅 ${ev.date||'—'} · 🏪 ${ev.platform||'—'}`
  );
}

function buildMessage(ev, type = 'opportunity') {
  if (type === 'drop') {
    const pct = ev.prevResale
      ? Math.round(((ev.resale - ev.prevResale) / ev.prevResale) * 100)
      : 0;
    return (
      `📉 <b>TicketRadar — Chute de prix !</b>\n\n` +
      `${ev.flag||'🎫'} <b>${ev.name}</b>\n` +
      `📉 Baisse : <b>${pct}%</b>\n` +
      `💰 ${ev.prevResale}€ → <b>${ev.resale}€</b>\n` +
      `⚡ BON MOMENT D'ACHETER\n\n` +
      `👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`
    );
  }
  return (
    `🔥 <b>TicketRadar — Opportunité !</b>\n\n` +
    `${ev.flag||'🎫'} <b>${ev.name}</b>\n` +
    `💰 Marge : <b>+${ev.marge}%</b>\n` +
    `🎫 ${ev.face}€ → <b>${ev.resale}€</b>\n` +
    `📅 ${ev.date||''}\n` +
    `🏪 ${ev.platform||''}\n\n` +
    `👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`
  );
}

async function sendTelegram(message, chatId) {
  const target = chatId || TELEGRAM_CHAT_ID;
  if (!TELEGRAM_TOKEN || !target) return false;
  try {
    const res = await axios.post(
      `https://api.telegram.org/bot${TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: target, text: message, parse_mode: 'HTML', disable_web_page_preview: true },
      { timeout: 8000 }
    );
    return res.data.ok === true;
  } catch (err) {
    console.error('[Telegram] Erreur:', err.response?.data || err.message);
    return false;
  }
}

function getDaysUntil(dateStr) {
  if (!dateStr) return null;
  const months = {
    'jan':0,'fév':1,'feb':1,'mar':2,'avr':3,'apr':3,'mai':4,'may':4,
    'jun':5,'juin':5,'jul':6,'juil':6,'aug':7,'aoû':7,'sep':8,'oct':9,
    'nov':10,'déc':11,'dec':11
  };
  let date = new Date(dateStr);
  if (!isNaN(date)) {
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((date - today) / (1000*60*60*24));
  }
  const match = dateStr.match(/(\d+)(?:-\d+)?\s+([a-zéû]+)\s+(\d{4})/i);
  if (match) {
    const day   = parseInt(match[1]);
    const month = months[match[2].toLowerCase().slice(0,3)];
    const year  = parseInt(match[3]);
    if (month !== undefined) {
      date = new Date(year, month, day);
      const today = new Date(); today.setHours(0,0,0,0);
      return Math.round((date - today) / (1000*60*60*24));
    }
  }
  return null;
}

/* ══════════════════════════════════════════════
   DATA SOURCES
══════════════════════════════════════════════ */

async function fetchSheetEvents() {
  if (!SHEET_URL) return [];
  console.log('[Sheet] Fetching:', SHEET_URL.slice(0, 60));
  try {
    const res = await axios.get(SHEET_URL, {
      timeout: 15000, maxRedirects: 5,
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; TicketRadar/6.0)', 'Accept': 'application/json, text/plain, */*' }
    });
    const text = res.data;
    if (typeof text === 'object') {
      const arr = Array.isArray(text) ? text : [text];
      return arr.map(row => {
        const face   = parseFloat(row.face)   || 0;
        const resale = parseFloat(row.resale) || 0;
        const marge  = face > 0 ? Math.round(((resale * 0.85 - face) / face) * 100) : 0;
        return { ...row, face, resale, marge };
      }).filter(e => e.name && e.face > 0);
    }
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
        const marge  = face > 0 ? Math.round(((resale * 0.85 - face) / face) * 100) : 0;
        return { ...row, face, resale, marge };
      }).filter(e => e.name && e.face > 0);
    }
    return [];
  } catch (err) {
    console.error('[Sheet] Erreur:', err.message);
    return [];
  }
}

async function fetchSeatGeekEvents(query = '', perPage = 50) {
  if (!SEATGEEK_CLIENT_ID) return [];
  try {
    const params = new URLSearchParams({ client_id: SEATGEEK_CLIENT_ID, per_page: perPage, sort: 'score.desc' });
    if (query) params.set('q', query);
    const res = await axios.get(`https://api.seatgeek.com/2/events?${params}`, { timeout: 10000 });
    return (res.data.events || []).map(ev => {
      const stats    = ev.stats || {};
      const lowest   = stats.lowest_price || 0;
      const face     = lowest * 0.65;
      const marge    = face > 0 ? Math.round(((lowest - face) / face) * 100) : 0;
      const taxonomy = (ev.taxonomies || [])[0] || {};
      return {
        source: 'seatgeek', sg_id: ev.id,
        name: ev.title || ev.short_title || '',
        date: ev.datetime_local ? ev.datetime_local.slice(0,10) : '',
        venue: ev.venue?.name || '', city: ev.venue?.city || '',
        country: ev.venue?.country || '', cat: taxonomy.name || 'event',
        platform: 'SeatGeek', face: Math.round(face),
        resale: lowest, resale_avg: stats.average_price || 0,
        resale_max: stats.highest_price || 0,
        score: Math.round((ev.score || 0) * 10) / 10,
        marge, url: ev.url || '', flag: countryToFlag(ev.venue?.country),
      };
    }).filter(e => e.name && e.resale > 0);
  } catch (err) {
    console.error('[SeatGeek] Erreur:', err.message);
    return [];
  }
}

async function fetchTicketmasterEvents(query = '', size = 100) {
  if (!TICKETMASTER_API_KEY) return [];
  try {
    const now   = new Date();
    const later = new Date(now); later.setFullYear(later.getFullYear() + 1);
    const params = new URLSearchParams({
      apikey: TICKETMASTER_API_KEY,
      size:   String(Math.min(size, 100)),
      sort:   'relevance,desc',
      includeTBA: 'no', includeTBD: 'no',
      countryCode: 'US,GB',
      startDateTime: now.toISOString().slice(0,19) + 'Z',
      endDateTime:   later.toISOString().slice(0,19) + 'Z',
    });
    if (query) { params.set('keyword', query); }
    else        { params.set('classificationName', 'music'); }

    const url = `https://app.ticketmaster.com/discovery/v2/events.json?${params}`;
    console.log('[TM] URL:', url.replace(TICKETMASTER_API_KEY, '***'));
    const res    = await axios.get(url, { timeout: 12000 });
    const events = res.data?._embedded?.events || [];
    console.log('[TM] Events:', events.length);

    return events.map(ev => {
      const priceRanges = ev.priceRanges || [];
      const mins  = priceRanges.map(p => p.min).filter(v => v > 0);
      const maxes = priceRanges.map(p => p.max).filter(v => v > 0);
      const face  = mins.length  ? Math.min(...mins)  : 0;
      const faceMax = maxes.length ? Math.max(...maxes) : 0;
      const resale  = faceMax > face ? faceMax : 0;
      const marge   = face > 0 && resale > 0 ? Math.round(((resale * 0.85 - face) / face) * 100) : 0;
      const taxonomy    = (ev.classifications || [])[0] || {};
      const segment     = taxonomy.segment?.name?.toLowerCase() || 'event';
      const countryCode = ev._embedded?.venues?.[0]?.country?.countryCode || '';
      return {
        source: 'ticketmaster', tm_id: ev.id,
        name: ev.name || '', date: ev.dates?.start?.localDate || '',
        venue: ev._embedded?.venues?.[0]?.name || '',
        city:  ev._embedded?.venues?.[0]?.city?.name || '',
        country: countryCode, cat: segment, platform: 'Ticketmaster',
        face, face_max: faceMax, resale: resale || 0,
        score: Math.round((ev.score || 0) * 10) / 10,
        marge, url: ev.url || '', flag: countryToFlag(countryCode),
        discovered: face === 0,
      };
    }).filter(e => e.name);
  } catch (err) {
    console.error('[Ticketmaster] Erreur:', err.message);
    if (err.response) console.error('[TM]', err.response.status, JSON.stringify(err.response.data).slice(0,200));
    return [];
  }
}

function dedupeEvents(events) {
  const seen = new Map();
  return events.filter(ev => {
    const key = ev.name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

/* ══════════════════════════════════════════════
   ROUTES
══════════════════════════════════════════════ */

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok', version: '6.1',
    telegram:     TELEGRAM_TOKEN       ? 'configured' : 'missing',
    seatgeek:     SEATGEEK_CLIENT_ID   ? 'configured' : 'missing',
    ticketmaster: TICKETMASTER_API_KEY ? 'configured' : 'missing',
    anthropic:    ANTHROPIC_API_KEY    ? 'configured' : 'missing',
    sheet:        SHEET_URL            ? 'configured' : 'missing',
    endpoints: ['/api/scan', '/api/scan/top', '/api/notify', '/api/ai', '/api/countdown'],
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/scan', async (req, res) => {
  const { q = '', seuil = 0, limit = 50, source = 'all', sheet = 'true' } = req.query;
  const minMarge = parseInt(seuil) || 0;
  const maxLimit = Math.min(parseInt(limit) || 50, 100);
  const startTime = Date.now();
  console.log(`[Scan] Démarrage — query="${q}" seuil=${minMarge}% source=${source}`);
  try {
    const [sgRes, tmRes, shRes] = await Promise.allSettled([
      source !== 'ticketmaster' ? fetchSeatGeekEvents(q, 50)       : Promise.resolve([]),
      source !== 'seatgeek'     ? fetchTicketmasterEvents(q, 100)   : Promise.resolve([]),
      sheet === 'true'          ? fetchSheetEvents()                : Promise.resolve([]),
    ]);
    const sg     = sgRes.status === 'fulfilled' ? sgRes.value : [];
    const tm     = tmRes.status === 'fulfilled' ? tmRes.value : [];
    const manual = shRes.status === 'fulfilled' ? shRes.value : [];

    const all = dedupeEvents([...manual, ...sg, ...tm])
      .filter(ev => ev.marge >= minMarge || (minMarge === 0 && ev.discovered))
      .sort((a, b) => b.marge - a.marge)
      .slice(0, maxLimit);

    const elapsed = Date.now() - startTime;
    console.log(`[Scan] Terminé — ${sg.length} SG + ${tm.length} TM + ${manual.length} sheet → ${all.length} résultats (${elapsed}ms)`);

    const hotEvents = all.filter(ev => ev.marge >= 100).slice(0, 3);
    if (hotEvents.length && TELEGRAM_CHAT_ID) {
      const alertMsg =
        `🔥 <b>TicketRadar — ${hotEvents.length} opportunité${hotEvents.length > 1 ? 's' : ''} live !</b>\n\n` +
        hotEvents.map((ev, i) => formatEventMsg(ev, i + 1)).join('\n\n') +
        `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`;
      sendTelegram(alertMsg).catch(() => {});
    }

    res.json({
      success: true, total: all.length,
      sources: { seatgeek: sg.length, ticketmaster: tm.length, sheet: manual.length },
      elapsed_ms: elapsed, events: all, timestamp: new Date().toISOString(),
    });
  } catch (err) {
    console.error('[Scan] Erreur:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

app.get('/api/scan/top', async (req, res) => {
  const seuil = parseInt(req.query.seuil) || 30;
  try {
    const [sg, manual] = await Promise.all([fetchSeatGeekEvents('', 30), fetchSheetEvents()]);
    const all = dedupeEvents([...manual, ...sg])
      .filter(ev => ev.marge >= seuil)
      .sort((a, b) => b.marge - a.marge)
      .slice(0, 10);
    res.json({ total: all.length, events: all, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/api/notify', async (req, res) => {
  const { events = [], drops = [], seuil = 30, chatId } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events doit être un tableau' });
  let sent = 0;
  const hits = events.filter(ev => validateEvent(ev) && ev.marge >= seuil).sort((a,b) => b.marge-a.marge).slice(0,5);
  for (const ev of hits) {
    const ok = await sendTelegram(buildMessage(ev, 'opportunity'), chatId);
    if (ok) { sent++; await new Promise(r => setTimeout(r, 300)); }
  }
  const validDrops = (drops || []).filter(validateEvent).slice(0,2);
  for (const ev of validDrops) {
    const ok = await sendTelegram(buildMessage(ev, 'drop'), chatId);
    if (ok) { sent++; await new Promise(r => setTimeout(r, 300)); }
  }
  console.log(`[Notify] ${sent} alertes envoyées`);
  res.json({ success: true, sent, opportunities: hits.length, drops: validDrops.length, timestamp: new Date().toISOString() });
});

/* ── POST /api/ai ── Proxy Anthropic (évite CORS) ── */
app.post('/api/ai', async (req, res) => {
  if (!ANTHROPIC_API_KEY) {
    return res.status(503).json({ error: 'ANTHROPIC_API_KEY non configuré' });
  }
  const { question, context } = req.body;
  if (!question || typeof question !== 'string' || question.length > 500) {
    return res.status(400).json({ error: 'question requise (max 500 caractères)' });
  }
  try {
    const requestBody = {
      model: 'claude-sonnet-4-20250514',
      max_tokens: 400,
      system: `You are a ticket resale expert. Current market context: ${(context || '').slice(0, 1000)}. Detect the language of the user's question and always respond in that same language. Keep answers to 2-3 sentences max, direct and actionable.`,
      messages: [{ role: 'user', content: String(question) }],
    };
    console.log('[AI] Calling Anthropic for:', String(question).slice(0, 80));
    const response = await axios.post('https://api.anthropic.com/v1/messages', requestBody, {
      timeout: 30000,
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
    });
    const answer = response.data?.content?.[0]?.text || '';
    res.json({ answer });
  } catch (err) {
    console.error('[AI] Erreur:', err.response?.data || err.message);
    res.status(502).json({ error: 'Erreur API Anthropic: ' + (err.response?.data?.error?.message || err.message) });
  }
});

/* ── Telegram Bot ── */
async function handleCommand(cmd, chatId) {
  if (cmd === '/start' || cmd === '/help') {
    await sendTelegram(
      `🎫 <b>TicketRadar Bot v6</b>\n\n📊 /top5 — Top 5 marges\n🔍 /scan — Scan complet\n📉 /drop — Chutes de prix\n📈 /top10 — Top 10\n❓ /help — Aide\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir l'app</a>`,
      chatId
    );
    return;
  }
  if (cmd === '/top5' || cmd === '/top10') {
    const limit = cmd === '/top10' ? 10 : 5;
    const events = await fetchSheetEvents();
    if (!events.length) { await sendTelegram('⚠️ Sheet vide.', chatId); return; }
    const top = events.filter(e => e.marge > 0).sort((a,b) => b.marge-a.marge).slice(0, limit);
    await sendTelegram(
      `🏆 <b>Top ${limit}</b>\n<i>${events.length} events</i>\n\n` +
      top.map((ev,i) => formatEventMsg(ev, i+1)).join('\n\n') +
      `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Voir tout</a>`,
      chatId
    );
    return;
  }
  if (cmd === '/scan') {
    const events = await fetchSheetEvents();
    if (!events.length) { await sendTelegram('⚠️ Sheet vide.', chatId); return; }
    const seuil = parseInt(process.env.DEFAULT_SEUIL) || 30;
    const hits  = events.filter(e => e.marge >= seuil).sort((a,b) => b.marge-a.marge);
    if (!hits.length) { await sendTelegram(`✅ Aucune opportunité > ${seuil}%`, chatId); return; }
    await sendTelegram(
      `🔥 <b>${hits.length} opportunités > ${seuil}%</b>\n\n` +
      hits.slice(0,5).map((ev,i) => formatEventMsg(ev,i+1)).join('\n\n') +
      `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Voir tout</a>`,
      chatId
    );
    return;
  }
  if (cmd === '/drop') {
    const events = await fetchSheetEvents();
    const drops  = events.filter(e => e.marge > 50).sort((a,b) => b.marge-a.marge).slice(0,5);
    if (!drops.length) { await sendTelegram('✅ Aucune chute détectée.', chatId); return; }
    await sendTelegram(
      `📉 <b>Chutes de prix</b>\n\n` +
      drops.map(ev => `${ev.flag||'🎫'} <b>${ev.name}</b>\n💰 +${ev.marge}% · ${ev.face}€ → ${ev.resale}€`).join('\n\n') +
      `\n\n👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir l'app</a>`,
      chatId
    );
    return;
  }
  await sendTelegram(`❓ Commande inconnue: <code>${cmd}</code>\nEnvoie /help`, chatId);
}

app.post('/webhook', async (req, res) => {
  res.sendStatus(200);
  try {
    const message = req.body.message || req.body.edited_message;
    if (!message?.text) return;
    const chatId = String(message.chat.id);
    if (TELEGRAM_CHAT_ID && chatId !== TELEGRAM_CHAT_ID) return;
    const cmd = message.text.trim().split(' ')[0].toLowerCase().split('@')[0];
    await handleCommand(cmd, chatId);
  } catch (err) { console.error('[Webhook]', err.message); }
});

app.get('/webhook/setup', async (req, res) => {
  if (!TELEGRAM_TOKEN) return res.status(500).json({ error: 'TELEGRAM_TOKEN manquant' });
  const backendUrl = process.env.BACKEND_URL || 'https://ticketradar-backend.onrender.com';
  try {
    const response = await axios.post(`https://api.telegram.org/bot${TELEGRAM_TOKEN}/setWebhook`, { url: `${backendUrl}/webhook`, allowed_updates: ['message'] });
    res.json({ success: response.data.ok, webhook_url: `${backendUrl}/webhook` });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

/* ── Countdown J-7/J-3/J-1 ── */
async function sendCountdownAlerts(events, chatId) {
  let sent = 0;
  for (const ev of events) {
    if (!ev.name || !ev.date) continue;
    const days = getDaysUntil(ev.date);
    if (days === null || ![7,3,1].includes(days)) continue;
    const urgency = days === 1 ? '🚨' : days === 3 ? '⚡' : '📅';
    const label   = days === 1 ? 'DEMAIN !' : `J-${days}`;
    const msg =
      `${urgency} <b>Rappel ${label}</b>\n\n${ev.flag||'🎫'} <b>${ev.name}</b>\n` +
      `📅 ${ev.date}\n💰 <b>+${ev.marge}%</b>\n🎫 ${ev.face}€ → ${ev.resale}€\n\n` +
      `👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">TicketRadar</a>`;
    const ok = await sendTelegram(msg, chatId);
    if (ok) { sent++; await new Promise(r => setTimeout(r, 300)); }
  }
  return sent;
}

app.post('/api/countdown', async (req, res) => {
  const { events = [], chatId } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events requis' });
  const valid    = events.filter(validateEvent);
  const sent     = await sendCountdownAlerts(valid, chatId);
  const upcoming = valid.map(ev => ({ name: ev.name, date: ev.date, days: getDaysUntil(ev.date), marge: ev.marge }))
    .filter(e => e.days !== null && e.days >= 0 && e.days <= 30)
    .sort((a,b) => a.days - b.days);
  res.json({ sent, upcoming, timestamp: new Date().toISOString() });
});

app.get('/api/countdown/check', async (req, res) => {
  const events   = await fetchSheetEvents();
  const upcoming = events.map(ev => ({ name: ev.name, date: ev.date, days: getDaysUntil(ev.date), marge: ev.marge, flag: ev.flag }))
    .filter(e => e.days !== null && e.days >= 0 && e.days <= 30)
    .sort((a,b) => a.days - b.days);
  res.json({ total: events.length, upcoming, timestamp: new Date().toISOString() });
});

function scheduleCountdownCheck() {
  async function runCheck() {
    console.log('[Countdown] Check quotidien...');
    try {
      const events = await fetchSheetEvents();
      if (!events.length) return;
      const sent = await sendCountdownAlerts(events, TELEGRAM_CHAT_ID);
      if (sent > 0) console.log(`[Countdown] ${sent} alertes J-X envoyées`);
    } catch(err) { console.error('[Countdown]', err.message); }
  }
  setTimeout(runCheck, 5000);
  setInterval(runCheck, 24 * 60 * 60 * 1000);
}
scheduleCountdownCheck();

/* ── 404 ── */
app.use((req, res) => {
  res.status(404).json({
    error: 'Route non trouvée',
    available: ['/api/health', '/api/scan', '/api/scan/top', '/api/notify', '/api/ai', '/api/countdown', '/api/countdown/check', '/webhook', '/webhook/setup']
  });
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`\n🎫 TicketRadar Backend v6.1`);
  console.log(`📡 Port ${PORT}`);
  console.log(`🔒 Telegram : ${TELEGRAM_TOKEN ? '✓' : '✗'}`);
  console.log(`🎵 Ticketmaster : ${TICKETMASTER_API_KEY ? '✓' : '✗'}`);
  console.log(`🎟  SeatGeek : ${SEATGEEK_CLIENT_ID ? '✓' : '✗'}`);
  console.log(`🤖 Anthropic : ${ANTHROPIC_API_KEY ? '✓' : '✗'}\n`);
});

module.exports = app;

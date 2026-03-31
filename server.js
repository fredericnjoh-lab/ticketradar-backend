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

const SEATGEEK_CLIENT_ID     = process.env.SEATGEEK_CLIENT_ID     || '';
const SEATGEEK_CLIENT_SECRET = process.env.SEATGEEK_CLIENT_SECRET || '';
const TICKETMASTER_API_KEY   = process.env.TICKETMASTER_API_KEY   || '';

if (!SEATGEEK_CLIENT_ID)   console.warn('⚠ SEATGEEK_CLIENT_ID manquant — /api/scan limité');
if (!TICKETMASTER_API_KEY) console.warn('⚠ TICKETMASTER_API_KEY manquant — /api/scan limité');

/* ── Middlewares ── */
app.set('trust proxy', 1); // Render est derrière un reverse proxy

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
    status:      'ok',
    version:     '6.0',
    telegram:    TELEGRAM_TOKEN       ? 'configured' : 'missing',
    seatgeek:    SEATGEEK_CLIENT_ID   ? 'configured' : 'missing',
    ticketmaster: TICKETMASTER_API_KEY ? 'configured' : 'missing',
    sheet:       SHEET_URL            ? 'configured' : 'missing',
    chat_id:     TELEGRAM_CHAT_ID     ? 'configured' : 'missing',
    endpoints:   ['/api/scan', '/api/scan/top', '/api/notify', '/api/countdown'],
    timestamp:   new Date().toISOString(),
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


/* ════════════════════════════════════════
   SCAN ENGINE — SeatGeek + Ticketmaster
════════════════════════════════════════ */

/**
 * Fetch events from SeatGeek API
 * Docs: https://developer.seatgeek.com
 */
async function fetchSeatGeekEvents(query = '', perPage = 50) {
  if (!SEATGEEK_CLIENT_ID) return [];
  try {
    const params = new URLSearchParams({
      client_id: SEATGEEK_CLIENT_ID,
      per_page:  perPage,
      sort:      'score.desc',
    });
    if (query) params.set('q', query);

    const url = `https://api.seatgeek.com/2/events?${params}`;
    const res = await axios.get(url, { timeout: 10000 });
    return (res.data.events || []).map(ev => {
      const stats    = ev.stats || {};
      const lowest   = stats.lowest_price || 0;
      const avg      = stats.average_price || 0;
      const face     = stats.list_price_change != null ? lowest * 0.7 : lowest * 0.65; // estimate face value
      const marge    = face > 0 ? Math.round(((lowest - face) / face) * 100) : 0;
      const taxonomy = (ev.taxonomies || [])[0] || {};
      return {
        source:      'seatgeek',
        sg_id:       ev.id,
        name:        ev.title || ev.short_title || '',
        date:        ev.datetime_local ? ev.datetime_local.slice(0,10) : '',
        venue:       ev.venue ? ev.venue.name : '',
        city:        ev.venue ? ev.venue.city : '',
        country:     ev.venue ? (ev.venue.country || '') : '',
        cat:         taxonomy.name || 'event',
        platform:    'SeatGeek',
        face:        Math.round(face),
        resale:      lowest,
        resale_avg:  avg,
        resale_max:  stats.highest_price || 0,
        score:       Math.round((ev.score || 0) * 10) / 10,
        marge,
        url:         ev.url || '',
        flag:        countryToFlag(ev.venue ? ev.venue.country : ''),
      };
    }).filter(e => e.name && e.resale > 0);
  } catch (err) {
    console.error('[SeatGeek] Erreur:', err.message);
    return [];
  }
}

/**
 * Fetch events from Ticketmaster Discovery API
 * Docs: https://developer.ticketmaster.com
 */
async function fetchTicketmasterEvents(query = '', size = 100) {
  if (!TICKETMASTER_API_KEY) return [];
  try {
    // Step 1: Discovery — find events
    const now   = new Date();
    const later = new Date(now);
    later.setFullYear(later.getFullYear() + 1);

    // TM ne supporte qu'un seul countryCode — 2 appels parallèles US + GB
    const buildUrl = (country) => {
      let url = 'https://app.ticketmaster.com/discovery/v2/events.json'
        + '?apikey='        + TICKETMASTER_API_KEY
        + '&size='          + Math.min(Math.ceil(size / 2), 50)
        + '&countryCode='   + country
        + '&startDateTime=' + now.toISOString().slice(0,19) + 'Z'
        + '&endDateTime='   + later.toISOString().slice(0,19) + 'Z';
      if (query) {
        url += '&keyword=' + encodeURIComponent(query);
      } else {
        url += '&classificationName=music';
      }
      return url;
    };

    const urlUS = buildUrl('US');
    const urlGB = buildUrl('GB');
    console.log('[TM] URL US:', urlUS.replace(TICKETMASTER_API_KEY, '***'));

    const [resUS, resGB] = await Promise.allSettled([
      axios.get(urlUS, { timeout: 12000 }),
      axios.get(urlGB, { timeout: 12000 }),
    ]);

    const evUS = resUS.status === 'fulfilled' ? (resUS.value.data?._embedded?.events || []) : [];
    const evGB = resGB.status === 'fulfilled' ? (resGB.value.data?._embedded?.events || []) : [];
    const events = [...evUS, ...evGB];
    console.log('[TM] Events:', evUS.length, 'US +', evGB.length, 'GB =', events.length, 'total');

    // Step 2 : construire les events depuis Discovery
    // priceRanges souvent absent sur plan gratuit → on garde tous les events
    const results = [];

    events.forEach(ev => {
      const taxonomy   = (ev.classifications || [])[0] || {};
      const segment    = taxonomy.segment?.name?.toLowerCase() || 'event';
      const venue      = ev._embedded?.venues?.[0] || {};
      const country    = venue.country?.countryCode || '';
      const popularity = ev.score || 0;
      const priceRange = (ev.priceRanges || [])[0] || {};
      const face       = priceRange.min || 0;
      const faceMax    = priceRange.max || face;

      // Estimation resale si prix dispo, sinon marge = 0
      let resale = 0;
      let marge  = 0;
      if (face >= 30) {
        const spread     = faceMax > face ? (faceMax / face) : 1;
        const multiplier = Math.min(3.5, 1.15 + (spread - 1) * 0.4 + popularity * 1.5);
        resale = Math.round(face * multiplier);
        marge  = Math.round(((resale * 0.85 - face) / face) * 100);
      }

      results.push({
        source:     'ticketmaster',
        tm_id:      ev.id,
        name:       ev.name || '',
        date:       ev.dates?.start?.localDate || '',
        venue:      venue.name || '',
        city:       venue.city?.name || '',
        country,
        cat:        segment,
        platform:   'Ticketmaster',
        face,
        face_max:   faceMax,
        resale,
        score:      Math.round(popularity * 10) / 10,
        marge,
        url:        ev.url || '',
        flag:       countryToFlag(country),
        discovered: face === 0, // event sans prix = découverte, pas encore coté
      });
    });

    console.log(`[TM] ${results.length} events extraits (${results.filter(e=>e.face>0).length} avec prix)`);
    return results;
  } catch (err) {
    console.error('[Ticketmaster] Erreur:', err.message);
    if (err.response) console.error('[TM] Response:', err.response.status, JSON.stringify(err.response.data).slice(0,200));
    return [];
  }
}

/**
 * Country code → flag emoji
 */
function countryToFlag(code) {
  const map = {
    FR:'🇫🇷', GB:'🇬🇧', UK:'🇬🇧', US:'🇺🇸', DE:'🇩🇪', ES:'🇪🇸',
    IT:'🇮🇹', NL:'🇳🇱', BE:'🇧🇪', CH:'🇨🇭', MC:'🇲🇨', JP:'🇯🇵',
    AU:'🇦🇺', CA:'🇨🇦', PT:'🇵🇹', AT:'🇦🇹', SE:'🇸🇪', NO:'🇳🇴',
  };
  return map[(code || '').toUpperCase()] || '🎫';
}

/**
 * Deduplicate events from multiple sources by name similarity
 */
function dedupeEvents(events) {
  const seen = new Map();
  return events.filter(ev => {
    const key = ev.name.toLowerCase().replace(/[^a-z0-9]/g,'').slice(0,20);
    if (seen.has(key)) return false;
    seen.set(key, true);
    return true;
  });
}

/* ── GET /api/scan ── Main scanner endpoint ── */
app.get('/api/scan', async (req, res) => {
  const {
    q        = '',           // search query (optional)
    seuil    = 0,            // min margin % filter
    limit    = 50,           // max results
    source   = 'all',        // 'seatgeek' | 'ticketmaster' | 'all'
    sheet    = 'true',       // include sheet events
  } = req.query;

  const minMarge = parseInt(seuil) || 0;
  const maxLimit = Math.min(parseInt(limit) || 50, 100);
  const startTime = Date.now();

  console.log(`[Scan] Démarrage — query="${q}" seuil=${minMarge}% source=${source}`);

  try {
    // Fetch all sources in parallel
    const [sgEvents, tmEvents, sheetEvents] = await Promise.allSettled([
      source !== 'ticketmaster' ? fetchSeatGeekEvents(q, 50) : Promise.resolve([]),
      source !== 'seatgeek'     ? fetchTicketmasterEvents(q, 100) : Promise.resolve([]),
      sheet === 'true'          ? fetchSheetEvents() : Promise.resolve([]),
    ]);

    const sg     = sgEvents.status     === 'fulfilled' ? sgEvents.value     : [];
    const tm     = tmEvents.status     === 'fulfilled' ? tmEvents.value     : [];
    const manual = sheetEvents.status  === 'fulfilled' ? sheetEvents.value  : [];

    // Merge + dedupe + filter
    const all = dedupeEvents([...sg, ...tm, ...manual])
      .filter(ev => ev.marge >= minMarge || (minMarge === 0 && ev.discovered))
      .sort((a, b) => {
        // Events avec prix en premier, puis découvertes par date
        if (a.marge !== b.marge) return b.marge - a.marge;
        if (a.discovered !== b.discovered) return a.discovered ? 1 : -1;
        return 0;
      })
      .slice(0, maxLimit);

    const elapsed = Date.now() - startTime;
    console.log(`[Scan] Terminé — ${sg.length} SG + ${tm.length} TM + ${manual.length} sheet → ${all.length} résultats (${elapsed}ms)`);

    // Auto-alert via Telegram if high-margin events found
    const hotEvents = all.filter(ev => ev.marge >= 100).slice(0, 3);
    if (hotEvents.length && TELEGRAM_CHAT_ID) {
      const alertMsg =
        `🔥 <b>TicketRadar — ${hotEvents.length} opportunité${hotEvents.length > 1 ? 's' : ''} live !</b>

` +
        hotEvents.map((ev, i) => formatEventMsg(ev, i + 1)).join('\n\n') +
        `

👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`;
      sendTelegram(alertMsg).catch(() => {}); // fire-and-forget
    }

    res.json({
      success:   true,
      total:     all.length,
      sources:   { seatgeek: sg.length, ticketmaster: tm.length, sheet: manual.length },
      elapsed_ms: elapsed,
      events:    all,
      timestamp: new Date().toISOString(),
    });

  } catch (err) {
    console.error('[Scan] Erreur critique:', err.message);
    res.status(500).json({ success: false, error: err.message });
  }
});

/* ── GET /api/scan/top ── Top opportunités rapide ── */
app.get('/api/scan/top', async (req, res) => {
  const seuil = parseInt(req.query.seuil) || 30;
  try {
    const [sg, manual] = await Promise.all([
      fetchSeatGeekEvents('', 50),
      fetchSheetEvents(),
    ]);
    const all = dedupeEvents([...sg, ...manual])
      .filter(ev => ev.marge >= seuil)
      .sort((a, b) => b.marge - a.marge)
      .slice(0, 10);
    res.json({ total: all.length, events: all, timestamp: new Date().toISOString() });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
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
  if (!SHEET_URL) {
    console.log('[Sheet] SHEET_URL non configuré');
    return [];
  }
  console.log('[Sheet] Fetching:', SHEET_URL.slice(0, 60));
  try {
    const res = await axios.get(SHEET_URL, { 
      timeout: 15000,
      maxRedirects: 5,
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; TicketRadar/5.0)',
        'Accept': 'application/json, text/plain, */*',
      }
    });
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

/* ══════════════════════════════════════════════
   COUNTDOWN ALERTS — J-7, J-3, J-1
══════════════════════════════════════════════ */

function getDaysUntil(dateStr) {
  if (!dateStr) return null;
  // Handle various date formats: "5-7 juin 2026", "30 mars 2026", "2026-06-05"
  const months = {
    'jan':0,'fév':1,'feb':1,'mar':2,'avr':3,'apr':3,'mai':4,'may':4,
    'jun':5,'juin':5,'jul':6,'juil':6,'aug':7,'aoû':7,'sep':8,'oct':9,
    'nov':10,'déc':11,'dec':11
  };
  
  // Try ISO format first
  let date = new Date(dateStr);
  if (!isNaN(date)) {
    const today = new Date(); today.setHours(0,0,0,0);
    return Math.round((date - today) / (1000*60*60*24));
  }
  
  // Try French format "30 mars 2026" or "5-7 juin 2026"
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

async function sendCountdownAlerts(events, chatId) {
  const ALERT_DAYS = [7, 3, 1];
  let sent = 0;

  for (const ev of events) {
    if (!ev.name || !ev.date) continue;
    const days = getDaysUntil(ev.date);
    if (days === null || !ALERT_DAYS.includes(days)) continue;

    const urgency = days === 1 ? '🚨' : days === 3 ? '⚡' : '📅';
    const label   = days === 1 ? 'DEMAIN !' : `J-${days}`;
    const msg =
      `${urgency} <b>TicketRadar — Rappel ${label}</b>

` +
      `${ev.flag||'🎫'} <b>${ev.name}</b>
` +
      `📅 ${ev.date}
` +
      `💰 Marge actuelle : <b>+${ev.marge}%</b>
` +
      `🎫 ${ev.face}€ → ${ev.resale}€
` +
      `🏪 ${ev.platform||'—'}

` +
      (days === 1
        ? `⚠️ <b>Dernier jour pour vendre !</b>
`
        : days === 3
        ? `💡 Plus que ${days} jours — bon moment pour vendre.
`
        : `📊 Une semaine avant l'event — surveille les prix.
`) +
      `
👉 <a href="https://fredericnjoh-lab.github.io/ticketradar/">Ouvrir TicketRadar</a>`;

    const ok = await sendTelegram(msg, chatId);
    if (ok) {
      sent++;
      await new Promise(r => setTimeout(r, 300));
    }
  }
  return sent;
}

/* ── POST /api/countdown ── */
app.post('/api/countdown', async (req, res) => {
  const { events = [], chatId } = req.body;
  if (!Array.isArray(events)) return res.status(400).json({ error: 'events requis' });

  const validEvents = events.filter(validateEvent);
  const sent = await sendCountdownAlerts(validEvents, chatId);

  // Also return which events have upcoming dates
  const upcoming = validEvents.map(ev => ({
    name: ev.name,
    date: ev.date,
    days: getDaysUntil(ev.date),
    marge: ev.marge,
  })).filter(e => e.days !== null && e.days >= 0 && e.days <= 30)
    .sort((a, b) => a.days - b.days);

  res.json({ sent, upcoming, timestamp: new Date().toISOString() });
});

/* ── GET /api/countdown/check ── Test countdown ── */
app.get('/api/countdown/check', async (req, res) => {
  const events = await fetchSheetEvents();
  const upcoming = events.map(ev => ({
    name: ev.name,
    date: ev.date,
    days: getDaysUntil(ev.date),
    marge: ev.marge,
    flag: ev.flag,
  })).filter(e => e.days !== null && e.days >= 0 && e.days <= 30)
    .sort((a, b) => a.days - b.days);

  res.json({ total: events.length, upcoming, timestamp: new Date().toISOString() });
});

/* ── Scheduled countdown check (toutes les 24h) ── */
function scheduleCountdownCheck() {
  const MS_24H = 24 * 60 * 60 * 1000;
  
  async function runCheck() {
    console.log('[Countdown] Check quotidien...');
    try {
      const events = await fetchSheetEvents();
      if (!events.length) return;
      const sent = await sendCountdownAlerts(events, TELEGRAM_CHAT_ID);
      if (sent > 0) console.log(`[Countdown] ${sent} alertes J-X envoyées`);
    } catch(err) {
      console.error('[Countdown] Erreur:', err.message);
    }
  }

  // Premier check après 5 secondes (au démarrage)
  setTimeout(runCheck, 5000);
  // Puis toutes les 24h
  setInterval(runCheck, MS_24H);
}

// Démarrer le scheduler
scheduleCountdownCheck();

/* ── 404 ── */
app.use((req, res) => {
  res.status(404).json({ 
    error: 'Route non trouvée', 
    available: ['/api/health', '/api/scan', '/api/scan/top', '/api/notify', '/api/test', '/api/countdown', '/api/countdown/check', '/webhook', '/webhook/setup'] 
  });
});

/* ── Start ── */
app.listen(PORT, () => {
  console.log(`\n🎫 TicketRadar Backend v6`);
  console.log(`📡 Écoute sur http://localhost:${PORT}`);
  console.log(`🔒 Telegram : ${TELEGRAM_TOKEN ? '✓ configuré' : '✗ manquant'}`);
  console.log(`🌍 CORS : ${ALLOWED_ORIGIN}\n`);
});

module.exports = app;

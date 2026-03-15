/**
 * PolyTracker Pro — Render Edition
 * קובץ יחיד, בדוק ונקי
 */

'use strict';

const express    = require('express');
const http       = require('http');
const WebSocket  = require('ws');
const axios      = require('axios');

// ─────────────────────────────────────────────
// ENV
// ─────────────────────────────────────────────
const ENV = {
  PORT:            process.env.PORT            || 3000,
  NEWS_API_KEY:    process.env.NEWS_API_KEY    || '',
  OPENAI_KEY:      process.env.OPENAI_KEY      || '',
  TELEGRAM_TOKEN:  process.env.TELEGRAM_TOKEN  || '',
  TELEGRAM_CHAT:   process.env.TELEGRAM_CHAT_ID|| '',
  POLYGON_RPC:     process.env.POLYGON_RPC     || 'https://polygon-rpc.com',
  WHALE_MIN:       Number(process.env.WHALE_MIN) || 10000,
};

// ─────────────────────────────────────────────
// STATE (declared before any usage)
// ─────────────────────────────────────────────
const state = {
  markets:  [],
  news:     [],
  wallets:  [],
  whaleCnt: 0,
  lastMarketFetch: 0,
};

// ─────────────────────────────────────────────
// EXPRESS + HTTP + WS
// ─────────────────────────────────────────────
const app    = express();
const server = http.createServer(app);
const wss    = new WebSocket.Server({ 
  server,
  perMessageDeflate: false
});

app.use(express.json());
app.disable('x-powered-by');
// Render WebSocket fix
app.use((req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  next();
});
// ─────────────────────────────────────────────
// BROADCAST
// ─────────────────────────────────────────────
function broadcast(type, data) {
  const msg = JSON.stringify({ type, data, ts: Date.now() });
  wss.clients.forEach(c => {
    if (c.readyState === WebSocket.OPEN) {
      try { c.send(msg); } catch (_) {}
    }
  });
}

// ─────────────────────────────────────────────
// WEBSOCKET
// ─────────────────────────────────────────────
wss.on('connection', (ws, req) => {
  const ip = req.headers['x-forwarded-for'] || req.socket.remoteAddress;
  console.log(`[WS] Client connected from ${ip} | total: ${wss.clients.size}`);

  // שלח snapshot מיידי
  if (state.markets.length) ws.send(JSON.stringify({ type: 'markets', data: state.markets }));
  if (state.news.length)    ws.send(JSON.stringify({ type: 'news',    data: state.news    }));
  if (state.wallets.length) ws.send(JSON.stringify({ type: 'wallets', data: state.wallets }));

  ws.on('error', err => console.error('[WS] Error:', err.message));
  ws.on('close', () => console.log(`[WS] Client disconnected | total: ${wss.clients.size}`));
});

// ─────────────────────────────────────────────
// HELPERS
// ─────────────────────────────────────────────
function fmtUSD(n) {
  if (!n || isNaN(n)) return '$0';
  if (n >= 1e9) return '$' + (n / 1e9).toFixed(1) + 'B';
  if (n >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return '$' + (n / 1e3).toFixed(0) + 'K';
  return '$' + Math.round(n);
}

function detectCategory(q) {
  q = (q || '').toLowerCase();
  if (/bitcoin|crypto|eth\b|btc|solana|defi|nft|coin/.test(q))           return 'crypto';
  if (/trump|biden|election|congress|senate|president|white house/.test(q)) return 'politics';
  if (/fed\b|federal reserve|rate\b|inflation|recession|gdp|cpi/.test(q)) return 'economy';
  if (/ukraine|russia|nato|iran|war|ceasefire|missile|israel/.test(q))    return 'geo';
  if (/apple|nvidia|tesla|openai|ai\b|tech|software|microsoft/.test(q))   return 'tech';
  if (/nba|nfl|soccer|world cup|champion|sport|match|game/.test(q))       return 'sports';
  return 'general';
}

function estimateImpact(title) {
  const t = (title || '').toLowerCase();
  if (/breaking|federal reserve|fed rate|trump signs|bitcoin etf|ceasefire|nuclear|sanctions|crash/.test(t)) return 'HIGH';
  if (/report|data|market|economy|election|crypto|policy|rate|inflation/.test(t)) return 'MEDIUM';
  return 'LOW';
}

function findRelatedMarkets(title) {
  const t = (title || '').toLowerCase();
  return [
    ['bitcoin',  'Bitcoin $150k'],
    ['fed ',     'Fed rate cut'],
    ['trump',    'Trump executive order'],
    ['ukraine',  'Ukraine ceasefire'],
    ['elon',     'Elon DOGE'],
    ['nvidia',   'Nvidia $200'],
    ['recession','US Recession 2025'],
    ['election', 'Election 2025'],
  ].filter(([k]) => t.includes(k)).map(([, v]) => v);
}

function scoreOpportunities() {
  const opps = state.markets
    .slice(0, 40)
    .map(m => {
      let score = 0;
      const factors = [];
      // נפח
      if (m.volume24h > 500000) { score += 30; factors.push('very_high_volume'); }
      else if (m.volume24h > 100000) { score += 20; factors.push('high_volume'); }
      else if (m.volume24h > 20000)  { score += 10; factors.push('med_volume');  }
      // הסתברות קיצונית = edge פוטנציאלי
      const p = m.yesPrice;
      if (p < 0.12 || p > 0.88) { score += 35; factors.push('extreme_prob'); }
      else if (p < 0.22 || p > 0.78) { score += 20; factors.push('skewed_prob'); }
      else if (p < 0.32 || p > 0.68) { score += 10; factors.push('off_center'); }
      // ליקווידיטי
      if (m.liquidity > 100000) { score += 20; factors.push('great_liquidity'); }
      else if (m.liquidity > 30000) { score += 10; factors.push('ok_liquidity'); }
      const ev = p > 0.5 ? (p / 0.5).toFixed(2) : ((1 - p) / 0.5).toFixed(2);
      return {
        market:         m,
        score:          Math.min(score, 100),
        factors,
        expectedValue:  ev,
        recommendation: score >= 65 ? 'STRONG BUY' : score >= 45 ? 'BUY' : 'WATCH',
        type:           factors.includes('extreme_prob') && m.volume24h > 50000 ? 'HIGH_EDGE' : 'STANDARD',
      };
    })
    .filter(o => o.score >= 35)
    .sort((a, b) => b.score - a.score)
    .slice(0, 9);
  if (opps.length) broadcast('opportunities', opps);
  return opps;
}

// ─────────────────────────────────────────────
// POLYMARKET FETCHER
// ─────────────────────────────────────────────
async function fetchMarkets() {
  try {
    const res = await axios.get('https://gamma-api.polymarket.com/markets', {
      params: {
        active:    true,
        closed:    false,
        limit:     100,
        order:     'volume24hr',
        ascending: false,
      },
      timeout: 12000,
      headers: { 'User-Agent': 'PolyTrackerPro/1.0' },
    });

    if (!Array.isArray(res.data)) throw new Error('Unexpected response shape');

    state.markets = res.data.map(m => ({
      id:        m.id,
      slug:      m.slug || '',
      question:  m.question || 'Unknown',
      category:  detectCategory(m.question),
      yesPrice:  parseFloat(m.outcomePrices?.[0]) || 0.5,
      volume24h: parseFloat(m.volume24hr) || 0,
      liquidity: parseFloat(m.liquidity)  || 0,
      url:       `https://polymarket.com/event/${m.slug || m.id}`,
    }));

    state.lastMarketFetch = Date.now();
    broadcast('markets', state.markets.slice(0, 60));
    scoreOpportunities();
    console.log(`[POLY] ${state.markets.length} markets fetched`);
  } catch (err) {
    console.error('[POLY] Error:', err.message);
  }
}

// ─────────────────────────────────────────────
// NEWS FETCHER
// ─────────────────────────────────────────────
async function fetchNews() {
  if (!ENV.NEWS_API_KEY) {
    console.log('[NEWS] No API key — skipping');
    return;
  }
  try {
    const res = await axios.get('https://newsapi.org/v2/everything', {
      params: {
        q:        'Federal Reserve OR Trump OR Bitcoin OR Ukraine OR "prediction market" OR Polymarket',
        language: 'en',
        sortBy:   'publishedAt',
        pageSize: 20,
        apiKey:   ENV.NEWS_API_KEY,
      },
      timeout: 10000,
    });

    state.news = (res.data.articles || [])
      .filter(a => a.title && !a.title.includes('[Removed]'))
      .map(a => ({
        title:           a.title,
        source:          a.source?.name || 'Unknown',
        url:             a.url,
        publishedAt:     a.publishedAt,
        impact:          estimateImpact(a.title),
        relevantMarkets: findRelatedMarkets(a.title),
      }));

    broadcast('news', state.news);

    // התרעות HIGH IMPACT
    state.news
      .filter(n => n.impact === 'HIGH')
      .slice(0, 3)
      .forEach(n => broadcast('news_alert', n));

    // Telegram
    const highItems = state.news.filter(n => n.impact === 'HIGH').slice(0, 2);
    for (const item of highItems) {
      await tgSend(`📰 <b>HIGH IMPACT</b>\n${item.title}\n🎯 ${item.relevantMarkets.join(', ')}`);
    }

    console.log(`[NEWS] ${state.news.length} articles fetched`);
  } catch (err) {
    console.error('[NEWS] Error:', err.message);
  }
}

// ─────────────────────────────────────────────
// WALLETS (The Graph)
// ─────────────────────────────────────────────
async function fetchWallets() {
  try {
    const query = `{
      users(
        first: 20
        orderBy: profit
        orderDirection: desc
        where: { numTrades_gt: "10" }
      ) {
        id
        numTrades
        profit
        collateralVolume
      }
    }`;

    const res = await axios.post(
      'https://api.thegraph.com/subgraphs/name/polymarket/polymarket-matic',
      { query },
      {
        timeout: 12000,
        headers: { 'Content-Type': 'application/json' },
      }
    );

    const users = res.data?.data?.users;
    if (!Array.isArray(users)) throw new Error('Bad Graph response');

    state.wallets = users.map(u => {
      const vol = parseFloat(u.collateralVolume) || 0;
      const pnl = parseFloat(u.profit) || 0;
      return {
        address:      u.id,
        shortAddress: u.id.slice(0, 6) + '...' + u.id.slice(-4),
        trades:       parseInt(u.numTrades) || 0,
        profit:       pnl,
        volume:       vol,
        roi:          vol > 0 ? Math.round((pnl / vol) * 100) : 0,
      };
    });

    broadcast('wallets', state.wallets);
    console.log(`[WALLETS] ${state.wallets.length} top wallets fetched`);
  } catch (err) {
    console.error('[WALLETS] Error:', err.message);
  }
}

// ─────────────────────────────────────────────
// TELEGRAM
// ─────────────────────────────────────────────
async function tgSend(msg) {
  if (!ENV.TELEGRAM_TOKEN || !ENV.TELEGRAM_CHAT) return;
  try {
    await axios.post(
      `https://api.telegram.org/bot${ENV.TELEGRAM_TOKEN}/sendMessage`,
      { chat_id: ENV.TELEGRAM_CHAT, text: msg, parse_mode: 'HTML' },
      { timeout: 5000 }
    );
  } catch (err) {
    console.error('[TG] Error:', err.message);
  }
}

// ─────────────────────────────────────────────
// ROUTES
// ─────────────────────────────────────────────
app.get('/',           (_req, res) => res.send(DESKTOP_HTML));
app.get('/mobile',     (_req, res) => res.send(MOBILE_HTML));
app.get('/api/health', (_req, res) => res.json({
  status:   'ok',
  markets:  state.markets.length,
  news:     state.news.length,
  wallets:  state.wallets.length,
  clients:  wss.clients.size,
  uptime:   Math.round(process.uptime()),
  lastFetch: new Date(state.lastMarketFetch).toISOString(),
}));
app.get('/api/markets', (_req, res) => res.json(state.markets));
app.get('/api/news',    (_req, res) => res.json(state.news));

// catch-all 404
app.use((_req, res) => res.status(404).json({ error: 'Not found' }));

// ─────────────────────────────────────────────
// START
// ─────────────────────────────────────────────
server.listen(ENV.PORT, async () => {
  console.log('\n══════════════════════════════════════');
  console.log(' 🚀  PolyTracker Pro — Render Edition');
  console.log('══════════════════════════════════════');
  console.log(` 📡  http://localhost:${ENV.PORT}`);
  console.log(` 📱  http://localhost:${ENV.PORT}/mobile`);
  console.log(` 💊  http://localhost:${ENV.PORT}/api/health`);
  console.log('──────────────────────────────────────');
  console.log(` NEWS_API_KEY:   ${ENV.NEWS_API_KEY   ? '✅ set' : '❌ missing'}`);
  console.log(` OPENAI_KEY:     ${ENV.OPENAI_KEY     ? '✅ set' : '⚠️  optional'}`);
  console.log(` TELEGRAM_TOKEN: ${ENV.TELEGRAM_TOKEN ? '✅ set' : '⚠️  optional'}`);
  console.log('──────────────────────────────────────\n');

  await fetchMarkets();
  await fetchNews();
  await fetchWallets();

  console.log('\n✅  PolyTracker Pro is LIVE!\n');
});

// ─────────────────────────────────────────────
// SCHEDULED JOBS
// ─────────────────────────────────────────────
setInterval(fetchMarkets, 30  * 1000);       // כל 30 שניות
setInterval(fetchNews,     5  * 60 * 1000);  // כל 5 דקות
setInterval(fetchWallets,  10 * 60 * 1000);  // כל 10 דקות

// ─────────────────────────────────────────────
// ERROR HANDLING
// ─────────────────────────────────────────────
process.on('unhandledRejection', (reason) => {
  console.error('[FATAL] Unhandled rejection:', reason);
});
process.on('uncaughtException', (err) => {
  console.error('[FATAL] Uncaught exception:', err.message);
});

// ─────────────────────────────────────────────
// DESKTOP HTML (inline)
// ─────────────────────────────────────────────
const DESKTOP_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>PolyTracker Pro</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Heebo:wght@300;400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#020408;--bg2:#060d14;--bg3:#0a1520;--ac:#00ff88;--ac2:#00d4ff;--ac3:#ff6b35;--dn:#ff3366;--gd:#ffd700;--tx:#e0eaf5;--tx2:#7a99b8;--br:#0d2035;}
*{margin:0;padding:0;box-sizing:border-box;}
body{background:var(--bg);color:var(--tx);font-family:'Heebo',sans-serif;overflow-x:hidden;}
body::before{content:'';position:fixed;inset:0;background-image:linear-gradient(rgba(0,255,136,.03)1px,transparent 1px),linear-gradient(90deg,rgba(0,255,136,.03)1px,transparent 1px);background-size:44px 44px;pointer-events:none;z-index:0;}
/* HEADER */
header{position:sticky;top:0;z-index:100;background:rgba(2,4,8,.97);backdrop-filter:blur(20px);border-bottom:1px solid var(--br);padding:0 22px;height:58px;display:flex;align-items:center;justify-content:space-between;gap:12px;}
.logo{display:flex;align-items:center;gap:10px;}
.logo-i{width:34px;height:34px;background:linear-gradient(135deg,var(--ac),var(--ac2));border-radius:9px;display:flex;align-items:center;justify-content:center;font-size:17px;box-shadow:0 0 18px rgba(0,255,136,.35);}
.logo h1{font-size:18px;font-weight:800;letter-spacing:.5px;}
.logo span{color:var(--ac);}
.hstats{display:flex;gap:22px;}
.hs-v{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;color:var(--ac);}
.hs-l{font-size:9px;color:var(--tx2);text-transform:uppercase;letter-spacing:.8px;}
.live-pill{display:flex;align-items:center;gap:5px;background:rgba(255,51,102,.1);border:1px solid rgba(255,51,102,.3);padding:5px 11px;border-radius:16px;font-size:11px;font-weight:700;color:var(--dn);}
.ldot{width:7px;height:7px;background:var(--dn);border-radius:50%;animation:pulse 1.5s infinite;}
@keyframes pulse{0%,100%{opacity:1;transform:scale(1);}50%{opacity:.4;transform:scale(1.4);}}
/* CONN BAR */
.conn-bar{padding:5px 22px;font-size:10px;font-family:'Space Mono',monospace;display:flex;align-items:center;gap:8px;background:var(--bg2);border-bottom:1px solid var(--br);}
.conn-dot{width:7px;height:7px;border-radius:50%;}
/* NAV */
.nav-tabs{display:flex;gap:3px;padding:13px 22px 0;border-bottom:1px solid var(--br);overflow-x:auto;scrollbar-width:none;}
.nav-tabs::-webkit-scrollbar{display:none;}
.tab{padding:9px 16px;border-radius:7px 7px 0 0;cursor:pointer;font-size:12px;font-weight:600;color:var(--tx2);transition:all .2s;border:1px solid transparent;border-bottom:none;white-space:nowrap;user-select:none;display:flex;align-items:center;gap:5px;}
.tab:hover{color:var(--tx);background:var(--bg3);}
.tab.on{color:var(--ac);background:var(--bg3);border-color:var(--br);border-bottom:1px solid var(--bg3);margin-bottom:-1px;}
.tbadge{background:var(--ac);color:var(--bg);font-size:9px;padding:1px 5px;border-radius:8px;font-weight:800;}
.tbadge-o{background:var(--ac3)!important;}
/* MAIN */
.main{position:relative;z-index:1;padding:18px 22px 72px;}
.tc{display:none;}.tc.on{display:block;}
/* GRIDS */
.g4{display:grid;grid-template-columns:repeat(4,1fr);gap:13px;margin-bottom:18px;}
.g3{display:grid;grid-template-columns:repeat(3,1fr);gap:13px;margin-bottom:16px;}
.g2{display:grid;grid-template-columns:1fr 1fr;gap:13px;margin-bottom:16px;}
/* CARD */
.card{background:var(--bg2);border:1px solid var(--br);border-radius:12px;padding:17px;transition:border-color .2s;}
.card:hover{border-color:rgba(0,255,136,.2);}
.c-val{font-family:'Space Mono',monospace;font-size:26px;font-weight:700;color:var(--ac);line-height:1.1;}
.c-lbl{font-size:10px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:1.2px;margin-bottom:10px;}
.c-sub{font-size:11px;color:var(--tx2);margin-top:5px;}
/* SECTION */
.sec-h{display:flex;align-items:center;justify-content:space-between;margin-bottom:14px;}
.sec-t{font-size:15px;font-weight:800;display:flex;align-items:center;gap:8px;}
.sec-t::before{content:'';width:3px;height:18px;background:var(--ac);border-radius:2px;box-shadow:0 0 12px rgba(0,255,136,.4);}
/* BUTTONS */
.btn{padding:7px 14px;border-radius:7px;border:none;cursor:pointer;font-size:11px;font-weight:700;font-family:'Heebo',sans-serif;transition:all .2s;}
.btn-p{background:var(--ac);color:var(--bg);}.btn-p:hover{background:#00cc6e;box-shadow:0 0 16px rgba(0,255,136,.3);}
.btn-o{background:transparent;border:1px solid var(--br);color:var(--tx2);}.btn-o:hover{border-color:var(--ac);color:var(--ac);}
/* TABLE */
.tbl{width:100%;border-collapse:collapse;}
.tbl th{text-align:right;font-size:9px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:.8px;padding:9px 11px;border-bottom:1px solid var(--br);}
.tbl td{padding:11px 11px;border-bottom:1px solid rgba(13,32,53,.5);font-size:12px;vertical-align:middle;}
.tbl tr:hover td{background:rgba(0,255,136,.025);}
.t-q{font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:270px;}
.t-cat{background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.2);color:var(--ac2);font-size:9px;padding:2px 7px;border-radius:4px;font-weight:700;}
.t-vol{font-family:'Space Mono',monospace;font-size:11px;color:var(--gd);}
.sbadge{display:inline-flex;align-items:center;padding:3px 7px;border-radius:5px;font-size:10px;font-weight:700;}
.sb-hot{background:rgba(255,107,53,.15);border:1px solid rgba(255,107,53,.4);color:var(--ac3);}
.sb-buy{background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.3);color:var(--ac);}
.sb-wrn{background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.3);color:var(--gd);}
/* WHALE TX */
.wtx{display:flex;align-items:center;gap:10px;padding:10px;border-radius:8px;transition:background .15s;animation:slideIn .3s ease;}
@keyframes slideIn{from{opacity:0;transform:translateX(14px);}to{opacity:1;transform:translateX(0);}}
.wtx:hover{background:rgba(0,255,136,.03);}
.w-ico{width:34px;height:34px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:15px;flex-shrink:0;}
.wi-big{background:rgba(0,212,255,.15);border:1px solid rgba(0,212,255,.3);}
.wi-sm{background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.2);}
.wi-md{background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.2);}
/* ALERTS */
.al-item{display:flex;align-items:flex-start;gap:10px;padding:13px;border-radius:10px;border-left:3px solid;animation:slideIn .4s ease;margin-bottom:8px;}
.al-w{background:rgba(0,212,255,.05);border-color:var(--ac2);}
.al-s{background:rgba(0,255,136,.05);border-color:var(--ac);}
.al-n{background:rgba(255,107,53,.05);border-color:var(--ac3);}
.al-ico{font-size:18px;min-width:22px;}
.al-body{flex:1;}
.al-title{font-weight:700;font-size:13px;margin-bottom:3px;}
.al-desc{font-size:11px;color:var(--tx2);line-height:1.5;}
.al-btns{margin-top:7px;display:flex;gap:6px;}
.al-time{font-family:'Space Mono',monospace;font-size:9px;color:var(--tx2);white-space:nowrap;}
/* NEWS */
.n-item{padding:14px;border-bottom:1px solid var(--br);display:flex;gap:10px;}
.n-item:hover{background:rgba(0,255,136,.02);}
.n-src{font-size:9px;font-weight:800;text-transform:uppercase;padding:2px 7px;border-radius:4px;white-space:nowrap;align-self:flex-start;margin-top:2px;}
.ns-r{background:rgba(255,107,53,.2);color:var(--ac3);}
.ns-b{background:rgba(0,212,255,.2);color:var(--ac2);}
.ns-a{background:rgba(255,215,0,.2);color:var(--gd);}
.ns-n{background:rgba(255,51,102,.2);color:var(--dn);}
.ns-w{background:rgba(0,255,136,.2);color:var(--ac);}
.n-imp{padding:2px 7px;border-radius:4px;font-size:9px;font-weight:700;}
.ni-h{background:rgba(255,51,102,.2);color:var(--dn);}
.ni-m{background:rgba(255,215,0,.2);color:var(--gd);}
/* OPP CARDS */
.opp-card{background:var(--bg2);border:1px solid var(--br);border-radius:12px;padding:15px;position:relative;overflow:hidden;transition:all .2s;}
.opp-card:hover{transform:translateY(-2px);box-shadow:0 8px 24px rgba(0,0,0,.3);}
.opp-card::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
.oc-buy::before{background:linear-gradient(90deg,var(--ac),transparent);}
.oc-sell::before{background:linear-gradient(90deg,var(--dn),transparent);}
.oc-arb::before{background:linear-gradient(90deg,var(--gd),transparent);}
.oc-type{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1.2px;margin-bottom:7px;}
.oc-buy .oc-type{color:var(--ac);}
.oc-sell .oc-type{color:var(--dn);}
.oc-arb .oc-type{color:var(--gd);}
.oc-title{font-size:12px;font-weight:700;margin-bottom:5px;line-height:1.4;}
.oc-desc{font-size:10px;color:var(--tx2);line-height:1.5;margin-bottom:10px;}
.oc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;}
.ocs{background:var(--bg3);border-radius:6px;padding:6px;}
.ocs-v{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;}
.ocs-l{font-size:8px;color:var(--tx2);margin-top:2px;text-transform:uppercase;}
/* CHART */
.chart-box{background:var(--bg2);border:1px solid var(--br);border-radius:12px;padding:17px;height:185px;display:flex;align-items:flex-end;gap:3px;overflow:hidden;}
/* WALLET */
.wlt-card{background:var(--bg2);border:1px solid var(--br);border-radius:12px;padding:15px;display:flex;flex-direction:column;gap:10px;transition:all .2s;}
.wlt-card:hover{border-color:rgba(0,255,136,.3);}
.wlt-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:7px;}
.wst{background:var(--bg3);border-radius:8px;padding:8px;text-align:center;}
.wst-v{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;}
.wst-l{font-size:9px;color:var(--tx2);margin-top:2px;}
/* FILTER */
.filter-bar{display:flex;gap:7px;margin-bottom:14px;flex-wrap:wrap;align-items:center;}
.chip{padding:5px 12px;border-radius:16px;border:1px solid var(--br);color:var(--tx2);font-size:11px;font-weight:600;cursor:pointer;transition:all .15s;background:transparent;font-family:'Heebo',sans-serif;}
.chip:hover,.chip.on{background:rgba(0,255,136,.1);border-color:var(--ac);color:var(--ac);}
.search-inp{background:var(--bg2);border:1px solid var(--br);border-radius:8px;padding:7px 12px;color:var(--tx);font-size:12px;font-family:'Heebo',sans-serif;outline:none;min-width:200px;}
.search-inp:focus{border-color:var(--ac);}
/* NOTIF */
.notif-pop{position:fixed;top:72px;left:18px;background:var(--bg2);border:1px solid var(--ac);border-radius:13px;padding:15px;max-width:330px;box-shadow:0 0 32px rgba(0,255,136,.2);z-index:500;display:none;animation:popIn .3s cubic-bezier(.34,1.56,.64,1);}
@keyframes popIn{from{opacity:0;transform:translateY(-10px) scale(.95);}to{opacity:1;transform:translateY(0) scale(1);}}
.notif-pop.show{display:block;}
/* STATUS BAR */
.status-bar{position:fixed;bottom:0;left:0;right:0;background:rgba(6,13,20,.97);border-top:1px solid var(--br);padding:6px 22px;display:flex;align-items:center;gap:14px;font-size:10px;color:var(--tx2);z-index:100;}
.sb-dot{width:5px;height:5px;border-radius:50%;}
.ticker-wrap{flex:1;overflow:hidden;}
.ticker{white-space:nowrap;animation:ticker 60s linear infinite;}
.ticker span{color:var(--ac);font-weight:700;}
@keyframes ticker{from{transform:translateX(100%);}to{transform:translateX(-200%);}}
::-webkit-scrollbar{width:5px;height:5px;}
::-webkit-scrollbar-track{background:var(--bg);}
::-webkit-scrollbar-thumb{background:var(--br);border-radius:3px;}
@media(max-width:1100px){.g4{grid-template-columns:repeat(2,1fr);}}
@media(max-width:650px){.g4,.g3,.g2{grid-template-columns:1fr;}.hstats{display:none;}}
@keyframes flashNew{0%{background:rgba(0,255,136,.14);}100%{background:transparent;}}
.new-row{animation:flashNew .7s ease;}
</style>
</head>
<body>

<!-- NOTIFICATION POPUP -->
<div class="notif-pop" id="notifPop">
  <div style="display:flex;align-items:center;gap:8px;margin-bottom:9px;">
    <span id="np-icon" style="font-size:21px;"></span>
    <strong id="np-title" style="font-size:13px;color:var(--ac);flex:1;"></strong>
    <button onclick="closeNotif()" style="background:none;border:none;color:var(--tx2);cursor:pointer;font-size:18px;line-height:1;">×</button>
  </div>
  <div id="np-body" style="font-size:12px;color:var(--tx2);line-height:1.55;"></div>
  <div style="margin-top:10px;display:flex;gap:7px;">
    <button class="btn btn-p" id="np-action" style="font-size:11px;padding:5px 12px;flex:1;"></button>
    <button class="btn btn-o" onclick="closeNotif()" style="font-size:11px;padding:5px 12px;">✓ סמן</button>
  </div>
</div>

<header>
  <div class="logo">
    <div class="logo-i">📊</div>
    <h1>Poly<span>Tracker</span> Pro</h1>
  </div>
  <div class="hstats">
    <div><div class="hs-v" id="h-vol">—</div><div class="hs-l">נפח 24h</div></div>
    <div><div class="hs-v" id="h-mkt">—</div><div class="hs-l">שווקים</div></div>
    <div><div class="hs-v" id="h-wh" style="color:var(--gd)">0</div><div class="hs-l">ווייל</div></div>
    <div><div class="hs-v" id="h-op" style="color:var(--ac3)">0</div><div class="hs-l">הזדמנויות</div></div>
  </div>
  <div style="display:flex;align-items:center;gap:10px;">
    <button class="btn btn-o" onclick="goTab('alerts')" style="font-size:10px;position:relative;">
      🔔<span id="notif-cnt" style="background:var(--dn);color:#fff;padding:1px 4px;border-radius:7px;font-size:9px;display:none;margin-right:3px;">0</span>
    </button>
    <div class="live-pill"><div class="ldot"></div>LIVE</div>
  </div>
</header>

<div class="conn-bar">
  <div class="conn-dot" id="conn-dot" style="background:var(--gd);animation:pulse 1s infinite;"></div>
  <span id="conn-status">מתחבר...</span>
  <span style="margin-right:auto;font-size:9px;color:var(--tx2);" id="last-upd"></span>
</div>

<div class="nav-tabs">
  <div class="tab on" onclick="switchTab(this,'overview')">📈 סקירה</div>
  <div class="tab" onclick="switchTab(this,'markets')">🏪 שווקים</div>
  <div class="tab" onclick="switchTab(this,'whales')">🐋 ווייל <span class="tbadge" id="tb-wh">0</span></div>
  <div class="tab" onclick="switchTab(this,'alerts')">⚡ התרעות <span class="tbadge tbadge-o" id="tb-al">0</span></div>
  <div class="tab" onclick="switchTab(this,'news')">📰 חדשות</div>
  <div class="tab" onclick="switchTab(this,'opps')">💰 הזדמנויות</div>
  <div class="tab" onclick="switchTab(this,'wallets')">🧠 ארנקים</div>
</div>

<div class="main">

<!-- OVERVIEW -->
<div class="tc on" id="tab-overview">
  <div class="g4">
    <div class="card"><div class="c-lbl">💵 נפח 24h</div><div class="c-val" id="ov-vol">—</div></div>
    <div class="card"><div class="c-lbl">🐋 עסקאות ווייל</div><div class="c-val" style="color:var(--gd)" id="ov-wh">0</div></div>
    <div class="card"><div class="c-lbl">⚡ הזדמנויות</div><div class="c-val" style="color:var(--ac3)" id="ov-op">0</div></div>
    <div class="card"><div class="c-lbl">📰 חדשות HIGH</div><div class="c-val" style="color:var(--dn)" id="ov-nw">0</div></div>
  </div>
  <div class="g2">
    <div>
      <div class="sec-h"><div class="sec-t">📊 נפח לפי שעה</div></div>
      <div class="chart-box" id="chart-vol"></div>
    </div>
    <div>
      <div class="sec-h"><div class="sec-t">🐋 ווייל עכשיו</div><button class="btn btn-o" onclick="goTab('whales')" style="font-size:10px;">הכל ←</button></div>
      <div class="card" style="padding:7px;max-height:185px;overflow-y:auto;"><div id="ov-whale-feed"></div></div>
    </div>
  </div>
  <div class="sec-h"><div class="sec-t">🔥 שווקים חמים</div></div>
  <div class="card" style="padding:0;overflow:hidden;overflow-x:auto;">
    <table class="tbl"><thead><tr><th>שוק</th><th>קטגוריה</th><th>YES%</th><th>נפח</th><th>סיגנל</th></tr></thead>
    <tbody id="ov-markets-body"></tbody></table>
  </div>
</div>

<!-- MARKETS -->
<div class="tc" id="tab-markets">
  <div class="filter-bar">
    <input class="search-inp" id="mkt-search" type="text" placeholder="🔍 חפש שוק..." oninput="renderAllMkts()">
    <button class="chip on" onclick="setChip(this,'all')">הכל</button>
    <button class="chip" onclick="setChip(this,'politics')">🏛️ פוליטיקה</button>
    <button class="chip" onclick="setChip(this,'crypto')">₿ קריפטו</button>
    <button class="chip" onclick="setChip(this,'economy')">📊 כלכלה</button>
    <button class="chip" onclick="setChip(this,'tech')">💻 טק</button>
    <button class="chip" onclick="setChip(this,'geo')">🌍 גיאו</button>
    <button class="chip" onclick="setChip(this,'sports')">⚽ ספורט</button>
    <span id="mkt-cnt" style="margin-right:auto;font-size:11px;color:var(--tx2);">0 שווקים</span>
  </div>
  <div class="card" style="padding:0;overflow:hidden;overflow-x:auto;">
    <table class="tbl"><thead><tr><th>#</th><th>שוק</th><th>קטגוריה</th><th>YES%</th><th>NO%</th><th>נפח 24h</th><th>ליקווידיטי</th><th>סיגנל</th><th></th></tr></thead>
    <tbody id="all-mkts-body"></tbody></table>
  </div>
</div>

<!-- WHALES -->
<div class="tc" id="tab-whales">
  <div class="g4" style="margin-bottom:14px;">
    <div class="card"><div class="c-lbl">עסקאות</div><div class="c-val" style="font-size:22px;" id="wh-cnt">0</div></div>
    <div class="card"><div class="c-lbl">נפח</div><div class="c-val" style="font-size:20px;color:var(--gd);" id="wh-vol">$0</div></div>
    <div class="card"><div class="c-lbl">Smart Wallets</div><div class="c-val" style="font-size:22px;color:var(--ac2);" id="wh-smart">0</div></div>
    <div class="card"><div class="c-lbl">גדול ביותר</div><div class="c-val" style="font-size:20px;color:var(--ac3);" id="wh-max">$0</div></div>
  </div>
  <div class="sec-h"><div class="sec-t">📡 עסקאות בזמן אמת</div></div>
  <div class="card" style="padding:7px;max-height:65vh;overflow-y:auto;" id="whale-feed"></div>
</div>

<!-- ALERTS -->
<div class="tc" id="tab-alerts">
  <div class="g4" style="margin-bottom:18px;">
    <div class="card"><div class="c-lbl">⚡ סה"כ</div><div class="c-val" style="color:var(--ac3)" id="al-total">0</div></div>
    <div class="card"><div class="c-lbl">🐋 ווייל</div><div class="c-val" style="color:var(--ac2)" id="al-whale">0</div></div>
    <div class="card"><div class="c-lbl">📰 חדשות</div><div class="c-val" style="color:var(--ac3)" id="al-news">0</div></div>
    <div class="card"><div class="c-lbl">🔄 ארביטראז'</div><div class="c-val" style="color:var(--gd)" id="al-arb">0</div></div>
  </div>
  <div id="alerts-list"></div>
  <div id="alerts-empty" style="text-align:center;color:var(--tx2);padding:50px;">
    <div style="font-size:42px;margin-bottom:12px;">🔍</div>
    <div style="font-size:14px;">ממתין להתרעות...</div>
  </div>
</div>

<!-- NEWS -->
<div class="tc" id="tab-news">
  <div class="filter-bar">
    <button class="chip on" onclick="setChip(this,'all-n')">הכל</button>
    <button class="chip" onclick="setChip(this,'high-n')">🔴 HIGH IMPACT</button>
    <button class="chip" onclick="setChip(this,'crypto-n')">₿ קריפטו</button>
    <button class="chip" onclick="setChip(this,'politics-n')">🏛️ פוליטיקה</button>
    <button class="chip" onclick="setChip(this,'economy-n')">📊 כלכלה</button>
  </div>
  <div class="card" style="padding:0;overflow:hidden;" id="news-feed">
    <div style="text-align:center;padding:40px;color:var(--tx2);">⏳ טוען חדשות...</div>
  </div>
</div>

<!-- OPPS -->
<div class="tc" id="tab-opps">
  <div class="g4" style="margin-bottom:18px;">
    <div class="card" style="border-color:rgba(0,255,136,.3);"><div class="c-lbl" style="color:var(--ac)">✅ BUY YES</div><div class="c-val" id="op-yes">0</div></div>
    <div class="card" style="border-color:rgba(255,51,102,.3);"><div class="c-lbl" style="color:var(--dn)">❌ BUY NO</div><div class="c-val" style="color:var(--dn)" id="op-no">0</div></div>
    <div class="card" style="border-color:rgba(255,215,0,.3);"><div class="c-lbl" style="color:var(--gd)">🔄 ארביטראז'</div><div class="c-val" style="color:var(--gd)" id="op-arb">0</div></div>
    <div class="card"><div class="c-lbl">⏳ ממתין</div><div class="c-val" style="color:var(--tx2)" id="op-watch">0</div></div>
  </div>
  <div class="g3" id="opps-grid">
    <div style="grid-column:1/-1;text-align:center;padding:50px;color:var(--tx2);">⏳ AI מחשב הזדמנויות...</div>
  </div>
</div>

<!-- WALLETS -->
<div class="tc" id="tab-wallets">
  <div class="sec-h"><div class="sec-t">🏆 Top ROI Wallets</div><span style="font-size:11px;color:var(--tx2);">The Graph · Polygon</span></div>
  <div style="display:flex;flex-direction:column;gap:11px;" id="wallets-list">
    <div style="text-align:center;padding:40px;color:var(--tx2);">⏳ טוען ארנקים מה-blockchain...</div>
  </div>
</div>

</div><!-- /main -->

<div class="status-bar">
  <div style="display:flex;align-items:center;gap:5px;"><div class="sb-dot" id="sb-poly" style="background:var(--tx2)"></div><span style="font-size:9px;">Poly</span></div>
  <div style="display:flex;align-items:center;gap:5px;"><div class="sb-dot" id="sb-news" style="background:var(--tx2)"></div><span style="font-size:9px;">News</span></div>
  <div style="display:flex;align-items:center;gap:5px;"><div class="sb-dot" id="sb-chain" style="background:var(--tx2)"></div><span style="font-size:9px;">Chain</span></div>
  <span style="font-family:'Space Mono',monospace;font-size:9px;" id="clk-disp">--:--:--</span>
  <div class="ticker-wrap"><div class="ticker" id="ticker-txt">⏳ מחבר לשרת...</div></div>
</div>

<script>
// ── STATE ──────────────────────────────────────────
var S = {
  ws: null, rt: null,
  mkts: [], catFilter: 'all',
  whaleCount: 0, whaleSmart: 0, whaleMaxAmt: 0, whaleTotalVol: 0,
  alertCount: 0, alertWhale: 0, alertNews: 0, alertArb: 0,
  nQueue: [], nShowing: false,
};

var WS_URL = (location.protocol === 'https:' ? 'wss:' : 'ws:') + '//' + location.host;

// ── WS ─────────────────────────────────────────────
function wsConnect() {
  setConnStatus('connecting');
  try { S.ws = new WebSocket(WS_URL); } catch(e) { setConnStatus('error'); wsReconnect(); return; }
  S.ws.onopen    = function() { setConnStatus('connected'); clearTimeout(S.rt); };
  S.ws.onmessage = function(e) { try { dispatch(JSON.parse(e.data)); } catch(_) {} };
  S.ws.onclose   = S.ws.onerror = function() { setConnStatus('error'); wsReconnect(); };
}
function wsReconnect() { clearTimeout(S.rt); S.rt = setTimeout(wsConnect, 5000); }
function setConnStatus(s) {
  var dot = g('conn-dot'), lbl = g('conn-status');
  if (s === 'connected') {
    dot.style.cssText = 'background:var(--ac);animation:none;';
    lbl.style.color   = 'var(--ac)';
    lbl.textContent   = '✅ מחובר — נתונים חיים בזמן אמת';
    g('sb-poly').style.background = 'var(--ac)';
  } else if (s === 'connecting') {
    dot.style.cssText = 'background:var(--gd);animation:pulse 1s infinite;';
    lbl.style.color   = 'var(--gd)';
    lbl.textContent   = '⏳ מתחבר לשרת...';
  } else {
    dot.style.cssText = 'background:var(--dn);animation:none;';
    lbl.style.color   = 'var(--dn)';
    lbl.textContent   = '❌ אין חיבור — מנסה שוב...';
  }
}

// ── DISPATCH ───────────────────────────────────────
function dispatch(msg) {
  var lu = g('last-upd');
  if (lu) lu.textContent = 'עדכון: ' + new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});
  switch (msg.type) {
    case 'markets':      onMarkets(msg.data);     break;
    case 'whale_tx':     onWhaleTx(msg.data);     break;
    case 'news':         onNews(msg.data);         break;
    case 'news_alert':   onNewsAlert(msg.data);    break;
    case 'opportunities':onOpps(msg.data);         break;
    case 'wallets':      onWallets(msg.data);      break;
    case 'arbitrage':    onArbitrage(msg.data);    break;
  }
}

// ── MARKETS ────────────────────────────────────────
function onMarkets(mkts) {
  S.mkts = mkts;
  var vol = mkts.reduce(function(s, m) { return s + (m.volume24h || 0); }, 0);
  setText('h-vol',  fmtUSD(vol));
  setText('h-mkt',  mkts.length + '');
  setText('ov-vol', fmtUSD(vol));
  renderTopMkts(mkts.slice(0, 6));
  renderAllMkts();
  setText('mkt-cnt', mkts.length + ' שווקים');
  updTicker(mkts.slice(0, 5));
  g('sb-poly').style.background = 'var(--ac)';
}
function sigBadge(y) {
  if (y > 72) return '<span class="sbadge sb-hot">🔥 HOT</span>';
  if (y > 56) return '<span class="sbadge sb-buy">▲ BUY</span>';
  if (y < 28) return '<span class="sbadge sb-wrn">⚠️ LOW</span>';
  return '—';
}
function renderTopMkts(mkts) {
  var el = g('ov-markets-body'); if (!el) return;
  el.innerHTML = mkts.map(function(m) {
    var y = Math.round((m.yesPrice || .5) * 100);
    return '<tr class="new-row"><td class="t-q" title="' + esc(m.question) + '" style="max-width:260px;">' + esc(m.question).slice(0,60) + '...</td>' +
      '<td><span class="t-cat">' + (m.category || 'gen') + '</span></td>' +
      '<td style="font-family:\'Space Mono\',monospace;font-weight:700;color:' + (y > 50 ? 'var(--ac)' : 'var(--tx)') + '">' + y + '%</td>' +
      '<td><span class="t-vol">' + fmtUSD(m.volume24h || 0) + '</span></td>' +
      '<td>' + sigBadge(y) + '</td></tr>';
  }).join('');
}
function renderAllMkts() {
  var el = g('all-mkts-body'); if (!el) return;
  var q  = (g('mkt-search') || {value:''}).value.toLowerCase();
  var cf = S.catFilter;
  var filtered = S.mkts.filter(function(m) {
    var inCat = cf === 'all' || (m.category || '').toLowerCase() === cf;
    var inQ   = !q || m.question.toLowerCase().includes(q);
    return inCat && inQ;
  });
  setText('mkt-cnt', filtered.length + ' שווקים');
  el.innerHTML = filtered.map(function(m, i) {
    var y = Math.round((m.yesPrice || .5) * 100);
    return '<tr>' +
      '<td style="font-family:\'Space Mono\',monospace;color:var(--tx2);font-size:10px;">' + (i+1) + '</td>' +
      '<td class="t-q" title="' + esc(m.question) + '" style="max-width:250px;">' + esc(m.question).slice(0,55) + '...</td>' +
      '<td><span class="t-cat">' + (m.category || 'gen') + '</span></td>' +
      '<td style="font-family:\'Space Mono\',monospace;font-weight:700;color:var(--ac)">' + y + '%</td>' +
      '<td style="font-family:\'Space Mono\',monospace;color:var(--dn)">' + (100-y) + '%</td>' +
      '<td><span class="t-vol">' + fmtUSD(m.volume24h || 0) + '</span></td>' +
      '<td><span class="t-vol">' + fmtUSD(m.liquidity  || 0) + '</span></td>' +
      '<td>' + sigBadge(y) + '</td>' +
      '<td><button class="btn btn-p" style="font-size:10px;padding:4px 8px;" onclick="window.open(\'' + m.url + '\',\'_blank\')">פתח</button></td>' +
    '</tr>';
  }).join('');
}

// ── WHALE ──────────────────────────────────────────
function onWhaleTx(tx) {
  S.whaleCount++;
  S.whaleTotalVol += (tx.amount || 0);
  if (tx.isSmartWallet) S.whaleSmart++;
  if ((tx.amount || 0) > S.whaleMaxAmt) { S.whaleMaxAmt = tx.amount; setText('wh-max', fmtUSD(tx.amount)); }

  setText('h-wh',    S.whaleCount + '');
  setText('ov-wh',   S.whaleCount + '');
  setText('tb-wh',   S.whaleCount + '');
  setText('wh-cnt',  S.whaleCount + '');
  setText('wh-smart',S.whaleSmart + '');
  setText('wh-vol',  fmtUSD(S.whaleTotalVol));

  var html = whaleTxHTML(tx, true);
  prependToFeed('ov-whale-feed', html, 4);
  prependToFeed('whale-feed',    html, 100);

  if (tx.isSmartWallet || tx.amount >= 50000) {
    showNotif(
      tx.isSmartWallet ? '🧠' : '🐋',
      tx.isSmartWallet ? 'Smart Wallet זוהה!' : 'ווייל גדול!',
      (tx.amountFormatted || fmtUSD(tx.amount)) + ' ' + (tx.side || 'BUY') + ' · ' + (tx.walletShort || '0x...'),
      'בדוק ←'
    );
    addAlert({
      type: 'w',
      icon: tx.isSmartWallet ? '🧠' : '🐋',
      title: (tx.amountFormatted || fmtUSD(tx.amount)) + ' ' + (tx.side || 'BUY'),
      desc:  (tx.walletShort || '0x...') + (tx.isSmartWallet ? ' — Smart Wallet ROI ' + tx.walletROI + '%' : ''),
      time:  'עכשיו',
    });
    S.alertWhale++;
    setText('al-whale', S.alertWhale + '');
  }
}
function whaleTxHTML(tx, isNew) {
  var cls = tx.isSmartWallet ? 'wi-sm' : (tx.amount >= 50000 ? 'wi-big' : 'wi-md');
  var ico = tx.isSmartWallet ? '🧠' : (tx.amount >= 50000 ? '🐋' : '🔵');
  return '<div class="wtx' + (isNew ? ' new-row' : '') + '">' +
    '<div class="w-ico ' + cls + '">' + ico + '</div>' +
    '<div style="flex:1;">' +
      '<div style="font-size:12px;font-weight:600;">' + (tx.side || 'BUY') + ' · <span style="color:var(--tx2);font-size:10px;">' + esc(tx.market || 'Polymarket') + '</span></div>' +
      '<div style="font-family:\'Space Mono\',monospace;font-size:9px;color:var(--tx2);">' + (tx.walletShort || '0x...') + '</div>' +
    '</div>' +
    '<div style="text-align:left;">' +
      '<div style="font-family:\'Space Mono\',monospace;font-size:12px;font-weight:700;color:var(--gd);">' + (tx.amountFormatted || fmtUSD(tx.amount || 0)) + '</div>' +
      (tx.isSmartWallet ? '<div style="font-size:9px;color:var(--ac);">ROI ' + (tx.walletROI || 0) + '%</div>' : '') +
    '</div>' +
  '</div>';
}

// ── NEWS ────────────────────────────────────────────
function onNews(arts) {
  var el = g('news-feed'); if (!el) return;
  var highCnt = arts.filter(function(a) { return a.impact === 'HIGH'; }).length;
  setText('ov-nw', highCnt + '');
  g('sb-news').style.background = 'var(--ac)';
  el.innerHTML = arts.map(function(a) {
    var sc = srcClass(a.source);
    return '<div class="n-item">' +
      '<span class="n-src ' + sc + '">' + esc((a.source || 'NEWS').slice(0,8)).toUpperCase() + '</span>' +
      '<div style="flex:1;">' +
        '<div style="font-size:12px;font-weight:600;line-height:1.4;margin-bottom:3px;"><a href="' + (a.url || '#') + '" target="_blank" rel="noopener" style="color:var(--tx);text-decoration:none;">' + esc(a.title) + '</a></div>' +
        '<div style="font-size:10px;color:var(--tx2);display:flex;gap:8px;align-items:center;">' +
          '<span>' + timeAgo(a.publishedAt) + '</span>' +
          '<span class="n-imp ' + (a.impact === 'HIGH' ? 'ni-h' : 'ni-m') + '">' + (a.impact || 'MED') + ' IMPACT</span>' +
          (a.relevantMarkets && a.relevantMarkets.length ? '<span style="color:var(--ac2);font-size:9px;">🎯 ' + a.relevantMarkets.slice(0,2).join(', ') + '</span>' : '') +
        '</div>' +
      '</div>' +
    '</div>';
  }).join('');
}
function onNewsAlert(item) {
  addAlert({
    type:  'n',
    icon:  '📰',
    title: 'HIGH IMPACT: ' + (item.title || '').slice(0, 50),
    desc:  'שווקים: ' + (item.relevantMarkets || []).join(', '),
    time:  'עכשיו',
  });
  S.alertNews++;
  setText('al-news', S.alertNews + '');
}

// ── OPPORTUNITIES ──────────────────────────────────
function onOpps(opps) {
  var yes = opps.filter(function(o) { return o.recommendation && o.recommendation.includes('BUY'); }).length;
  var arb = opps.filter(function(o) { return o.type === 'ARBITRAGE'; }).length;
  setText('op-yes',   yes + '');
  setText('op-arb',   arb + '');
  setText('op-no',    (opps.length - yes - arb) + '');
  setText('op-watch', '0');
  setText('h-op',     opps.length + '');
  setText('ov-op',    opps.length + '');
  var el = g('opps-grid'); if (!el) return;
  el.className = 'g3';
  el.innerHTML = opps.map(function(o) {
    var m   = o.market || {};
    var y   = Math.round((m.yesPrice || .5) * 100);
    var tp  = o.type === 'ARBITRAGE' ? 'oc-arb' : 'oc-buy';
    var lbl = o.type === 'ARBITRAGE' ? '🔄 ARBITRAGE' : (o.recommendation === 'STRONG BUY' ? '✅ STRONG BUY' : '✅ BUY YES');
    return '<div class="opp-card ' + tp + '">' +
      '<div class="oc-type">' + lbl + '</div>' +
      '<div class="oc-title">' + esc((m.question || '').slice(0, 55)) + '...</div>' +
      '<div class="oc-desc">' + (o.factors || []).join(' · ') + '</div>' +
      '<div class="oc-stats">' +
        '<div class="ocs"><div class="ocs-v" style="color:var(--ac)">' + y + '%</div><div class="ocs-l">הסתברות</div></div>' +
        '<div class="ocs"><div class="ocs-v" style="color:var(--gd)">' + (o.expectedValue || '?') + '</div><div class="ocs-l">EV</div></div>' +
        '<div class="ocs"><div class="ocs-v" style="color:var(--ac2)">' + (o.score || 0) + '</div><div class="ocs-l">Score</div></div>' +
      '</div>' +
      '<button class="btn btn-p" style="width:100%;margin-top:10px;font-size:10px;" onclick="window.open(\'' + m.url + '\',\'_blank\')">📊 פתח ב-Polymarket</button>' +
    '</div>';
  }).join('');
}

// ── WALLETS ────────────────────────────────────────
function onWallets(wallets) {
  var el = g('wallets-list'); if (!el) return;
  g('sb-chain').style.background = 'var(--ac)';
  el.innerHTML = wallets.map(function(w, i) {
    return '<div class="wlt-card">' +
      '<div style="display:flex;align-items:center;justify-content:space-between;gap:8px;">' +
        '<span style="font-family:\'Space Mono\',monospace;font-size:10px;color:var(--ac2);">' + (w.shortAddress || w.address.slice(0,12)) + '</span>' +
        '<span style="background:linear-gradient(135deg,var(--gd),#ff9500);color:var(--bg);font-size:9px;font-weight:800;padding:2px 7px;border-radius:8px;">#' + (i+1) + '</span>' +
      '</div>' +
      '<div class="wlt-stats">' +
        '<div class="wst"><div class="wst-v" style="color:var(--gd);">+' + (w.roi || 0) + '%</div><div class="wst-l">ROI</div></div>' +
        '<div class="wst"><div class="wst-v" style="color:var(--ac);">' + (w.trades || 0) + '</div><div class="wst-l">עסקאות</div></div>' +
        '<div class="wst"><div class="wst-v">' + fmtUSD(w.volume || 0) + '</div><div class="wst-l">נפח</div></div>' +
      '</div>' +
      '<div style="display:flex;justify-content:space-between;align-items:center;">' +
        '<span style="font-size:10px;color:var(--tx2);">רווח: <strong style="color:var(--gd)">' + fmtUSD(w.profit || 0) + '</strong></span>' +
        '<a href="https://polygonscan.com/address/' + w.address + '" target="_blank" rel="noopener"><button class="btn btn-o" style="font-size:10px;padding:4px 9px;">🔗 PolygonScan</button></a>' +
      '</div>' +
    '</div>';
  }).join('');
}

// ── ARBITRAGE ──────────────────────────────────────
function onArbitrage(opps) {
  if (!opps || !opps.length) return;
  opps.forEach(function(o) {
    addAlert({
      type:  's',
      icon:  '🔄',
      title: 'ארביטראז\u2019: פער ' + (o.gap || 0).toFixed(1) + '%',
      desc:  ((o.polymarket && o.polymarket.question) || '').slice(0, 55),
      time:  'עכשיו',
    });
    S.alertArb++;
    setText('al-arb', S.alertArb + '');
  });
}

// ── ALERTS ─────────────────────────────────────────
function addAlert(a) {
  S.alertCount++;
  setText('tb-al',    S.alertCount + '');
  setText('al-total', S.alertCount + '');
  var emp = g('alerts-empty'); if (emp) emp.style.display = 'none';
  var nc  = g('notif-cnt'); nc.style.display = 'inline'; nc.textContent = S.alertCount;
  var cls = a.type === 'w' ? 'al-w' : a.type === 's' ? 'al-s' : 'al-n';
  var div = document.createElement('div');
  div.className = 'al-item ' + cls + ' new-row';
  div.innerHTML =
    '<div class="al-ico">' + a.icon + '</div>' +
    '<div class="al-body">' +
      '<div class="al-title">' + esc(a.title) + '</div>' +
      '<div class="al-desc">' + esc(a.desc) + '</div>' +
      '<div class="al-btns">' +
        '<button class="btn btn-p" style="font-size:10px;padding:4px 10px;">🔍 נתח</button>' +
        '<button class="btn btn-o" style="font-size:10px;padding:4px 10px;" onclick="this.closest(\'.al-item\').remove()">✕</button>' +
      '</div>' +
    '</div>' +
    '<div class="al-time">' + esc(a.time) + '</div>';
  var list = g('alerts-list');
  if (list) list.insertBefore(div, list.firstChild);
}

// ── NOTIFICATIONS ──────────────────────────────────
function showNotif(icon, title, body, action) {
  S.nQueue.push({ icon, title, body, action });
  if (!S.nShowing) nextNotif();
}
function nextNotif() {
  if (!S.nQueue.length) { S.nShowing = false; return; }
  S.nShowing = true;
  var n = S.nQueue.shift();
  setText('np-icon', n.icon);
  setText('np-title', n.title);
  setText('np-body',  n.body);
  var btn = g('np-action');
  btn.textContent = n.action || 'בדוק';
  btn.onclick = closeNotif;
  g('notifPop').classList.add('show');
  setTimeout(function() { closeNotif(); setTimeout(nextNotif, 400); }, 5500);
}
function closeNotif() {
  g('notifPop').classList.remove('show');
  S.nShowing = false;
}

// ── CHART ──────────────────────────────────────────
function renderChart() {
  var el = g('chart-vol'); if (!el) return;
  var v  = [42,38,55,48,61,52,44,67,71,58,63,49,55,62,58,74,68,52,80,73,91,85,78,95];
  var mx = Math.max.apply(null, v);
  el.innerHTML = v.map(function(x, i) {
    var h = Math.round(x / mx * 145);
    var c = i >= v.length - 3 ? 'var(--ac3)' : 'var(--ac)';
    return '<div style="height:' + h + 'px;flex:1;background:linear-gradient(to top,' + c + '99,' + c + '22);border-radius:3px 3px 0 0;min-width:7px;transition:height .4s;"></div>';
  }).join('');
}

// ── TICKER ─────────────────────────────────────────
function updTicker(mkts) {
  var el = g('ticker-txt'); if (!el || !mkts.length) return;
  el.innerHTML = mkts.map(function(m) {
    var y = Math.round((m.yesPrice || .5) * 100);
    return '📊 <span>' + esc(m.question.slice(0,32)) + '</span> → <span>' + y + '%</span>';
  }).join(' · ');
}

// ── UI HELPERS ─────────────────────────────────────
function switchTab(el, name) {
  document.querySelectorAll('.tc').forEach(function(t) { t.classList.remove('on'); });
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('on'); });
  g('tab-' + name).classList.add('on');
  el.classList.add('on');
}
function goTab(name) {
  var order = ['overview','markets','whales','alerts','news','opps','wallets'];
  document.querySelectorAll('.tc').forEach(function(t) { t.classList.remove('on'); });
  document.querySelectorAll('.tab').forEach(function(t) { t.classList.remove('on'); });
  g('tab-' + name).classList.add('on');
  var tabs = document.querySelectorAll('.tab');
  var idx  = order.indexOf(name);
  if (tabs[idx]) tabs[idx].classList.add('on');
}
function setChip(el, f) {
  var bar = el.closest('.filter-bar') || el.parentElement;
  bar.querySelectorAll('.chip').forEach(function(c) { c.classList.remove('on'); });
  el.classList.add('on');
  S.catFilter = f.replace(/-[a-z]+$/, '');
  if (f.indexOf('-n') === -1 && S.mkts.length) renderAllMkts();
}
function prependToFeed(id, html, max) {
  var el = g(id); if (!el) return;
  var d  = document.createElement('div'); d.innerHTML = html;
  el.insertBefore(d.firstChild, el.firstChild);
  while (el.children.length > max) el.removeChild(el.lastChild);
}
function g(id)       { return document.getElementById(id); }
function setText(id, v) { var e = g(id); if (e) e.textContent = v; }
function esc(s)      { return String(s || '').replace(/[<>&"]/g, function(c){return({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'})[c];}); }
function fmtUSD(n)   { if (!n || isNaN(n)) return '$0'; if (n>=1e9) return '$'+(n/1e9).toFixed(1)+'B'; if (n>=1e6) return '$'+(n/1e6).toFixed(1)+'M'; if (n>=1e3) return '$'+(n/1e3).toFixed(0)+'K'; return '$'+Math.round(n); }
function srcClass(s) { if (!s) return 'ns-r'; s=s.toLowerCase(); if(s.includes('bloomberg'))return'ns-b'; if(s.includes('reuters'))return'ns-r'; if(s.includes('associated')||s.includes('ap news'))return'ns-a'; if(s.includes('coin'))return'ns-w'; if(s.includes('york')||s.includes('nyt'))return'ns-n'; return'ns-a'; }
function timeAgo(ts) { if(!ts)return''; var m=Math.round((Date.now()-new Date(ts))/60000); if(m<1)return'עכשיו'; if(m<60)return'לפני '+m+' דק\''; return'לפני '+Math.round(m/60)+' שעות'; }
function tickClock() { var e=g('clk-disp'); if(e) e.textContent=new Date().toLocaleTimeString('he-IL'); }

// ── INIT ───────────────────────────────────────────
renderChart();
setInterval(tickClock, 1000);
tickClock();
wsConnect();
</script>
</body>
</html>`;

// ─────────────────────────────────────────────
// MOBILE HTML (inline)
// ─────────────────────────────────────────────
const MOBILE_HTML = `<!DOCTYPE html>
<html lang="he" dir="rtl">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta name="apple-mobile-web-app-capable" content="yes">
<meta name="apple-mobile-web-app-status-bar-style" content="black-translucent">
<meta name="theme-color" content="#020408">
<title>PolyTracker Pro</title>
<link href="https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Heebo:wght@400;600;800&display=swap" rel="stylesheet">
<style>
:root{--bg:#020408;--bg2:#060d14;--bg3:#0a1520;--ac:#00ff88;--ac2:#00d4ff;--ac3:#ff6b35;--dn:#ff3366;--gd:#ffd700;--tx:#e0eaf5;--tx2:#7a99b8;--br:#0d2035;--sab:env(safe-area-inset-bottom,0px);}
*{margin:0;padding:0;box-sizing:border-box;-webkit-tap-highlight-color:transparent;}
html,body{height:100%;overflow:hidden;}
body{background:var(--bg);color:var(--tx);font-family:'Heebo',sans-serif;display:flex;flex-direction:column;}
.topbar{background:rgba(2,4,8,.97);border-bottom:1px solid var(--br);padding:10px 16px 8px;display:flex;align-items:center;justify-content:space-between;flex-shrink:0;}
.m-logo{display:flex;align-items:center;gap:8px;}
.m-logo-dot{width:28px;height:28px;background:linear-gradient(135deg,var(--ac),var(--ac2));border-radius:7px;display:flex;align-items:center;justify-content:center;font-size:14px;box-shadow:0 0 12px rgba(0,255,136,.4);}
.m-logo-txt{font-size:15px;font-weight:800;}
.m-logo-txt span{color:var(--ac);}
.live-pill{display:flex;align-items:center;gap:4px;background:rgba(255,51,102,.12);border:1px solid rgba(255,51,102,.35);padding:4px 9px;border-radius:12px;font-size:10px;font-weight:700;color:var(--dn);}
.ldot{width:6px;height:6px;background:var(--dn);border-radius:50%;animation:lp 1.5s infinite;}
@keyframes lp{0%,100%{opacity:1;}50%{opacity:.3;}}
.conn-m{padding:4px 16px;font-size:10px;font-family:'Space Mono',monospace;display:flex;align-items:center;gap:6px;background:var(--bg2);border-bottom:1px solid var(--br);flex-shrink:0;}
.cdot-m{width:6px;height:6px;border-radius:50%;}
.scroll-a{flex:1;overflow-y:auto;overflow-x:hidden;-webkit-overflow-scrolling:touch;padding:12px 14px 16px;}
.bottomnav{background:rgba(6,13,20,.97);border-top:1px solid var(--br);display:flex;align-items:center;padding:8px 0 calc(8px + var(--sab));flex-shrink:0;}
.bnav{flex:1;display:flex;flex-direction:column;align-items:center;gap:3px;cursor:pointer;padding:4px 0;position:relative;}
.bnav.on .bico{color:var(--ac);transform:scale(1.15);}
.bnav.on .blbl{color:var(--ac);}
.bico{font-size:20px;color:var(--tx2);transition:all .2s;}
.blbl{font-size:9px;color:var(--tx2);font-weight:600;transition:all .2s;}
.bnav-badge{position:absolute;top:2px;right:calc(50% - 14px);background:var(--ac3);color:#fff;font-size:8px;font-weight:800;padding:1px 4px;border-radius:6px;display:none;}
.page{display:none;}.page.on{display:block;}
.mrow{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px;}
.mc{background:var(--bg2);border:1px solid var(--br);border-radius:10px;padding:12px;position:relative;overflow:hidden;}
.mc::after{content:'';position:absolute;bottom:0;left:0;right:0;height:2px;}
.mc-g::after{background:linear-gradient(90deg,var(--ac),transparent);}
.mc-y::after{background:linear-gradient(90deg,var(--gd),transparent);}
.mc-o::after{background:linear-gradient(90deg,var(--ac3),transparent);}
.mc-r::after{background:linear-gradient(90deg,var(--dn),transparent);}
.mc-l{font-size:9px;font-weight:700;color:var(--tx2);text-transform:uppercase;letter-spacing:.8px;margin-bottom:6px;}
.mc-v{font-family:'Space Mono',monospace;font-size:21px;font-weight:700;line-height:1;}
.mc-s{font-size:10px;color:var(--tx2);margin-top:4px;}
.mkt-item{background:var(--bg2);border:1px solid var(--br);border-radius:10px;padding:12px;margin-bottom:8px;cursor:pointer;animation:fi .3s ease;}
@keyframes fi{from{opacity:0;transform:translateY(8px);}to{opacity:1;transform:translateY(0);}}
.mkt-item:active{transform:scale(.98);}
.mkt-q{font-size:13px;font-weight:600;line-height:1.4;margin-bottom:8px;}
.mkt-meta{display:flex;align-items:center;justify-content:space-between;gap:6px;flex-wrap:wrap;}
.pb-w{width:55px;height:5px;background:var(--bg3);border-radius:3px;overflow:hidden;}
.pb-f{height:100%;border-radius:3px;background:var(--ac);}
.pnum{font-family:'Space Mono',monospace;font-size:13px;font-weight:700;}
.mvol{font-family:'Space Mono',monospace;font-size:11px;color:var(--gd);}
.mcat{font-size:9px;font-weight:700;color:var(--ac2);background:rgba(0,212,255,.1);border:1px solid rgba(0,212,255,.2);padding:2px 7px;border-radius:4px;}
.msig{font-size:10px;font-weight:700;padding:3px 7px;border-radius:5px;}
.ms-hot{background:rgba(255,107,53,.15);color:var(--ac3);border:1px solid rgba(255,107,53,.3);}
.ms-buy{background:rgba(0,255,136,.1);color:var(--ac);border:1px solid rgba(0,255,136,.25);}
.ms-wrn{background:rgba(255,215,0,.1);color:var(--gd);border:1px solid rgba(255,215,0,.25);}
.cat-pills{display:flex;gap:6px;margin-bottom:12px;overflow-x:auto;padding-bottom:4px;scrollbar-width:none;}
.cat-pills::-webkit-scrollbar{display:none;}
.cpill{padding:5px 13px;border-radius:14px;border:1px solid var(--br);color:var(--tx2);font-size:11px;font-weight:600;white-space:nowrap;cursor:pointer;background:transparent;font-family:'Heebo',sans-serif;}
.cpill.on{background:rgba(0,255,136,.12);border-color:var(--ac);color:var(--ac);}
.wi-item{display:flex;align-items:center;gap:10px;padding:11px;background:var(--bg2);border:1px solid var(--br);border-radius:10px;margin-bottom:7px;animation:sr .3s ease;}
@keyframes sr{from{opacity:0;transform:translateX(16px);}to{opacity:1;transform:translateX(0);}}
.wi-ico{width:38px;height:38px;border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:18px;flex-shrink:0;}
.wi-big{background:rgba(0,212,255,.15);border:1px solid rgba(0,212,255,.3);}
.wi-sm{background:rgba(0,255,136,.1);border:1px solid rgba(0,255,136,.25);}
.wi-md{background:rgba(255,215,0,.1);border:1px solid rgba(255,215,0,.2);}
.wi-body{flex:1;min-width:0;}
.wi-act{font-size:13px;font-weight:600;}
.wi-addr{font-family:'Space Mono',monospace;font-size:10px;color:var(--tx2);margin-top:2px;}
.wi-mkt{font-size:10px;color:var(--ac2);margin-top:2px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;}
.wi-amt{font-family:'Space Mono',monospace;font-size:14px;font-weight:700;color:var(--gd);}
.wi-roi{font-size:10px;color:var(--ac);font-weight:600;}
.al-item{border-radius:10px;border-left:3px solid;padding:12px;margin-bottom:8px;animation:fi .4s ease;}
.al-w{background:rgba(0,212,255,.05);border-color:var(--ac2);}
.al-s{background:rgba(0,255,136,.05);border-color:var(--ac);}
.al-n{background:rgba(255,107,53,.05);border-color:var(--ac3);}
.al-hd{display:flex;align-items:center;gap:8px;margin-bottom:5px;}
.al-ico{font-size:18px;}
.al-ti{font-size:13px;font-weight:700;flex:1;}
.al-tm{font-family:'Space Mono',monospace;font-size:9px;color:var(--tx2);}
.al-dc{font-size:11px;color:var(--tx2);line-height:1.5;margin-bottom:8px;}
.al-bts{display:flex;gap:6px;}
.btn{padding:7px 14px;border-radius:8px;border:none;cursor:pointer;font-size:11px;font-weight:700;font-family:'Heebo',sans-serif;}
.bp{background:var(--ac);color:var(--bg);}
.bo{background:transparent;border:1px solid var(--br);color:var(--tx2);}
.ni{padding:13px;border-bottom:1px solid var(--br);cursor:pointer;}
.ni:active{background:rgba(0,255,136,.03);}
.ni-hd{display:flex;align-items:center;gap:7px;margin-bottom:7px;}
.ni-src{font-size:9px;font-weight:800;text-transform:uppercase;padding:2px 7px;border-radius:4px;}
.ns-r{background:rgba(255,107,53,.2);color:var(--ac3);}
.ns-b{background:rgba(0,212,255,.2);color:var(--ac2);}
.ns-a{background:rgba(255,215,0,.2);color:var(--gd);}
.ns-n{background:rgba(255,51,102,.2);color:var(--dn);}
.ns-w{background:rgba(0,255,136,.2);color:var(--ac);}
.ni-imp{font-size:9px;font-weight:700;padding:2px 7px;border-radius:4px;margin-right:auto;}
.ni-h{background:rgba(255,51,102,.2);color:var(--dn);}
.ni-m{background:rgba(255,215,0,.2);color:var(--gd);}
.ni-ti{font-size:13px;font-weight:600;line-height:1.4;margin-bottom:5px;}
.ni-mks{display:flex;gap:5px;flex-wrap:wrap;}
.nm-tag{font-size:9px;color:var(--ac2);background:rgba(0,212,255,.08);border:1px solid rgba(0,212,255,.15);padding:2px 6px;border-radius:4px;}
.oc{background:var(--bg2);border:1px solid var(--br);border-radius:11px;padding:13px;margin-bottom:9px;position:relative;overflow:hidden;}
.oc::before{content:'';position:absolute;top:0;left:0;right:0;height:2px;}
.oc-buy::before{background:linear-gradient(90deg,var(--ac),transparent);}
.oc-arb::before{background:linear-gradient(90deg,var(--gd),transparent);}
.oc-type{font-size:9px;font-weight:800;text-transform:uppercase;letter-spacing:1px;margin-bottom:6px;}
.oc-buy .oc-type{color:var(--ac);}
.oc-arb .oc-type{color:var(--gd);}
.oc-q{font-size:12px;font-weight:700;line-height:1.4;margin-bottom:5px;}
.oc-d{font-size:10px;color:var(--tx2);line-height:1.5;margin-bottom:10px;}
.oc-stats{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:10px;}
.ocs{background:var(--bg3);border-radius:7px;padding:6px;text-align:center;}
.ocs-v{font-family:'Space Mono',monospace;font-size:14px;font-weight:700;}
.ocs-l{font-size:8px;color:var(--tx2);margin-top:2px;text-transform:uppercase;}
.oc-btn{width:100%;padding:9px;background:var(--ac);color:var(--bg);border:none;border-radius:8px;font-size:12px;font-weight:800;font-family:'Heebo',sans-serif;cursor:pointer;}
.chart-m{background:var(--bg2);border:1px solid var(--br);border-radius:10px;padding:13px;margin-bottom:14px;height:110px;display:flex;align-items:flex-end;gap:2px;overflow:hidden;}
.notif-ov{position:fixed;top:0;left:0;right:0;bottom:0;background:rgba(2,4,8,.7);z-index:200;backdrop-filter:blur(4px);display:none;}
.notif-ov.show{display:flex;align-items:flex-end;}
.notif-sheet{background:var(--bg2);border-radius:18px 18px 0 0;padding:20px 20px calc(20px + var(--sab));width:100%;border-top:1px solid var(--br);animation:su .3s cubic-bezier(.34,1.56,.64,1);}
@keyframes su{from{transform:translateY(100%);}to{transform:translateY(0);}}
.ns-handle{width:40px;height:4px;background:var(--br);border-radius:2px;margin:0 auto 16px;}
.ns-ico2{font-size:32px;text-align:center;margin-bottom:10px;}
.ns-ti2{font-size:16px;font-weight:800;text-align:center;color:var(--ac);margin-bottom:8px;}
.ns-bd{font-size:13px;color:var(--tx2);line-height:1.6;text-align:center;margin-bottom:16px;}
.ns-bts{display:flex;gap:10px;}
.ns-bp{flex:1;padding:12px;background:var(--ac);color:var(--bg);border:none;border-radius:10px;font-size:14px;font-weight:800;font-family:'Heebo',sans-serif;cursor:pointer;}
.ns-bs{padding:12px 20px;background:transparent;border:1px solid var(--br);color:var(--tx2);border-radius:10px;font-size:14px;font-family:'Heebo',sans-serif;cursor:pointer;}
.empty-st{text-align:center;padding:50px 20px;color:var(--tx2);}
.empty-ico{font-size:44px;margin-bottom:14px;}
@keyframes flashNew{0%{background:rgba(0,255,136,.15);}100%{background:transparent;}}
.new-row{animation:flashNew .6s ease;}
</style>
</head>
<body>

<div class="notif-ov" id="m-nov" onclick="mCloseN(event)">
  <div class="notif-sheet">
    <div class="ns-handle"></div>
    <div class="ns-ico2" id="m-ni"></div>
    <div class="ns-ti2" id="m-nt"></div>
    <div class="ns-bd"  id="m-nb"></div>
    <div class="ns-bts">
      <button class="ns-bp" id="m-na">בדוק</button>
      <button class="ns-bs" onclick="ge('m-nov').classList.remove('show')">סגור</button>
    </div>
  </div>
</div>

<div class="topbar">
  <div class="m-logo"><div class="m-logo-dot">📊</div><div class="m-logo-txt">Poly<span>Tracker</span></div></div>
  <div style="display:flex;align-items:center;gap:8px;">
    <div style="width:32px;height:32px;background:var(--bg3);border:1px solid var(--br);border-radius:8px;display:flex;align-items:center;justify-content:center;font-size:15px;cursor:pointer;position:relative;" onclick="mGoPage('alerts')">
      🔔<div id="m-nb2" style="position:absolute;top:-3px;right:-3px;background:var(--dn);color:#fff;font-size:8px;font-weight:800;width:14px;height:14px;border-radius:7px;display:none;align-items:center;justify-content:center;">0</div>
    </div>
    <div class="live-pill"><div class="ldot"></div>LIVE</div>
  </div>
</div>

<div class="conn-m">
  <div class="cdot-m" id="m-cdot" style="background:var(--gd);animation:lp 1s infinite;"></div>
  <span id="m-cst" style="color:var(--gd);">מתחבר...</span>
  <span style="margin-right:auto;font-size:9px;color:var(--tx2);" id="m-lu"></span>
</div>

<div class="scroll-a" id="m-scroll">

  <div class="page on" id="m-page-overview">
    <div class="mrow">
      <div class="mc mc-g"><div class="mc-l">💵 נפח</div><div class="mc-v" id="m-vol">—</div><div class="mc-s" id="m-mk">טוען...</div></div>
      <div class="mc mc-y"><div class="mc-l">🐋 ווייל</div><div class="mc-v" style="color:var(--gd)" id="m-wh">0</div><div class="mc-s">עסקאות גדולות</div></div>
      <div class="mc mc-o"><div class="mc-l">⚡ הזדמנויות</div><div class="mc-v" style="color:var(--ac3)" id="m-op">0</div><div class="mc-s">AI זיהה</div></div>
      <div class="mc mc-r"><div class="mc-l">📰 HIGH</div><div class="mc-v" style="color:var(--dn)" id="m-nw">0</div><div class="mc-s">חדשות חשובות</div></div>
    </div>
    <div class="chart-m" id="m-chart"></div>
    <div style="font-size:13px;font-weight:800;margin-bottom:10px;display:flex;align-items:center;gap:6px;"><span style="width:3px;height:16px;background:var(--ac);display:inline-block;border-radius:2px;box-shadow:0 0 8px var(--ac);"></span>🐋 ווייל עכשיו</div>
    <div id="m-ov-wf"></div>
    <div style="font-size:13px;font-weight:800;margin:14px 0 10px;display:flex;align-items:center;gap:6px;"><span style="width:3px;height:16px;background:var(--ac);display:inline-block;border-radius:2px;box-shadow:0 0 8px var(--ac);"></span>🔥 שווקים חמים</div>
    <div id="m-ov-mf"></div>
  </div>

  <div class="page" id="m-page-markets">
    <div class="cat-pills">
      <button class="cpill on" onclick="mCat(this,'all')">הכל</button>
      <button class="cpill" onclick="mCat(this,'politics')">🏛️ פוליטיקה</button>
      <button class="cpill" onclick="mCat(this,'crypto')">₿ קריפטו</button>
      <button class="cpill" onclick="mCat(this,'economy')">📊 כלכלה</button>
      <button class="cpill" onclick="mCat(this,'tech')">💻 טק</button>
      <button class="cpill" onclick="mCat(this,'geo')">🌍 גיאו</button>
    </div>
    <input id="m-mq" type="text" placeholder="🔍 חפש שוק..." oninput="mRenderMkts()" style="width:100%;background:var(--bg2);border:1px solid var(--br);border-radius:9px;padding:10px 14px;color:var(--tx);font-size:13px;font-family:'Heebo',sans-serif;outline:none;margin-bottom:12px;">
    <div id="m-mkt-list"></div>
  </div>

  <div class="page" id="m-page-whales">
    <div class="mrow">
      <div class="mc mc-y"><div class="mc-l">עסקאות</div><div class="mc-v" style="color:var(--gd)" id="m-wc">0</div></div>
      <div class="mc mc-g"><div class="mc-l">נפח</div><div class="mc-v" style="font-size:18px;" id="m-wv">$0</div></div>
    </div>
    <div style="font-size:11px;font-weight:700;color:var(--tx2);margin-bottom:10px;font-family:'Space Mono',monospace;">📡 REAL-TIME FEED</div>
    <div id="m-wf"></div>
    <div class="empty-st" id="m-we" style="display:none;"><div class="empty-ico">🌊</div><div>ממתין לעסקאות ווייל...</div></div>
  </div>

  <div class="page" id="m-page-alerts">
    <div class="mrow">
      <div class="mc mc-o"><div class="mc-l">⚡ סה"כ</div><div class="mc-v" style="color:var(--ac3)" id="m-alt">0</div></div>
      <div class="mc mc-y"><div class="mc-l">🔄 ארביטראז'</div><div class="mc-v" style="color:var(--gd)" id="m-ala">0</div></div>
    </div>
    <div id="m-af"></div>
    <div class="empty-st" id="m-ae"><div class="empty-ico">🔍</div><div>ממתין להתרעות...</div></div>
  </div>

  <div class="page" id="m-page-news">
    <div class="cat-pills">
      <button class="cpill on" onclick="mCat(this,'all-n')">הכל</button>
      <button class="cpill" onclick="mCat(this,'high-n')">🔴 HIGH</button>
      <button class="cpill" onclick="mCat(this,'crypto-n')">₿ קריפטו</button>
      <button class="cpill" onclick="mCat(this,'politics-n')">🏛️ פוליטיקה</button>
    </div>
    <div id="m-nf" style="background:var(--bg2);border:1px solid var(--br);border-radius:11px;overflow:hidden;">
      <div class="empty-st"><div class="empty-ico">📰</div><div>טוען חדשות...</div></div>
    </div>
  </div>

  <div class="page" id="m-page-opps">
    <div class="mrow">
      <div class="mc mc-g"><div class="mc-l" style="color:var(--ac)">✅ YES</div><div class="mc-v" id="m-opy">0</div></div>
      <div class="mc mc-r"><div class="mc-l" style="color:var(--dn)">❌ NO</div><div class="mc-v" style="color:var(--dn)" id="m-opn">0</div></div>
      <div class="mc mc-y"><div class="mc-l" style="color:var(--gd)">🔄 ARB</div><div class="mc-v" style="color:var(--gd)" id="m-opa">0</div></div>
      <div class="mc"><div class="mc-l">Top Score</div><div class="mc-v" style="color:var(--ac2)" id="m-ops">—</div></div>
    </div>
    <div id="m-opf"><div class="empty-st"><div class="empty-ico">💰</div><div>AI מחשב...</div></div></div>
  </div>

</div>

<nav class="bottomnav">
  <div class="bnav on" onclick="mGoPage('overview')"  id="m-nav-overview"><div class="bico">📈</div><div class="blbl">סקירה</div></div>
  <div class="bnav"    onclick="mGoPage('markets')"   id="m-nav-markets"><div class="bico">🏪</div><div class="blbl">שווקים</div></div>
  <div class="bnav"    onclick="mGoPage('whales')"    id="m-nav-whales"><div class="bico">🐋</div><div class="blbl">ווייל</div><div class="bnav-badge" id="m-wb">0</div></div>
  <div class="bnav"    onclick="mGoPage('alerts')"    id="m-nav-alerts"><div class="bico">⚡</div><div class="blbl">התרעות</div><div class="bnav-badge" id="m-ab">0</div></div>
  <div class="bnav"    onclick="mGoPage('news')"      id="m-nav-news"><div class="bico">📰</div><div class="blbl">חדשות</div></div>
  <div class="bnav"    onclick="mGoPage('opps')"      id="m-nav-opps"><div class="bico">💰</div><div class="blbl">הזדמנויות</div></div>
</nav>

<script>
var MS = { ws:null, rt:null, mkts:[], catF:'all', whN:0, whVol:0, alN:0, alA:0, nQ:[], nShow:false };
var WS_URL = (location.protocol==='https:'?'wss:':'ws:')+'//'+location.host;

function mConnect() {
  mSetC('connecting');
  try { MS.ws = new WebSocket(WS_URL); } catch(e) { mSetC('error'); mSched(); return; }
  MS.ws.onopen    = function() { mSetC('connected'); clearTimeout(MS.rt); };
  MS.ws.onmessage = function(e) { try { mDispatch(JSON.parse(e.data)); } catch(_) {} };
  MS.ws.onclose   = MS.ws.onerror = function() { mSetC('error'); mSched(); };
}
function mSched() { clearTimeout(MS.rt); MS.rt = setTimeout(mConnect, 5000); }
function mSetC(s) {
  var d=ge('m-cdot'), l=ge('m-cst');
  if(s==='connected'){d.style.cssText='background:var(--ac);animation:none;';l.textContent='✅ מחובר';l.style.color='var(--ac)';}
  else if(s==='connecting'){d.style.cssText='background:var(--gd);animation:lp 1s infinite;';l.textContent='⏳ מתחבר...';l.style.color='var(--gd)';}
  else{d.style.cssText='background:var(--dn);animation:none;';l.textContent='❌ אין חיבור';l.style.color='var(--dn)';}
}
function mDispatch(msg) {
  var lu=ge('m-lu'); if(lu) lu.textContent=new Date().toLocaleTimeString('he-IL',{hour:'2-digit',minute:'2-digit'});
  switch(msg.type) {
    case 'markets':       mOnMkts(msg.data);    break;
    case 'whale_tx':      mOnWhale(msg.data);   break;
    case 'news':          mOnNews(msg.data);    break;
    case 'news_alert':    mAddAlert({type:'n',icon:'📰',title:'HIGH IMPACT',desc:(msg.data.title||'').slice(0,60),time:'עכשיו'}); break;
    case 'opportunities': mOnOpps(msg.data);    break;
    case 'arbitrage':     mOnArb(msg.data);     break;
  }
}
function mOnMkts(mkts) {
  MS.mkts = mkts;
  var vol = mkts.reduce(function(s,m){return s+(m.volume24h||0);},0);
  st('m-vol', mFmt(vol)); st('m-mk', mkts.length+' שווקים');
  mRenderOvMkts(mkts.slice(0,4));
  mRenderMkts();
  mRenderChart();
}
function mMktCard(m) {
  var y=Math.round((m.yesPrice||.5)*100);
  var sig=y>72?'<span class="msig ms-hot">🔥 HOT</span>':y>56?'<span class="msig ms-buy">▲ BUY</span>':y<28?'<span class="msig ms-wrn">⚠️</span>':'';
  return '<div class="mkt-item new-row" onclick="window.open(\''+mEsc(m.url)+'\',\'_blank\')">'+
    '<div class="mkt-q">'+mEsc(m.question.slice(0,75))+'...</div>'+
    '<div class="mkt-meta">'+
      '<div style="display:flex;align-items:center;gap:5px;"><span class="pnum" style="color:'+(y>50?'var(--ac)':'var(--tx)')+'">'+y+'%</span><div class="pb-w"><div class="pb-f" style="width:'+y+'%"></div></div></div>'+
      '<span class="mvol">'+mFmt(m.volume24h||0)+'</span>'+
      '<span class="mcat">'+(m.category||'gen')+'</span>'+
      sig+
    '</div></div>';
}
function mRenderOvMkts(mkts){var el=ge('m-ov-mf');if(el)el.innerHTML=mkts.map(mMktCard).join('');}
function mRenderMkts(){
  var el=ge('m-mkt-list');if(!el)return;
  var q=(ge('m-mq')||{value:''}).value.toLowerCase();
  var f=MS.mkts.filter(function(m){
    return m.question.toLowerCase().includes(q)&&(MS.catF==='all'||(m.category||'').toLowerCase()===MS.catF);
  });
  el.innerHTML=f.map(mMktCard).join('');
}
function mOnWhale(tx){
  MS.whN++; MS.whVol+=(tx.amount||0);
  st('m-wh',MS.whN+''); st('m-wc',MS.whN+''); st('m-wv',mFmt(MS.whVol));
  ge('m-we')&&(ge('m-we').style.display='none');
  var h=mWhRow(tx,true);
  mPrepend('m-wf',h,60); mPrepend('m-ov-wf',h,3);
  var b=ge('m-wb'); b.style.display='flex'; b.textContent=MS.whN;
  if(tx.isSmartWallet||(tx.amount||0)>=30000){
    mShowNotif(tx.isSmartWallet?'🧠':'🐋',tx.isSmartWallet?'Smart Wallet!':'ווייל גדול!',(tx.amountFormatted||mFmt(tx.amount||0))+' '+(tx.side||'BUY')+' · '+(tx.walletShort||'0x...'),'בדוק');
    mAddAlert({type:'w',icon:tx.isSmartWallet?'🧠':'🐋',title:(tx.amountFormatted||mFmt(tx.amount||0))+' '+(tx.side||'BUY'),desc:(tx.walletShort||'0x...')+(tx.isSmartWallet?' ROI '+tx.walletROI+'%':''),time:'עכשיו'});
  }
}
function mWhRow(tx,isNew){
  var cls=tx.isSmartWallet?'wi-sm':(tx.amount||0)>=50000?'wi-big':'wi-md';
  var ico=tx.isSmartWallet?'🧠':(tx.amount||0)>=50000?'🐋':'🔵';
  return '<div class="wi-item'+(isNew?' new-row':'')+'">'+
    '<div class="wi-ico '+cls+'">'+ico+'</div>'+
    '<div class="wi-body"><div class="wi-act">'+(tx.side||'BUY')+'</div><div class="wi-addr">'+(tx.walletShort||'0x...')+'</div><div class="wi-mkt">'+(tx.market||'Polymarket')+'</div></div>'+
    '<div style="text-align:left;"><div class="wi-amt">'+(tx.amountFormatted||mFmt(tx.amount||0))+'</div>'+(tx.isSmartWallet?'<div class="wi-roi">ROI '+tx.walletROI+'%</div>':'')+' </div>'+
  '</div>';
}
function mOnNews(arts){
  var el=ge('m-nf');if(!el)return;
  var h=arts.filter(function(a){return a.impact==='HIGH';}).length;
  st('m-nw',h+'');
  el.innerHTML=arts.map(function(a){
    var sc=mSrc(a.source);
    return '<div class="ni" onclick="window.open(\''+(a.url||'#')+'\',\'_blank\')">'+
      '<div class="ni-hd"><span class="ni-src '+sc+'">'+(a.source||'NEWS').slice(0,8).toUpperCase()+'</span><span class="ni-imp '+(a.impact==='HIGH'?'ni-h':'ni-m')+'">'+(a.impact||'MED')+' IMPACT</span></div>'+
      '<div class="ni-ti">'+mEsc(a.title)+'</div>'+
      (a.relevantMarkets&&a.relevantMarkets.length?'<div class="ni-mks">'+a.relevantMarkets.slice(0,3).map(function(m){return'<span class="nm-tag">'+mEsc(m)+'</span>';}).join('')+'</div>':'')+
    '</div>';
  }).join('');
}
function mOnOpps(opps){
  var yes=opps.filter(function(o){return o.recommendation&&o.recommendation.includes('BUY');}).length;
  var arb=opps.filter(function(o){return o.type==='ARBITRAGE';}).length;
  st('m-opy',yes+''); st('m-opa',arb+''); st('m-opn',(opps.length-yes-arb)+'');
  st('m-ops',opps.length?opps[0].score+'':'—'); st('m-op',opps.length+'');
  var el=ge('m-opf');if(!el)return;
  el.innerHTML=opps.map(function(o){
    var m=o.market||{},y=Math.round((m.yesPrice||.5)*100),tp=o.type==='ARBITRAGE'?'oc-arb':'oc-buy';
    return '<div class="oc '+tp+'">'+
      '<div class="oc-type">'+(tp==='oc-arb'?'🔄 ARBITRAGE':'✅ BUY YES')+'</div>'+
      '<div class="oc-q">'+mEsc((m.question||'').slice(0,60))+'...</div>'+
      '<div class="oc-d">'+(o.factors||[]).join(' · ')+'</div>'+
      '<div class="oc-stats">'+
        '<div class="ocs"><div class="ocs-v" style="color:var(--ac)">'+y+'%</div><div class="ocs-l">הסתברות</div></div>'+
        '<div class="ocs"><div class="ocs-v" style="color:var(--gd)">'+(o.expectedValue||'?')+'</div><div class="ocs-l">EV</div></div>'+
        '<div class="ocs"><div class="ocs-v" style="color:var(--ac2)">'+(o.score||0)+'</div><div class="ocs-l">Score</div></div>'+
      '</div>'+
      '<button class="oc-btn" onclick="window.open(\''+(m.url||'https://polymarket.com')+'\',\'_blank\')">📊 פתח ב-Polymarket</button>'+
    '</div>';
  }).join('');
}
function mOnArb(opps){
  if(!opps||!opps.length)return;
  opps.forEach(function(o){mAddAlert({type:'s',icon:'🔄',title:'ארביטראז: פער '+(o.gap||0).toFixed(1)+'%',desc:((o.polymarket&&o.polymarket.question)||'').slice(0,50),time:'עכשיו'});MS.alA++;st('m-ala',MS.alA+'');});
}
function mAddAlert(a){
  MS.alN++; st('m-alt',MS.alN+'');
  ge('m-ae')&&(ge('m-ae').style.display='none');
  var b=ge('m-ab'),nb=ge('m-nb2'); b.style.display='flex'; b.textContent=MS.alN; nb.style.display='flex'; nb.textContent=MS.alN;
  var d=document.createElement('div');
  d.className='al-item '+(a.type==='w'?'al-w':a.type==='s'?'al-s':'al-n')+' new-row';
  d.innerHTML='<div class="al-hd"><span class="al-ico">'+a.icon+'</span><span class="al-ti">'+mEsc(a.title)+'</span><span class="al-tm">'+mEsc(a.time)+'</span></div>'+
    '<div class="al-dc">'+mEsc(a.desc)+'</div>'+
    '<div class="al-bts"><button class="btn bp" style="font-size:11px;">🔍 נתח</button><button class="btn bo" style="font-size:11px;" onclick="this.closest(\'.al-item\').remove()">✕</button></div>';
  var f=ge('m-af'); if(f) f.insertBefore(d,f.firstChild);
}
function mShowNotif(icon,title,body,act){MS.nQ.push({icon,title,body,act});if(!MS.nShow)mNextN();}
function mNextN(){
  if(!MS.nQ.length){MS.nShow=false;return;}
  MS.nShow=true; var n=MS.nQ.shift();
  ge('m-ni').textContent=n.icon; ge('m-nt').textContent=n.title; ge('m-nb').textContent=n.body;
  ge('m-na').textContent=n.act; ge('m-na').onclick=function(){ge('m-nov').classList.remove('show');MS.nShow=false;};
  ge('m-nov').classList.add('show');
  setTimeout(function(){ge('m-nov').classList.remove('show');MS.nShow=false;setTimeout(mNextN,300);},5500);
}
function mCloseN(e){if(e&&e.target!==ge('m-nov'))return;ge('m-nov').classList.remove('show');MS.nShow=false;}
function mRenderChart(){
  var el=ge('m-chart');if(!el)return;
  var v=[42,38,55,48,61,52,44,67,71,58,63,49,55,62,74,80,73,91,85,95],mx=Math.max.apply(null,v);
  el.innerHTML=v.map(function(x,i){var h=Math.round(x/mx*82),c=i>=v.length-3?'var(--ac3)':'var(--ac)';
    return '<div style="height:'+h+'px;flex:1;background:linear-gradient(to top,'+c+'bb,'+c+'22);border-radius:2px 2px 0 0;min-width:10px;"></div>';}).join('');
}
function mGoPage(n){
  document.querySelectorAll('.page').forEach(function(p){p.classList.remove('on');});
  document.querySelectorAll('.bnav').forEach(function(b){b.classList.remove('on');});
  ge('m-page-'+n).classList.add('on'); ge('m-nav-'+n).classList.add('on');
  ge('m-scroll').scrollTop=0;
}
function mCat(el,f){
  el.closest('.cat-pills').querySelectorAll('.cpill').forEach(function(c){c.classList.remove('on');});
  el.classList.add('on'); MS.catF=f.replace(/-[a-z]+$/,''); mRenderMkts();
}
function mPrepend(id,h,max){var el=ge(id);if(!el)return;var d=document.createElement('div');d.innerHTML=h;el.insertBefore(d.firstChild,el.firstChild);while(el.children.length>max)el.removeChild(el.lastChild);}
function ge(id){return document.getElementById(id);}
function st(id,v){var e=ge(id);if(e)e.textContent=v;}
function mFmt(n){if(!n||isNaN(n))return'$0';if(n>=1e9)return'$'+(n/1e9).toFixed(1)+'B';if(n>=1e6)return'$'+(n/1e6).toFixed(1)+'M';if(n>=1e3)return'$'+(n/1e3).toFixed(0)+'K';return'$'+Math.round(n);}
function mSrc(s){if(!s)return'ns-r';s=s.toLowerCase();if(s.includes('bloomberg'))return'ns-b';if(s.includes('reuters'))return'ns-r';if(s.includes('associated')||s.includes('ap'))return'ns-a';if(s.includes('coin'))return'ns-w';return'ns-a';}
function mEsc(s){return String(s||'').replace(/[<>&"]/g,function(c){return({'<':'&lt;','>':'&gt;','&':'&amp;','"':'&quot;'})[c];});}
mRenderChart(); mConnect();
</script>
</body>
</html>`;

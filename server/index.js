'use strict';

// .env is only used locally; online, variables come from the host.
try {
  require('dotenv').config();
} catch {
  /* dotenv not installed: rely on the environment */
}

const express = require('express');
const http = require('http');
const crypto = require('crypto');
const { WebSocketServer } = require('ws');
const fs = require('fs');
const os = require('os');
const path = require('path');
const QRCode = require('qrcode');

const SessionManager = require('./session-manager');
const AudioBroadcaster = require('./audio-broadcaster');
const { LiveStreamHub } = require('./live-stream');
const Logger = require('./logger');

const logger = new Logger('Server');

/* -------------------------------------------------------------------- */
/*  Configuration                                                       */
/* -------------------------------------------------------------------- */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const RAW_ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const ADMIN_PASSWORD = RAW_ADMIN_PASSWORD === 'your_admin_password_here' ? '' : RAW_ADMIN_PASSWORD;
const CHURCH_NAME = process.env.CHURCH_NAME || 'Notre Église';
// Public address shown to listeners (QR code). Set it when hosting online,
// e.g. PUBLIC_URL=https://transaudio.mon-eglise.fr
const PUBLIC_URL = (process.env.PUBLIC_URL || '').replace(/\/+$/, '');
// Hosted online (Netlify sets URL; PUBLIC_URL can be set anywhere)?
const IS_HOSTED = Boolean(PUBLIC_URL || process.env.NETLIFY || process.env.URL);
const LANG_RE = /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/;
const MAX_LANGUAGES = 6;
const TARGET_LANGUAGES = (process.env.TARGET_LANGUAGES || 'en')
  .split(',')
  .map((l) => l.trim())
  .filter((l) => LANG_RE.test(l));

const currentSessionToken = crypto.randomUUID();

const HAS_API_KEY = Boolean(API_KEY) && API_KEY !== 'your_api_key_here';
if (!HAS_API_KEY) {
  // Keep serving the pages (so a hosted deploy still starts) but refuse to translate.
  logger.error('CRITICAL: GEMINI_API_KEY is not defined. Set it in .env (local) or in the host environment variables, then restart.');
}

if (ADMIN_PASSWORD) {
  logger.info('Admin password protection is ENABLED.');
} else if (IS_HOSTED) {
  logger.error('ADMIN_PASSWORD is not set: the admin console is LOCKED until you define it (the server is reachable from the Internet).');
} else {
  logger.warn('⚠️ Admin password protection is DISABLED. Set ADMIN_PASSWORD in .env before using the app outside a private network.');
}

/* -------------------------------------------------------------------- */
/*  Express + HTTP server                                               */
/* -------------------------------------------------------------------- */

const app = express();
app.disable('x-powered-by');
app.use(express.urlencoded({ extended: false, limit: '10kb' }));

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      const name = parts.shift().trim();
      try {
        list[name] = decodeURIComponent(parts.join('='));
      } catch {
        list[name] = parts.join('=');
      }
    });
  }
  return list;
}

function safeEqual(a, b) {
  const ba = Buffer.from(String(a));
  const bb = Buffer.from(String(b));
  return ba.length === bb.length && crypto.timingSafeEqual(ba, bb);
}

function isAdminAuthenticated(req) {
  if (!ADMIN_PASSWORD) return !IS_HOSTED;
  const token = parseCookies(req)['transaudio_admin_auth'];
  return Boolean(token) && safeEqual(token, currentSessionToken);
}

function adminAuthMiddleware(req, res, next) {
  if (IS_HOSTED && !ADMIN_PASSWORD) {
    return res.status(503).type('text/plain; charset=utf-8')
      .send('Console verrouillée : définissez la variable ADMIN_PASSWORD sur l’hébergeur puis redéployez.');
  }
  const subpath = req.path;
  if (subpath === '/login.html' || subpath === '/login.css' || subpath === '/login') {
    return next();
  }
  if (isAdminAuthenticated(req)) return next();
  res.redirect('/admin/login.html');
}

app.use('/admin', adminAuthMiddleware);

app.post('/admin/login', (req, res) => {
  const password = (req.body && req.body.password) || '';
  if (ADMIN_PASSWORD && safeEqual(password, ADMIN_PASSWORD)) {
    res.cookie('transaudio_admin_auth', currentSessionToken, {
      httpOnly: true,
      secure: req.secure || req.headers['x-forwarded-proto'] === 'https',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000, // 1 day
    });
    res.redirect('/admin/');
  } else {
    res.redirect('/admin/login.html?error=1');
  }
});

/* ── Live audio stream: one MP3 "radio" per language ──────────────── */

const streams = new LiveStreamHub();

app.get('/stream/:lang.mp3', (req, res) => {
  const lang = req.params.lang;
  const allowed = new Set(broadcaster.getAvailableLanguages());
  if (!LANG_RE.test(lang) || !allowed.has(lang)) {
    return res.status(404).end();
  }
  streams.get(lang).addListener(res).then(sendAdminStatus).catch((err) => {
    logger.error('Failed to start live stream', err);
    if (!res.headersSent) res.status(500).end();
  });
  res.on('close', () => setImmediate(sendAdminStatus));
});

/* ── QR code of the public address (for the admin screen / projection) ── */

app.get('/qr.svg', async (req, res) => {
  try {
    const svg = await QRCode.toString(getPublicUrl(), { type: 'svg', margin: 1, errorCorrectionLevel: 'M' });
    res.type('image/svg+xml').set('Cache-Control', 'no-cache').send(svg);
  } catch (err) {
    logger.error('QR generation failed', err);
    res.status(500).end();
  }
});

// Phones must never run an outdated copy of the page after an update:
// always revalidate (cheap 304 when unchanged).
const staticOptions = {
  setHeaders: (res) => res.setHeader('Cache-Control', 'no-cache'),
};

// Locate the static folders whether the server runs from the repo or from a
// bundled copy (Netlify Server ships them via includedFiles).
function findDir(name) {
  const candidates = [
    path.join(__dirname, '..', name),
    path.join(process.cwd(), name),
    path.join(__dirname, name),
  ];
  return candidates.find((dir) => fs.existsSync(path.join(dir))) || candidates[0];
}

// Serve presentation website under /info
app.use('/info', express.static(findDir('website'), staticOptions));

// Serve public client files
app.use(express.static(findDir('public'), staticOptions));

const server = http.createServer(app);

/* -------------------------------------------------------------------- */
/*  Core services                                                       */
/* -------------------------------------------------------------------- */

const sessionManager = new SessionManager({ apiKey: API_KEY });
const broadcaster = new AudioBroadcaster({ churchName: CHURCH_NAME });
broadcaster.setAvailableLanguages(TARGET_LANGUAGES);
// True once an admin chose the languages since this server started.
let languagesConfigured = false;

/** Keep valid, unique language codes, at most MAX_LANGUAGES. */
function cleanLanguages(list) {
  if (!Array.isArray(list)) return [];
  return [...new Set(list.filter((l) => typeof l === 'string' && LANG_RE.test(l)))].slice(0, MAX_LANGUAGES);
}

/** Offer these languages to the phones; disconnect listeners of removed ones. */
function applyLanguages(languages) {
  const removed = broadcaster.getAvailableLanguages().filter((l) => !languages.includes(l));
  languagesConfigured = true;
  broadcaster.setAvailableLanguages(languages);
  removed.forEach((l) => streams.close(l));
}

// Translated audio → live MP3 streams (wired once, not on every start)
sessionManager.on('audio', (lang, chunk) => {
  streams.push(lang, chunk);
});

// Captions → listeners of that language + every admin console
sessionManager.on('transcript', ({ language, kind, text }) => {
  if (kind === 'output') broadcaster.sendCaption(language, text);
  sendToAdmins({ type: 'transcript', language, kind, text });
});

sessionManager.on('session_status', ({ language, status }) => {
  broadcaster.notifySessionStatus(language, status);
  sendAdminStatus();
});

sessionManager.on('session_error', ({ language, error }) => {
  sendToAdmins({ type: 'error', message: `Traduction [${language}] : ${error}` });
});

/* -------------------------------------------------------------------- */
/*  WebSocket server with payload limits & auth                         */
/* -------------------------------------------------------------------- */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 256 * 1024,
});

server.on('upgrade', (req, socket, head) => {
  let pathname;
  try {
    pathname = new URL(req.url, 'http://localhost').pathname;
  } catch {
    socket.destroy();
    return;
  }

  if (pathname === '/ws/admin') {
    if (!isAdminAuthenticated(req)) {
      logger.warn(`Unauthorized Admin WebSocket connection attempt from ${req.socket.remoteAddress}`);
      socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => handleAdmin(ws, req));
  } else if (pathname === '/ws/listen') {
    wss.handleUpgrade(req, socket, head, (ws) => handleClient(ws, req));
  } else {
    socket.destroy();
  }
});

// Heartbeat: drop sockets of phones that left the Wi-Fi without closing.
const heartbeat = setInterval(() => {
  for (const ws of wss.clients) {
    if (ws.isAlive === false) {
      ws.terminate();
      continue;
    }
    ws.isAlive = false;
    ws.ping();
  }
}, 30000);

function trackAlive(ws) {
  ws.isAlive = true;
  ws.on('pong', () => { ws.isAlive = true; });
}

/* -------------------------------------------------------------------- */
/*  Admin WebSocket handler                                             */
/* -------------------------------------------------------------------- */

/** Every open admin console (several tabs / devices are allowed). */
const admins = new Set();

const statusInterval = setInterval(sendAdminStatus, 2000);

function handleAdmin(ws, req) {
  logger.info(`Admin connected via WebSocket from ${req.socket.remoteAddress}`);
  trackAlive(ws);
  admins.add(ws);
  sendAdminStatus();

  let messageCount = 0;
  const rateReset = setInterval(() => { messageCount = 0; }, 1000);

  ws.on('message', async (raw) => {
    messageCount++;
    if (messageCount > 150) {
      logger.warn('Admin WebSocket exceeded rate limit. Dropping message.');
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'start': {
          const languages = cleanLanguages(Array.isArray(msg.languages) ? msg.languages : broadcaster.getAvailableLanguages());
          if (languages.length === 0) {
            sendToWs(ws, { type: 'error', message: 'Aucune langue valide sélectionnée.' });
            break;
          }
          if (!HAS_API_KEY) {
            sendToWs(ws, { type: 'error', message: 'Clé GEMINI_API_KEY manquante : ajoutez-la puis redémarrez/redéployez le serveur.' });
            break;
          }
          logger.info(`Admin requested start sessions for: ${languages.join(', ')}`);

          applyLanguages(languages);
          await sessionManager.startSession(languages);
          broadcaster.notifyStreamingState(true);
          sendAdminStatus();
          break;
        }

        case 'set_languages': {
          const languages = cleanLanguages(msg.languages);
          if (languages.length === 0) {
            sendToWs(ws, { type: 'error', message: 'Gardez au moins une langue.' });
            sendAdminStatus();
            break;
          }
          logger.info(`Admin set offered languages: ${languages.join(', ')}`);
          applyLanguages(languages);
          sendAdminStatus();
          if (sessionManager.isStreaming) {
            await sessionManager.updateLanguages(languages);
            sendAdminStatus();
          }
          break;
        }

        case 'stop': {
          logger.info('Admin requested stop sessions');
          await sessionManager.stopSession();
          broadcaster.notifyStreamingState(false);
          sendAdminStatus();
          break;
        }

        case 'audio': {
          if (typeof msg.data === 'string' && sessionManager.isStreaming) {
            sessionManager.feedAudio(msg.data);
          }
          break;
        }

        case 'get_status': {
          sendAdminStatus();
          break;
        }

        default:
          logger.warn(`Unknown admin message type: ${msg.type}`);
      }
    } catch (err) {
      logger.error('Error processing admin message', err);
      sendToWs(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    logger.info('Admin WebSocket disconnected');
    admins.delete(ws);
    clearInterval(rateReset);
  });

  ws.on('error', (err) => {
    logger.error('Admin WebSocket error', err);
  });
}

function sendToAdmins(obj) {
  if (admins.size === 0) return;
  const raw = JSON.stringify(obj);
  for (const ws of admins) {
    if (ws.readyState === 1) ws.send(raw);
  }
}

function sendAdminStatus() {
  if (admins.size === 0) return;

  const sessionStatus = sessionManager.getStatus();
  sendToAdmins({
    type: 'status',
    streaming: sessionStatus.streaming,
    sessions: sessionStatus.sessions,
    clients: streams.listenerCounts(),   // phones actually receiving audio
    visitors: broadcaster.totalClients, // phones with the page open
    churchName: CHURCH_NAME,
    serverUrl: getPublicUrl(),
    targetLanguages: TARGET_LANGUAGES,
    offeredLanguages: broadcaster.getAvailableLanguages(),
    languagesConfigured,
    maxLanguages: MAX_LANGUAGES,
    port: PORT,
  });
}

/* -------------------------------------------------------------------- */
/*  Client WebSocket handler (page state + captions)                    */
/* -------------------------------------------------------------------- */

function handleClient(ws, req) {
  const ip = req.socket.remoteAddress;
  logger.debug(`Listener page connected from ${ip}`);
  trackAlive(ws);
  broadcaster.addPage(ws);

  let clientMsgCount = 0;
  const clientRateReset = setInterval(() => { clientMsgCount = 0; }, 1000);

  ws.on('message', (raw) => {
    clientMsgCount++;
    if (clientMsgCount > 10) return;

    try {
      const msg = JSON.parse(raw.toString());
      if (msg.type === 'join' && typeof msg.language === 'string' && LANG_RE.test(msg.language)) {
        broadcaster.addClient(ws, msg.language);
        sendAdminStatus();
      } else if (msg.type === 'leave') {
        broadcaster.addPage(ws);
        sendAdminStatus();
      }
    } catch (err) {
      logger.debug(`Invalid client message from ${ip}: ${err.message}`);
    }
  });

  ws.on('close', () => {
    broadcaster.removeClient(ws);
    clearInterval(clientRateReset);
    sendAdminStatus();
  });

  ws.on('error', (err) => {
    logger.error(`Client WebSocket error for ${ip}`, err);
  });
}

/* -------------------------------------------------------------------- */
/*  Helpers                                                             */
/* -------------------------------------------------------------------- */

function sendToWs(ws, obj) {
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify(obj));
  }
}

function getPublicUrl() {
  if (PUBLIC_URL) return PUBLIC_URL;
  if (process.env.URL) return process.env.URL.replace(/\/+$/, ''); // set by Netlify
  return `http://${getLocalIP()}:${PORT}`;
}

function getLocalIP() {
  // Allow manual override (e.g. LOCAL_IP=192.168.1.108 in .env)
  if (process.env.LOCAL_IP) return process.env.LOCAL_IP;

  // Skip virtual adapters (WSL, Hyper-V, VPN, Docker, VirtualBox...) and
  // link-local addresses, then prefer Wi-Fi/Ethernet on a home LAN range.
  const VIRTUAL = /vethernet|wsl|hyper-v|virtual|vbox|vmware|docker|vgate|tailscale|zerotier|hamachi|tun|tap|vpn|loopback|bluetooth/i;
  const candidates = [];
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family !== 'IPv4' || iface.internal) continue;
      if (iface.address.startsWith('169.254.')) continue;
      let score = 0;
      if (!VIRTUAL.test(name)) score += 2;
      if (/wi-?fi|wlan|wireless|ethernet|^en|^eth/i.test(name)) score += 1;
      if (iface.address.startsWith('192.168.')) score += 1;
      // Windows Mobile Hotspot: listeners connect directly to the PC
      if (iface.address.startsWith('192.168.137.')) score += 3;
      candidates.push({ address: iface.address, score });
    }
  }
  candidates.sort((a, b) => b.score - a.score);
  return candidates.length ? candidates[0].address : '127.0.0.1';
}

/* -------------------------------------------------------------------- */
/*  Start                                                               */
/* -------------------------------------------------------------------- */

server.listen(PORT, () => {
  const publicUrl = getPublicUrl();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         ✝  TransAudio — Traduction en Direct  ✝        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Église : ${CHURCH_NAME.padEnd(47)}║`);
  console.log(`║  Admin  : ${`http://localhost:${PORT}/admin/`.padEnd(47)}║`);
  console.log(`║  Public : ${publicUrl.padEnd(47)}║`);
  console.log(`║  Langues: ${TARGET_LANGUAGES.join(', ').padEnd(47)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Partagez cette URL avec les fidèles : ${publicUrl}`);
  console.log('');
});

/* -------------------------------------------------------------------- */
/*  Graceful shutdown                                                   */
/* -------------------------------------------------------------------- */

let shuttingDown = false;
function closeEverything() {
  clearInterval(statusInterval);
  clearInterval(heartbeat);
  broadcaster.notifyStreamingState(false);
  streams.closeAll();
  // 1012 = "service restart": clients reconnect immediately.
  for (const ws of wss.clients) ws.close(1012, 'Server restarting');
  wss.close();
  return sessionManager.stopSession();
}

// Local Ctrl+C: stop and exit.
process.on('SIGINT', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('Shutting down server…');
  await closeEverything();
  server.close(() => process.exit(0));
  // Live streams are long-lived connections: don't wait for them forever.
  setTimeout(() => process.exit(0), 2000).unref();
});

// Hosting platform replacing the instance (deploy, 8 h rotation): close the
// connections cleanly and let the platform end the process.
process.on('SIGTERM', async () => {
  if (shuttingDown) return;
  shuttingDown = true;
  logger.info('SIGTERM received — closing connections…');
  await closeEverything();
  server.close();
});

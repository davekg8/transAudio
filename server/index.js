'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const os = require('os');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const SessionManager = require('./session-manager');
const AudioBroadcaster = require('./audio-broadcaster');
const Logger = require('./logger');

const logger = new Logger('Server');

/* -------------------------------------------------------------------- */
/*  Configuration                                                       */
/* -------------------------------------------------------------------- */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || '';
const CHURCH_NAME = process.env.CHURCH_NAME || 'Notre Église';
const TARGET_LANGUAGES = (process.env.TARGET_LANGUAGES || 'en')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);

const currentSessionToken = uuidv4();

if (!API_KEY || API_KEY === 'your_api_key_here') {
  logger.error('CRITICAL: GEMINI_API_KEY is not defined. Please copy .env.example to .env and set a valid API key.');
  process.exit(1);
}

if (ADMIN_PASSWORD) {
  logger.info("Admin password protection is ENABLED.");
} else {
  logger.warn("⚠️ Admin password protection is DISABLED. Set ADMIN_PASSWORD in .env for production deployment.");
}

/* -------------------------------------------------------------------- */
/*  Express + HTTP server                                               */
/* -------------------------------------------------------------------- */

const app = express();

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

function parseCookies(req) {
  const list = {};
  const rc = req.headers.cookie;
  if (rc) {
    rc.split(';').forEach((cookie) => {
      const parts = cookie.split('=');
      list[parts.shift().trim()] = decodeURI(parts.join('='));
    });
  }
  return list;
}

function adminAuthMiddleware(req, res, next) {
  if (!ADMIN_PASSWORD) {
    return next();
  }

  const subpath = req.path;
  if (subpath === '/login.html' || subpath === '/login.css' || subpath === '/login') {
    return next();
  }

  const cookies = parseCookies(req);
  const token = cookies['transaudio_admin_auth'];
  if (token && token === currentSessionToken) {
    return next();
  }

  res.redirect('/admin/login.html');
}

app.use('/admin', adminAuthMiddleware);

app.post('/admin/login', (req, res) => {
  const { password } = req.body;
  if (password === ADMIN_PASSWORD) {
    res.cookie('transaudio_admin_auth', currentSessionToken, {
      httpOnly: true,
      secure: req.protocol === 'https',
      sameSite: 'strict',
      maxAge: 24 * 60 * 60 * 1000 // 1 day
    });
    res.redirect('/admin/');
  } else {
    res.redirect('/admin/login.html?error=1');
  }
});

// Serve presentation website under /info
app.use('/info', express.static(path.join(__dirname, '..', 'website')));

// Serve public client files
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

/* -------------------------------------------------------------------- */
/*  Core services                                                       */
/* -------------------------------------------------------------------- */

const sessionManager = new SessionManager({ apiKey: API_KEY });
const broadcaster = new AudioBroadcaster({ churchName: CHURCH_NAME });

// Wire SessionManager status changes to broadcaster
sessionManager.on('session_status', ({ language, status }) => {
  broadcaster.notifySessionStatus(language, status);
  sendAdminStatus();
});

/* -------------------------------------------------------------------- */
/*  WebSocket server with payload limits & auth                         */
/* -------------------------------------------------------------------- */

const wss = new WebSocketServer({
  noServer: true,
  maxPayload: 1024 * 1024 // 1 MB payload limit (Action 2.4)
});

server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/ws/admin') {
    if (ADMIN_PASSWORD) {
      const cookies = parseCookies(req);
      const token = cookies['transaudio_admin_auth'];
      if (!token || token !== currentSessionToken) {
        logger.warn(`Unauthorized Admin WebSocket connection attempt from ${req.socket.remoteAddress}`);
        socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n');
        socket.destroy();
        return;
      }
    }

    wss.handleUpgrade(req, socket, head, (ws) => {
      handleAdmin(ws, req);
    });
  } else if (pathname === '/ws/listen') {
    wss.handleUpgrade(req, socket, head, (ws) => {
      handleClient(ws, req);
    });
  } else {
    socket.destroy();
  }
});

/* -------------------------------------------------------------------- */
/*  Admin WebSocket handler                                             */
/* -------------------------------------------------------------------- */

let adminWs = null;
let statusInterval = null;

function handleAdmin(ws, req) {
  logger.info(`Admin connected via WebSocket from ${req.socket.remoteAddress}`);
  adminWs = ws;

  sendAdminStatus();
  statusInterval = setInterval(sendAdminStatus, 2000);

  // Simple Rate Limiting for Admin socket (Action 2.4)
  let messageCount = 0;
  const rateReset = setInterval(() => { messageCount = 0; }, 1000);

  ws.on('message', async (raw) => {
    messageCount++;
    if (messageCount > 150) { // Limit to 150 msg/sec max
      logger.warn('Admin WebSocket exceeded rate limit. Dropping message.');
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'start': {
          const languages = msg.languages || TARGET_LANGUAGES;
          logger.info(`Admin requested start sessions for: ${languages.join(', ')}`);

          await sessionManager.startSession(languages);

          for (const lang of languages) {
            sessionManager.onTranslatedAudio(lang, (chunk) => {
              broadcaster.broadcast(lang, chunk);
            });
          }

          broadcaster.setAvailableLanguages(languages);
          broadcaster.notifyStreamingState(true);
          sendAdminStatus();
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
          if (msg.data && sessionManager.isStreaming) {
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
    adminWs = null;
    clearInterval(rateReset);
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  });

  ws.on('error', (err) => {
    logger.error('Admin WebSocket error', err);
  });
}

function sendAdminStatus() {
  if (!adminWs || adminWs.readyState !== 1) return;

  const sessionStatus = sessionManager.getStatus();
  const clientCounts = broadcaster.getClientCounts();
  const localIP = getLocalIP();
  const serverUrl = `http://${localIP}:${PORT}`;

  sendToWs(adminWs, {
    type: 'status',
    streaming: sessionStatus.streaming,
    sessions: sessionStatus.sessions,
    clients: clientCounts,
    churchName: CHURCH_NAME,
    serverUrl: serverUrl,
    localIP: localIP,
    port: PORT
  });
}

/* -------------------------------------------------------------------- */
/*  Client WebSocket handler                                            */
/* -------------------------------------------------------------------- */

function handleClient(ws, req) {
  const ip = req.socket.remoteAddress;
  logger.info(`Listener client connected from ${ip}`);

  // Rate Limiting for listener clients (Action 2.4)
  let clientMsgCount = 0;
  const clientRateReset = setInterval(() => { clientMsgCount = 0; }, 1000);

  ws.on('message', (raw) => {
    clientMsgCount++;
    if (clientMsgCount > 10) { // Listener clients shouldn't send > 10 msgs/sec
      logger.warn(`Client ${ip} exceeded rate limit. Dropping message.`);
      return;
    }

    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'join' && msg.language) {
        broadcaster.removeClient(ws);
        broadcaster.addClient(ws, msg.language);
        sendAdminStatus();
      }
    } catch (err) {
      logger.error(`Error processing client message from ${ip}`, err);
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

function getLocalIP() {
  const interfaces = os.networkInterfaces();
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (iface.family === 'IPv4' && !iface.internal) {
        return iface.address;
      }
    }
  }
  return '127.0.0.1';
}

/* -------------------------------------------------------------------- */
/*  Start                                                               */
/* -------------------------------------------------------------------- */

server.listen(PORT, () => {
  const localIP = getLocalIP();

  console.log('');
  console.log('╔══════════════════════════════════════════════════════════╗');
  console.log('║         ✝  TransAudio — Traduction en Direct  ✝        ║');
  console.log('╠══════════════════════════════════════════════════════════╣');
  console.log(`║  Église : ${CHURCH_NAME.padEnd(45)}║`);
  console.log(`║  Admin  : http://localhost:${PORT}/admin/                  ║`);
  console.log(`║  Public : http://${localIP}:${PORT}                  ║`);
  console.log(`║  Langues: ${TARGET_LANGUAGES.join(', ').padEnd(45)}║`);
  console.log('╚══════════════════════════════════════════════════════════╝');
  console.log('');
  console.log(`Partagez cette URL avec les fidèles : http://${localIP}:${PORT}`);
  console.log('');
});

/* -------------------------------------------------------------------- */
/*  Graceful shutdown                                                   */
/* -------------------------------------------------------------------- */

process.on('SIGINT', async () => {
  logger.info('Shutting down server…');
  await sessionManager.stopSession();
  broadcaster.notifyStreamingState(false);

  if (statusInterval) clearInterval(statusInterval);

  wss.close();
  server.close(() => {
    logger.info('Server gracefully terminated.');
    process.exit(0);
  });
});

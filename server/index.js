'use strict';

require('dotenv').config();

const express = require('express');
const http = require('http');
const { WebSocketServer } = require('ws');
const os = require('os');
const path = require('path');

const SessionManager = require('./session-manager');
const AudioBroadcaster = require('./audio-broadcaster');

/* -------------------------------------------------------------------- */
/*  Configuration                                                       */
/* -------------------------------------------------------------------- */

const PORT = parseInt(process.env.PORT, 10) || 3000;
const API_KEY = process.env.GEMINI_API_KEY;
const TARGET_LANGUAGES = (process.env.TARGET_LANGUAGES || 'en')
  .split(',')
  .map((l) => l.trim())
  .filter(Boolean);

if (!API_KEY || API_KEY === 'your_api_key_here') {
  console.error('⚠️  GEMINI_API_KEY non définie. Copiez .env.example vers .env et ajoutez votre clé.');
  process.exit(1);
}

/* -------------------------------------------------------------------- */
/*  Express + HTTP server                                               */
/* -------------------------------------------------------------------- */

const app = express();

// Serve the public client files
app.use(express.static(path.join(__dirname, '..', 'public')));

const server = http.createServer(app);

/* -------------------------------------------------------------------- */
/*  Core services                                                       */
/* -------------------------------------------------------------------- */

const sessionManager = new SessionManager({ apiKey: API_KEY });
const broadcaster = new AudioBroadcaster();

/* -------------------------------------------------------------------- */
/*  WebSocket server (path-based routing)                               */
/* -------------------------------------------------------------------- */

const wss = new WebSocketServer({ noServer: true });

// Upgrade handler: route by URL path
server.on('upgrade', (req, socket, head) => {
  const pathname = new URL(req.url, `http://${req.headers.host}`).pathname;

  if (pathname === '/ws/admin') {
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
  console.log('[Server] Admin connected');
  adminWs = ws;

  // Send initial status
  sendAdminStatus();

  // Periodic status updates every 2 seconds
  statusInterval = setInterval(sendAdminStatus, 2000);

  ws.on('message', async (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      switch (msg.type) {
        case 'start': {
          const languages = msg.languages || TARGET_LANGUAGES;
          console.log(`[Server] Admin requested start: ${languages.join(', ')}`);

          // Start sessions first (this clears any previous listeners)
          await sessionManager.startSession(languages);

          // THEN wire translated audio → broadcaster (after sessions are created)
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
          console.log('[Server] Admin requested stop');
          await sessionManager.stopSession();
          broadcaster.notifyStreamingState(false);
          sendAdminStatus();
          break;
        }

        case 'audio': {
          // Forward audio from admin mic to all Gemini sessions
          if (msg.data && sessionManager.isStreaming) {
            sessionManager.feedAudio(msg.data);
            // Log every 100th chunk to confirm audio flow without flooding
            if (!global._audioChunkCount) global._audioChunkCount = 0;
            global._audioChunkCount++;
            if (global._audioChunkCount % 100 === 1) {
              console.log(`[Server] Audio chunk #${global._audioChunkCount} received (${msg.data.length} bytes base64)`);
            }
          }
          break;
        }

        case 'get_status': {
          sendAdminStatus();
          break;
        }

        default:
          console.log(`[Server] Unknown admin message type: ${msg.type}`);
      }
    } catch (err) {
      console.error(`[Server] Error processing admin message: ${err.message}`);
      sendToWs(ws, { type: 'error', message: err.message });
    }
  });

  ws.on('close', () => {
    console.log('[Server] Admin disconnected');
    adminWs = null;
    if (statusInterval) {
      clearInterval(statusInterval);
      statusInterval = null;
    }
  });

  ws.on('error', (err) => {
    console.error(`[Server] Admin WebSocket error: ${err.message}`);
  });
}

function sendAdminStatus() {
  if (!adminWs || adminWs.readyState !== 1) return;

  const sessionStatus = sessionManager.getStatus();
  const clientCounts = broadcaster.getClientCounts();

  sendToWs(adminWs, {
    type: 'status',
    streaming: sessionStatus.streaming,
    sessions: sessionStatus.sessions,
    clients: clientCounts,
  });
}

/* -------------------------------------------------------------------- */
/*  Client WebSocket handler                                            */
/* -------------------------------------------------------------------- */

function handleClient(ws, req) {
  const ip = req.socket.remoteAddress;
  console.log(`[Server] Client connected from ${ip}`);

  ws.on('message', (raw) => {
    try {
      const msg = JSON.parse(raw.toString());

      if (msg.type === 'join' && msg.language) {
        // Remove from previous language group if any
        broadcaster.removeClient(ws);
        // Add to new language group
        broadcaster.addClient(ws, msg.language);
        console.log(`[Server] Client ${ip} joined language: ${msg.language}`);
        // Trigger a status update for admin
        sendAdminStatus();
      }
    } catch (err) {
      console.error(`[Server] Error processing client message: ${err.message}`);
    }
  });

  ws.on('close', () => {
    broadcaster.removeClient(ws);
    console.log(`[Server] Client ${ip} disconnected`);
    sendAdminStatus();
  });

  ws.on('error', (err) => {
    console.error(`[Server] Client WebSocket error: ${err.message}`);
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

/**
 * Get the first non-internal IPv4 address for display purposes.
 */
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
  console.log('\n[Server] Shutting down…');
  await sessionManager.stopSession();
  broadcaster.notifyStreamingState(false);

  if (statusInterval) clearInterval(statusInterval);

  wss.close();
  server.close(() => {
    console.log('[Server] Goodbye.');
    process.exit(0);
  });
});

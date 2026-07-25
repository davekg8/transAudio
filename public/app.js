/**
 * TransAudio — Main Application Controller
 * Manages WebSocket connection, UI screens, and audio playback.
 */
;(function () {
  'use strict';

  /* ── Configuration ──────────────────────────────────── */
  const WS_PATH = '/ws/listen';

  /* Map of language codes → { flag, name } */
  const LANG_META = {
    en: { flag: '🇬🇧', name: 'English' },
    fr: { flag: '🇫🇷', name: 'Français' },
    es: { flag: '🇪🇸', name: 'Español' },
    pt: { flag: '🇵🇹', name: 'Português' },
    de: { flag: '🇩🇪', name: 'Deutsch' },
    it: { flag: '🇮🇹', name: 'Italiano' },
    zh: { flag: '🇨🇳', name: '中文' },
    ar: { flag: '🇸🇦', name: 'العربية' },
    ru: { flag: '🇷🇺', name: 'Русский' },
    ko: { flag: '🇰🇷', name: '한국어' },
    ja: { flag: '🇯🇵', name: '日本語' },
    sw: { flag: '🇰🇪', name: 'Kiswahili' },
    hi: { flag: '🇮🇳', name: 'हिन्दी' },
    ln: { flag: '🇨🇩', name: 'Lingála' },
    tr: { flag: '🇹🇷', name: 'Türkçe' },
    nl: { flag: '🇳🇱', name: 'Nederlands' },
    pl: { flag: '🇵🇱', name: 'Polski' },
    uk: { flag: '🇺🇦', name: 'Українська' },
  };

  /* ── DOM References ─────────────────────────────────── */
  const $ = (sel) => document.querySelector(sel);
  const screenWelcome   = $('#screen-welcome');
  const screenListening = $('#screen-listening');
  const screenReconnect = $('#screen-reconnect');
  const langGrid        = $('#lang-grid');
  const waitingBanner   = $('#waiting-banner');
  const listeningLang   = $('#listening-lang');
  const volumeSlider    = $('#volume-slider');
  const btnStop         = $('#btn-stop');
  const statusDot       = $('#status-dot');
  const statusText      = $('#status-text');
  const waveContainer   = $('#wave-container');
  const waveBars        = waveContainer ? waveContainer.querySelectorAll('.wave-bar') : [];
  const churchNameEl    = $('#church-name');

  /* ── State ──────────────────────────────────────────── */
  let ws = null;
  let audioPlayer = null;
  let currentLang = null;
  let isStreaming = false;           // whether the server is actively streaming
  let reconnectDelay = 1000;         // exponential backoff
  let reconnectTimer = null;
  let animFrameId = null;
  let wasListening = false;          // were we in listening screen before disconnect?
  let selectedLangBeforeDisconnect = null;

  /* ── Init ───────────────────────────────────────────── */
  connectWebSocket();

  /* ── WebSocket ──────────────────────────────────────── */
  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const url = `${proto}//${location.host}${WS_PATH}`;

    ws = new WebSocket(url);

    ws.onopen = () => {
      console.log('[WS] Connected to server');
      reconnectDelay = 1000;
      clearTimeout(reconnectTimer);
      updateConnectionStatus(true);

      // If listening before disconnect, auto-rejoin
      if (wasListening && selectedLangBeforeDisconnect) {
        joinLanguage(selectedLangBeforeDisconnect);
        wasListening = false;
      } else if (!currentLang) {
        showScreen('welcome');
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'languages':
          handleLanguages(msg.available || []);
          break;
        case 'audio':
          handleAudio(msg.data);
          break;
        case 'info':
          handleInfo(msg);
          break;
        case 'session_status':
          handleSessionStatus(msg);
          break;
      }
    };

    ws.onclose = () => {
      console.log('[WS] Disconnected from server');
      updateConnectionStatus(false);

      if (currentLang) {
        wasListening = true;
        selectedLangBeforeDisconnect = currentLang;
      }

      showScreen('reconnect');
      scheduleReconnect();
    };

    ws.onerror = () => {};
  }

  function scheduleReconnect() {
    clearTimeout(reconnectTimer);
    reconnectTimer = setTimeout(() => {
      connectWebSocket();
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    }, reconnectDelay);
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify(obj));
    }
  }

  /* ── Handlers ───────────────────────────────────────── */

  function handleLanguages(available) {
    langGrid.innerHTML = '';
    available.forEach((code) => {
      const meta = LANG_META[code] || { flag: '🌐', name: code };
      const btn = document.createElement('button');
      btn.className = 'lang-btn';
      btn.type = 'button';
      btn.dataset.lang = code;
      btn.innerHTML = `<span class="flag" aria-hidden="true">${meta.flag}</span><span>${meta.name}</span>`;
      btn.addEventListener('click', () => onLangSelect(code));
      langGrid.appendChild(btn);
    });
  }

  function onLangSelect(langCode) {
    joinLanguage(langCode);
  }

  function joinLanguage(langCode) {
    currentLang = langCode;
    const meta = LANG_META[langCode] || { flag: '🌐', name: langCode };
    listeningLang.textContent = `${meta.flag}  ${meta.name}`;

    wsSend({ type: 'join', language: langCode });

    if (!audioPlayer) {
      audioPlayer = new AudioPlayer(24000, 1.0);
    }
    audioPlayer.setVolume(volumeSlider.value / 100);
    audioPlayer.start();

    showScreen('listening');
    startVisualization();
  }

  function handleAudio(base64Data) {
    if (audioPlayer) {
      audioPlayer.feed(base64Data);
    }
  }

  function handleInfo(msg) {
    if (msg.churchName && churchNameEl) {
      churchNameEl.textContent = msg.churchName;
    }
    if (typeof msg.streaming === 'boolean') {
      isStreaming = msg.streaming;
    }
    if (waitingBanner) {
      if (!isStreaming) {
        waitingBanner.classList.add('visible');
      } else {
        waitingBanner.classList.remove('visible');
      }
    }
  }

  function handleSessionStatus(msg) {
    if (msg.language === currentLang) {
      if (msg.state === 'reconnecting') {
        updateStatusText('Reconnexion de la traduction...');
      } else if (msg.state === 'connected') {
        updateStatusText('Connecté');
      }
    }
  }

  /* ── Stop ────────────────────────────────────────────── */
  btnStop.addEventListener('click', () => {
    stopListening();
    showScreen('welcome');
  });

  function stopListening() {
    currentLang = null;
    if (audioPlayer) {
      audioPlayer.stop();
    }
    stopVisualization();
    if (waveContainer) waveContainer.classList.remove('active');
    waveBars.forEach(b => b.style.height = '');
  }

  /* ── Volume ─────────────────────────────────────────── */
  volumeSlider.addEventListener('input', () => {
    if (audioPlayer) {
      audioPlayer.setVolume(volumeSlider.value / 100);
    }
  });

  /* ── Screen Management ──────────────────────────────── */
  function showScreen(name) {
    [screenWelcome, screenListening, screenReconnect].forEach((s) => {
      if (s) s.classList.remove('active');
    });
    const target =
      name === 'welcome'   ? screenWelcome :
      name === 'listening' ? screenListening :
      screenReconnect;
    if (target) {
      void target.offsetWidth;
      target.classList.add('active');
    }
  }

  /* ── Connection Status Indicator ────────────────────── */
  function updateConnectionStatus(connected) {
    if (statusDot) {
      if (connected) {
        statusDot.classList.remove('disconnected');
      } else {
        statusDot.classList.add('disconnected');
      }
    }
    updateStatusText(connected ? 'Connecté' : 'Déconnecté');
  }

  function updateStatusText(text) {
    if (statusText) {
      statusText.textContent = text;
    }
  }

  /* ── Audio Visualization ────────────────────────────── */
  function startVisualization() {
    stopVisualization();
    if (waveContainer) waveContainer.classList.add('active');

    function tick() {
      if (!audioPlayer) return;
      const level = audioPlayer.getLevel();

      const baseH = 6;
      const maxExtra = 52;
      waveBars.forEach((bar) => {
        const rand = 0.6 + Math.random() * 0.4;
        const h = baseH + level * maxExtra * rand;
        bar.style.height = `${Math.min(h, 60)}px`;
      });

      animFrameId = requestAnimationFrame(tick);
    }
    tick();
  }

  function stopVisualization() {
    if (animFrameId) {
      cancelAnimationFrame(animFrameId);
      animFrameId = null;
    }
  }

  langGrid.querySelectorAll('.lang-btn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const code = btn.dataset.lang;
      if (code) onLangSelect(code);
    });
  });

})();

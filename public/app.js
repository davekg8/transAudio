/**
 * TransAudio — Listener page
 *
 * The translated audio is a continuous MP3 stream played by a plain <audio>
 * element: it keeps playing with the screen locked (iOS and Android), shows
 * lock-screen controls, and needs ~6 KB/s per phone.
 * A WebSocket carries the page state (languages, live/not live) and captions.
 */
;(function () {
  'use strict';

  /* ── Configuration ──────────────────────────────────── */
  const WS_PATH = '/ws/listen';
  const MAX_LAG_SECONDS = 4;      // beyond this, jump back to live
  const CATCH_UP_SECONDS = 1.5;   // beyond this, play slightly faster
  const MAX_CAPTION_LINES = 4;

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
    ro: { flag: '🇷🇴', name: 'Română' },
    fa: { flag: '🇮🇷', name: 'فارسی' },
    vi: { flag: '🇻🇳', name: 'Tiếng Việt' },
    ta: { flag: '🇱🇰', name: 'தமிழ்' },
    am: { flag: '🇪🇹', name: 'አማርኛ' },
  };

  // French names, shown next to each native name.
  const LANG_FR = {
    en: 'Anglais', fr: 'Français', es: 'Espagnol', pt: 'Portugais', de: 'Allemand',
    it: 'Italien', zh: 'Chinois', ar: 'Arabe', ru: 'Russe', ko: 'Coréen', ja: 'Japonais',
    sw: 'Swahili', hi: 'Hindi', ln: 'Lingala', tr: 'Turc', nl: 'Néerlandais',
    pl: 'Polonais', uk: 'Ukrainien', ro: 'Roumain', fa: 'Persan', vi: 'Vietnamien',
    ta: 'Tamoul', am: 'Amharique',
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
  const churchNameEl    = $('#church-name');
  const captionsEl      = $('#captions');
  const player          = $('#player');

  /* ── State ──────────────────────────────────────────── */
  let ws = null;
  let currentLang = null;     // language the user is listening to
  let isStreaming = false;    // translation running on the server
  let churchName = churchNameEl ? churchNameEl.textContent : 'TransAudio';
  let reconnectDelay = 1000;
  let reconnectTimer = null;
  let audioRetryTimer = null;
  let speakingTimer = null;
  let captionLines = [];

  /* ── Init ───────────────────────────────────────────── */
  bindStaticLangButtons();
  connectWebSocket();

  /* ── WebSocket (state + captions) ───────────────────── */
  function connectWebSocket() {
    const proto = location.protocol === 'https:' ? 'wss:' : 'ws:';
    ws = new WebSocket(`${proto}//${location.host}${WS_PATH}`);

    ws.onopen = () => {
      reconnectDelay = 1000;
      clearTimeout(reconnectTimer);
      updateConnectionStatus(true);
      if (currentLang) {
        wsSend({ type: 'join', language: currentLang });
        showScreen('listening');
      } else {
        showScreen('welcome');
      }
    };

    ws.onmessage = (event) => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }

      switch (msg.type) {
        case 'languages':
          renderLanguages(msg.available || []);
          // The admin removed the language this phone was listening to.
          if (currentLang && !(msg.available || []).includes(currentLang)) {
            stopListening();
            showScreen('welcome');
          }
          break;
        case 'info':
          handleInfo(msg);
          break;
        case 'caption':
          addCaption(msg.text);
          break;
        case 'session_status':
          handleSessionStatus(msg);
          break;
      }
    };

    ws.onclose = () => {
      updateConnectionStatus(false);
      // While listening, the audio stream may still be fine: keep the screen.
      if (!currentLang) showScreen('reconnect');
      clearTimeout(reconnectTimer);
      reconnectTimer = setTimeout(connectWebSocket, reconnectDelay);
      reconnectDelay = Math.min(reconnectDelay * 2, 10000);
    };

    ws.onerror = () => {};
  }

  function wsSend(obj) {
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(obj));
  }

  /* ── Languages ──────────────────────────────────────── */
  function renderLanguages(available) {
    if (!available.length) return;
    if (langGrid.dataset.langs === available.join(',')) return;
    langGrid.dataset.langs = available.join(',');
    langGrid.innerHTML = '';
    available.forEach((code) => {
      const meta = LANG_META[code] || { name: code };
      const btn = document.createElement('button');
      btn.className = 'lang-btn';
      btn.type = 'button';
      btn.dataset.lang = code;
      btn.innerHTML = '<span class="lang-natif"></span><span class="lang-fr"></span>';
      btn.firstElementChild.textContent = meta.name;
      const fr = LANG_FR[code] || '';
      const plain = (t) => t.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
      btn.lastElementChild.textContent = fr && plain(fr) !== plain(meta.name) ? fr : '';
      btn.firstElementChild.lang = code;
      btn.addEventListener('click', () => joinLanguage(code));
      langGrid.appendChild(btn);
    });
  }

  function bindStaticLangButtons() {
    langGrid.querySelectorAll('.lang-btn').forEach((btn) => {
      btn.addEventListener('click', () => joinLanguage(btn.dataset.lang));
    });
  }

  /* ── Listening ──────────────────────────────────────── */
  function joinLanguage(langCode) {
    if (!langCode) return;
    currentLang = langCode;
    const meta = LANG_META[langCode] || { flag: '🌐', name: langCode };
    listeningLang.textContent = meta.name;
    listeningLang.lang = langCode;
    clearCaptions();

    wsSend({ type: 'join', language: langCode });
    // Must run inside the tap handler so mobile browsers allow playback.
    startAudio();
    setupMediaSession(meta.name);
    showScreen('listening');
  }

  function stopListening() {
    currentLang = null;
    clearTimeout(audioRetryTimer);
    player.pause();
    player.removeAttribute('src');
    player.load();
    setSpeaking(false);
    wsSend({ type: 'leave' });
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'none';
  }

  btnStop.addEventListener('click', () => {
    stopListening();
    showScreen('welcome');
  });

  /* ── Audio stream ───────────────────────────────────── */
  function startAudio() {
    if (!currentLang) return;
    clearTimeout(audioRetryTimer);
    player.src = `/stream/${encodeURIComponent(currentLang)}.mp3?t=${Date.now()}`;
    player.volume = volumeSlider.value / 100;
    player.playbackRate = 1;
    const p = player.play();
    if (p && p.catch) {
      p.catch((err) => {
        if (err && err.name === 'NotAllowedError') {
          updateStatusText('Touchez l’écran pour lancer le son');
          document.addEventListener('click', startAudio, { once: true });
        } else {
          retryAudio();
        }
      });
    }
  }

  let lastRetry = 0;
  function retryAudio() {
    if (!currentLang) return;
    updateStatusText('Reconnexion du son…');
    clearTimeout(audioRetryTimer);
    // First retry is immediate (planned cut by the host), then back off.
    const delay = Date.now() - lastRetry > 10000 ? 200 : 2000;
    lastRetry = Date.now();
    audioRetryTimer = setTimeout(startAudio, delay);
  }

  player.addEventListener('playing', () => updateStatusText(isStreaming ? 'En direct' : 'En attente du message'));
  player.addEventListener('error', () => {
    if (!currentLang) return;
    const code = player.error ? player.error.code : '?';
    console.warn('[Audio] error', code);
    retryAudio();
    updateStatusText(`Problème de son (code ${code}), nouvel essai…`);
  });
  player.addEventListener('ended', retryAudio);
  player.addEventListener('stalled', () => { if (currentLang && player.paused) retryAudio(); });

  // The user may pause from the lock screen: resume = jump back to live.
  player.addEventListener('pause', () => {
    if ('mediaSession' in navigator) navigator.mediaSession.playbackState = 'paused';
  });

  // Keep the delay low: a live stream must never drift behind the speaker.
  setInterval(() => {
    if (!currentLang || player.paused || !player.buffered.length) return;
    const lag = player.buffered.end(player.buffered.length - 1) - player.currentTime;
    if (lag > MAX_LAG_SECONDS) {
      startAudio(); // reconnect at the live edge
    } else {
      player.playbackRate = lag > CATCH_UP_SECONDS ? 1.08 : 1;
    }
  }, 2000);

  volumeSlider.addEventListener('input', () => {
    player.volume = volumeSlider.value / 100;
  });

  function setupMediaSession(langName) {
    if (!('mediaSession' in navigator)) return;
    try {
      navigator.mediaSession.metadata = new MediaMetadata({
        title: `Traduction en direct — ${langName}`,
        artist: churchName,
        album: 'TransAudio',
      });
      navigator.mediaSession.setActionHandler('play', startAudio);
      navigator.mediaSession.setActionHandler('pause', () => player.pause());
      navigator.mediaSession.setActionHandler('stop', () => { stopListening(); showScreen('welcome'); });
      navigator.mediaSession.playbackState = 'playing';
    } catch (e) { /* optional feature */ }
  }

  /* ── Captions ───────────────────────────────────────── */
  function addCaption(text) {
    if (!currentLang || !text) return;
    // Gemini sends the translation in small pieces: merge them into lines.
    const last = captionLines[captionLines.length - 1];
    if (last !== undefined && !/[.!?…]\s*$/.test(last) && last.length < 160) {
      captionLines[captionLines.length - 1] = (last + text).replace(/\s+/g, ' ');
    } else {
      captionLines.push(text.trim());
    }
    captionLines = captionLines.slice(-MAX_CAPTION_LINES);
    renderCaptions();
    setSpeaking(true);
  }

  function renderCaptions() {
    captionsEl.replaceChildren(...captionLines.map((line) => {
      const p = document.createElement('p');
      p.textContent = line;
      return p;
    }));
  }

  function clearCaptions() {
    captionLines = [];
    const p = document.createElement('p');
    p.className = 'captions-placeholder';
    p.textContent = 'Les sous-titres apparaîtront ici pendant la traduction.';
    captionsEl.replaceChildren(p);
  }

  function setSpeaking(on) {
    if (!waveContainer) return;
    waveContainer.classList.toggle('speaking', on);
    clearTimeout(speakingTimer);
    if (on) speakingTimer = setTimeout(() => setSpeaking(false), 2500);
  }

  /* ── Server state ───────────────────────────────────── */
  function handleInfo(msg) {
    if (msg.churchName) {
      churchName = msg.churchName;
      if (churchNameEl) churchNameEl.textContent = msg.churchName;
    }
    if (typeof msg.streaming === 'boolean') isStreaming = msg.streaming;
    if (waitingBanner) waitingBanner.classList.toggle('visible', !isStreaming);
    if (currentLang && !player.paused) {
      updateStatusText(isStreaming ? 'En direct' : 'En attente du message');
    }
  }

  function handleSessionStatus(msg) {
    if (msg.language !== currentLang) return;
    if (msg.state === 'reconnecting') updateStatusText('Reconnexion de la traduction…');
    else if (msg.state === 'connected') updateStatusText('En direct');
  }

  /* ── Screens & status ───────────────────────────────── */
  function showScreen(name) {
    [screenWelcome, screenListening, screenReconnect].forEach((s) => s && s.classList.remove('active'));
    const target =
      name === 'welcome'   ? screenWelcome :
      name === 'listening' ? screenListening :
      screenReconnect;
    if (target) {
      void target.offsetWidth;
      target.classList.add('active');
    }
  }

  function updateConnectionStatus(connected) {
    if (statusDot) statusDot.classList.toggle('disconnected', !connected);
    if (!connected) updateStatusText('Connexion au serveur perdue…');
  }

  function updateStatusText(text) {
    if (statusText) statusText.textContent = text;
    const box = statusText && statusText.parentElement;
    if (!box) return;
    box.classList.toggle('direct', text === 'En direct');
    box.classList.toggle('coupe', /perdue/i.test(text));
    box.classList.toggle('veille', text !== 'En direct' && !/perdue/i.test(text));
  }
})();

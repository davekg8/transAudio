/**
 * TransAudio — Admin Dashboard Logic
 *
 * Handles WebSocket communication, AudioWorklet microphone acquisition,
 * sending PCM chunks to the backend, and updating the UI state.
 */

(function () {
  'use strict';

  // ====================================================
  // STATE
  // ====================================================
  const state = {
    ws: null,
    wsConnected: false,
    isStreaming: false,
    audioContext: null,
    mediaStream: null,
    workletNode: null,
    selectedDeviceId: null,
    uptimeStart: null,
    uptimeInterval: null,
    vuLevel: 0,
    vuAnimationFrame: null,
    reconnectAttempts: 0,
    reconnectTimer: null,
    statusPollInterval: null,
  };

  // ====================================================
  // DOM REFS
  // ====================================================
  const dom = {
    wsStatusDot: document.getElementById('wsStatusDot'),
    wsStatusDotFooter: document.getElementById('wsStatusDotFooter'),
    wsStatusText: document.getElementById('wsStatusText'),
    wsStatusTextFooter: document.getElementById('wsStatusTextFooter'),
    streamingBadge: document.getElementById('streamingBadge'),
    audioDeviceSelect: document.getElementById('audioDeviceSelect'),
    deviceNameLabel: document.getElementById('deviceNameLabel'),
    vuMeterFill: document.getElementById('vuMeterFill'),
    vuLevelDb: document.getElementById('vuLevelDb'),
    languageGrid: document.getElementById('languageGrid'),
    btnToggle: document.getElementById('btnToggle'),
    statSessions: document.getElementById('statSessions'),
    statListeners: document.getElementById('statListeners'),
    statStatus: document.getElementById('statStatus'),
    sessionList: document.getElementById('sessionList'),
    uptimeValue: document.getElementById('uptimeValue'),
    clientUrl: document.getElementById('clientUrl'),
    btnCopyUrl: document.getElementById('btnCopyUrl'),
    qrImage: document.getElementById('qrImage'),
    statVisitors: document.getElementById('statVisitors'),
    transcriptInput: document.getElementById('transcriptInput'),
    transcriptOutput: document.getElementById('transcriptOutput'),
    transcriptLang: document.getElementById('transcriptLang'),
    toastContainer: document.getElementById('toastContainer'),
  };

  // Languages offered in the console (the .env TARGET_LANGUAGES are pre-checked).
  const LANGUAGES = {
    en: ['🇬🇧', 'Anglais'], es: ['🇪🇸', 'Espagnol'], pt: ['🇵🇹', 'Portugais'],
    de: ['🇩🇪', 'Allemand'], it: ['🇮🇹', 'Italien'], nl: ['🇳🇱', 'Néerlandais'],
    zh: ['🇨🇳', 'Chinois'], ar: ['🇸🇦', 'Arabe'], sw: ['🇰🇪', 'Swahili'],
    ln: ['🇨🇩', 'Lingala'], ru: ['🇷🇺', 'Russe'], uk: ['🇺🇦', 'Ukrainien'],
    ro: ['🇷🇴', 'Roumain'], pl: ['🇵🇱', 'Polonais'], tr: ['🇹🇷', 'Turc'],
    fa: ['🇮🇷', 'Persan'], hi: ['🇮🇳', 'Hindi'], ko: ['🇰🇷', 'Coréen'],
    ja: ['🇯🇵', 'Japonais'], vi: ['🇻🇳', 'Vietnamien'], fr: ['🇫🇷', 'Français'],
  };
  const MAX_TRANSCRIPT_CHARS = 1500;
  let languageGridReady = false;

  // ====================================================
  // INIT
  // ====================================================
  function init() {
    setClientUrl();
    connectWebSocket();
    enumerateDevices();
    setupEventListeners();
    startVuMeterAnimation();
  }

  // ====================================================
  // CLIENT URL
  // ====================================================
  function setClientUrl(customUrl) {
    const url = customUrl || `${location.protocol}//${location.host}`;
    if (dom.clientUrl.textContent === url) return;
    dom.clientUrl.textContent = url;
    // The QR code is generated locally by the server (no external service).
    if (dom.qrImage) dom.qrImage.src = `/qr.svg?u=${encodeURIComponent(url)}`;
  }

  // ====================================================
  // LANGUAGE GRID
  // ====================================================
  const LANG_STORAGE_KEY = 'transaudio.languages';
  let lastLanguageEdit = 0;
  let languageSendTimer = null;
  let maxLanguages = 6;

  function renderLanguageGrid(offered) {
    if (languageGridReady || !dom.languageGrid) return;
    languageGridReady = true;
    const targets = offered && offered.length ? offered : ['en'];
    const others = Object.keys(LANGUAGES).filter((c) => !targets.includes(c));
    dom.languageGrid.innerHTML = '';

    // Extra languages are folded away to keep the console short.
    const details = document.createElement('details');
    details.className = 'more-languages';
    details.innerHTML = '<summary>Autres langues</summary><div class="language-grid"></div>';
    const moreGrid = details.querySelector('.language-grid');

    [...targets, ...others].forEach((code) => {
      const [flag, name] = LANGUAGES[code] || ['🌐', code.toUpperCase()];
      const label = document.createElement('label');
      label.className = 'language-checkbox';
      label.innerHTML = '<input type="checkbox" name="lang"><span class="checkmark"></span><span class="lang-flag"></span><span class="lang-label"></span>';
      const input = label.querySelector('input');
      input.value = code;
      input.checked = targets.includes(code);
      input.addEventListener('change', onLanguageToggle);
      label.querySelector('.lang-flag').textContent = flag;
      label.querySelector('.lang-label').textContent = name;
      (targets.includes(code) ? dom.languageGrid : moreGrid).appendChild(label);
    });
    dom.languageGrid.appendChild(details);
  }

  // A checkbox was changed: publish the new list to the phones right away
  // (and to the live translation if it is running).
  function onLanguageToggle(e) {
    const selected = getSelectedLanguages();
    if (selected.length === 0) {
      e.target.checked = true;
      showToast('Gardez au moins une langue.', 'warning');
      return;
    }
    if (selected.length > maxLanguages) {
      e.target.checked = false;
      showToast(`${maxLanguages} langues maximum en même temps.`, 'warning');
      return;
    }
    lastLanguageEdit = Date.now();
    try { localStorage.setItem(LANG_STORAGE_KEY, JSON.stringify(selected)); } catch (_) { /* private mode */ }
    clearTimeout(languageSendTimer);
    languageSendTimer = setTimeout(() => {
      sendWsMessage({ type: 'set_languages', languages: getSelectedLanguages() });
      showToast(state.isStreaming
        ? 'Langues mises à jour en direct.'
        : 'Langues proposées aux fidèles mises à jour.', 'success');
    }, 500);
  }

  // Reflect the server's list (changed by another console, or after a restart).
  function syncLanguageGrid(offered, configured) {
    if (!dom.languageGrid || !Array.isArray(offered)) return;

    // Server just restarted (e.g. new Netlify instance): restore this console's last choice.
    if (!configured) {
      let saved = null;
      try { saved = JSON.parse(localStorage.getItem(LANG_STORAGE_KEY) || 'null'); } catch (_) { saved = null; }
      if (Array.isArray(saved) && saved.length && saved.join(',') !== offered.join(',')) {
        sendWsMessage({ type: 'set_languages', languages: saved });
        offered = saved;
        lastLanguageEdit = Date.now();
      }
    }

    if (Date.now() - lastLanguageEdit < 3000) return; // user is editing
    dom.languageGrid.querySelectorAll('input[name="lang"]').forEach((cb) => {
      cb.checked = offered.includes(cb.value);
    });
  }

  // ====================================================
  // LIVE TRANSCRIPT
  // ====================================================
  function appendTranscript(msg) {
    const box = msg.kind === 'input' ? dom.transcriptInput : dom.transcriptOutput;
    if (!box) return;
    if (msg.kind === 'output' && dom.transcriptLang) {
      const meta = LANGUAGES[msg.language];
      dom.transcriptLang.textContent = meta ? `(${meta[1]})` : `(${msg.language})`;
    }
    const empty = box.querySelector('.transcript-empty');
    if (empty) empty.remove();
    const atBottom = box.scrollHeight - box.scrollTop - box.clientHeight < 24;
    box.textContent = (box.textContent + msg.text).slice(-MAX_TRANSCRIPT_CHARS);
    if (atBottom) box.scrollTop = box.scrollHeight;
  }

  // ====================================================
  // WEBSOCKET
  // ====================================================
  function connectWebSocket() {
    if (state.ws && (state.ws.readyState === WebSocket.CONNECTING || state.ws.readyState === WebSocket.OPEN)) {
      return;
    }

    const protocol = location.protocol === 'https:' ? 'wss:' : 'ws:';
    const wsUrl = `${protocol}//${location.host}/ws/admin`;

    updateWsStatus('reconnecting');
    state.ws = new WebSocket(wsUrl);

    state.ws.onopen = () => {
      state.wsConnected = true;
      state.reconnectAttempts = 0;
      updateWsStatus('connected');
      showToast('Connecté au serveur d\'administration', 'success');

      sendWsMessage({ type: 'get_status' });

      clearInterval(state.statusPollInterval);
      state.statusPollInterval = setInterval(() => {
        if (state.wsConnected) {
          sendWsMessage({ type: 'get_status' });
        }
      }, 5000);
    };

    state.ws.onclose = (event) => {
      state.wsConnected = false;
      updateWsStatus('disconnected');
      clearInterval(state.statusPollInterval);

      // Always reconnect: hosts close long connections (e.g. every 30 min on
      // Netlify) and restart instances. Audio capture keeps running meanwhile.
      checkSessionThenReconnect();
    };

    state.ws.onerror = () => {};

    state.ws.onmessage = (event) => {
      handleWsMessage(event.data);
    };
  }

  // A restarted server forgets admin logins: send the user back to the login
  // page instead of retrying forever.
  async function checkSessionThenReconnect() {
    try {
      const res = await fetch('/admin/index.html', { redirect: 'manual', cache: 'no-store' });
      if (res.type === 'opaqueredirect' || res.status === 302) {
        location.href = '/admin/login.html';
        return;
      }
    } catch (e) { /* server unreachable: just retry */ }
    scheduleReconnect();
  }

  function scheduleReconnect() {
    if (state.reconnectTimer) return;

    state.reconnectAttempts++;
    const delay = Math.min(1000 * Math.pow(2, state.reconnectAttempts - 1), 15000);
    updateWsStatus('reconnecting');

    state.reconnectTimer = setTimeout(() => {
      state.reconnectTimer = null;
      connectWebSocket();
    }, delay);
  }

  function sendWsMessage(msg) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
      state.ws.send(JSON.stringify(msg));
    }
  }

  function handleWsMessage(raw) {
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      console.warn('Message WebSocket invalide:', raw);
      return;
    }

    switch (msg.type) {
      case 'status':
        updateDashboardStatus(msg);
        break;
      case 'transcript':
        appendTranscript(msg);
        break;
      case 'error':
        showToast(msg.message || 'Erreur inconnue', 'error');
        break;
      default:
        console.log('Message inconnu:', msg);
    }
  }

  function updateWsStatus(status) {
    const dots = [dom.wsStatusDot, dom.wsStatusDotFooter];

    dots.forEach(dot => {
      if (!dot) return;
      dot.className = 'status-dot';
      if (status === 'connected') dot.classList.add('connected');
      else if (status === 'reconnecting') dot.classList.add('reconnecting');
    });

    const labels = {
      connected: 'Connecté',
      disconnected: 'Déconnecté',
      reconnecting: 'Reconnexion…',
    };

    if (dom.wsStatusText) dom.wsStatusText.textContent = labels[status] || status;
    if (dom.wsStatusTextFooter) dom.wsStatusTextFooter.textContent = `Serveur : ${(labels[status] || status).toLowerCase()}`;
  }

  // ====================================================
  // DASHBOARD STATUS UPDATE
  // ====================================================
  function updateDashboardStatus(msg) {
    const { streaming, sessions, clients, serverUrl, visitors, targetLanguages, offeredLanguages, languagesConfigured } = msg;

    if (serverUrl) {
      setClientUrl(serverUrl);
    }
    if (typeof msg.maxLanguages === 'number') maxLanguages = msg.maxLanguages;
    const offered = offeredLanguages || targetLanguages;
    if (!languageGridReady) {
      renderLanguageGrid(offered);
      syncLanguageGrid(offered, languagesConfigured);
    } else {
      syncLanguageGrid(offered, true);
    }

    // Keep the button in sync with the server (e.g. after reloading the page
    // or when another console started/stopped the translation).
    const recentlyToggled = Date.now() - (state.lastToggle || 0) < 8000;
    if (typeof streaming === 'boolean' && streaming !== state.isStreaming && !recentlyToggled) {
      state.isStreaming = streaming;
      updateToggleButton();
      if (streaming) startUptime(); else stopUptime();
    }

    // Sessions
    const sessionEntries = sessions ? Object.entries(sessions) : [];
    dom.statSessions.textContent = sessionEntries.length;

    // Total listeners
    const clientEntries = clients ? Object.entries(clients) : [];
    let totalListeners = 0;
    clientEntries.forEach(([, count]) => { totalListeners += count; });
    dom.statListeners.textContent = totalListeners;
    if (dom.statVisitors) {
      dom.statVisitors.textContent = typeof visitors === 'number' ? (visitors > 1 ? `${visitors} pages ouvertes` : `${visitors} page ouverte`) : '';
    }

    // Status text
    dom.statStatus.textContent = streaming ? 'En direct' : 'Inactif';
    dom.statStatus.classList.toggle('actif', !!streaming);

    // Session list
    if (sessionEntries.length === 0) {
      dom.sessionList.innerHTML = '<div class="session-empty">Aucune traduction en cours</div>';
    } else {
      const langNames = Object.fromEntries(Object.entries(LANGUAGES).map(([c, v]) => [c, v[1]]));

      const statusLabels = {
        connected: 'Connecté',
        reconnecting: 'Reconnexion…',
        setup_pending: 'Initialisation…',
        error: 'Erreur',
        disconnected: 'Déconnecté',
      };

      dom.sessionList.innerHTML = sessionEntries.map(([lang, status]) => {
        const dotClass = status === 'connected' ? 'active' :
                         status === 'error' ? 'error' : 'connecting';
        const listeners = clients && clients[lang] ? clients[lang] : 0;
        return `
          <div class="session-item">
            <div class="session-info">
              <div class="session-status-dot ${dotClass}"></div>
              <div>
                <div class="session-lang">${langNames[lang] || lang.toUpperCase()}</div>
                <div class="session-status-text">${statusLabels[status] || status}</div>
              </div>
            </div>
            <div class="session-listeners"><span class="chiffres">${listeners}</span> à l’écoute</div>
          </div>
        `;
      }).join('');
    }
  }

  // ====================================================
  // DEVICE ENUMERATION
  // ====================================================
  async function enumerateDevices() {
    try {
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      dom.audioDeviceSelect.innerHTML = '';

      if (audioInputs.length === 0) {
        dom.audioDeviceSelect.innerHTML = '<option value="">Aucune entrée audio trouvée</option>';
        return;
      }

      audioInputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${index + 1}`;
        dom.audioDeviceSelect.appendChild(option);
      });

      state.selectedDeviceId = audioInputs[0].deviceId;
      updateDeviceLabel();
      startAudioCapture();
    } catch (err) {
      console.error('Erreur énumération périphériques:', err);
      dom.audioDeviceSelect.innerHTML = '<option value="">Micro non autorisé</option>';
      showToast('Le navigateur bloque le micro. Autorisez-le (icône à gauche de l’adresse), puis rechargez la page.', 'error');
    }
  }

  function updateDeviceLabel() {
    const select = dom.audioDeviceSelect;
    const selected = select.options[select.selectedIndex];
    if (selected && selected.value) {
      dom.deviceNameLabel.textContent = selected.textContent;
      state.selectedDeviceId = selected.value;
    } else {
      dom.deviceNameLabel.textContent = 'Aucune entrée sélectionnée';
    }
  }

  // ====================================================
  // AUDIO CAPTURE
  // ====================================================
  async function startAudioCapture() {
    stopAudioCapture();

    try {
      const constraints = {
        audio: {
          deviceId: state.selectedDeviceId ? { exact: state.selectedDeviceId } : undefined,
          sampleRate: 48000,
          channelCount: 1,
          echoCancellation: false,
          noiseSuppression: false,
          autoGainControl: false,
        }
      };

      state.mediaStream = await navigator.mediaDevices.getUserMedia(constraints);

      state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000,
      });

      await state.audioContext.audioWorklet.addModule('/admin/audio-processor.worklet.js');

      state.workletNode = new AudioWorkletNode(state.audioContext, 'audio-capture-processor');

      state.workletNode.port.onmessage = (event) => {
        const msg = event.data;

        if (msg.type === 'audio' && msg.buffer) {
          // Only send audio chunks to server when streaming is active
          if (state.isStreaming) {
            const base64 = arrayBufferToBase64(msg.buffer);
            sendWsMessage({ type: 'audio', data: base64 });
          }
        } else if (msg.type === 'level') {
          // Always update VU level for real-time meter preview
          state.vuLevel = msg.level;
        }
      };

      const source = state.audioContext.createMediaStreamSource(state.mediaStream);
      source.connect(state.workletNode);

      return true;
    } catch (err) {
      console.error('Erreur capture audio:', err);
      showToast(`Erreur de capture audio : ${err.message}`, 'error');
      return false;
    }
  }

  function stopAudioCapture() {
    if (state.workletNode) {
      state.workletNode.disconnect();
      state.workletNode = null;
    }
    if (state.audioContext) {
      state.audioContext.close().catch(() => {});
      state.audioContext = null;
    }
    if (state.mediaStream) {
      state.mediaStream.getTracks().forEach(t => t.stop());
      state.mediaStream = null;
    }
    state.vuLevel = 0;
  }

  // ====================================================
  // TOGGLE STREAMING
  // ====================================================
  async function toggleStreaming() {
    if (state.isStreaming) {
      stopStreaming();
    } else {
      await startStreaming();
    }
  }

  async function startStreaming() {
    if (!state.wsConnected) {
      showToast('Non connecté au serveur. Veuillez patienter…', 'warning');
      return;
    }

    const languages = getSelectedLanguages();
    if (languages.length === 0) {
      showToast('Veuillez sélectionner au moins une langue.', 'warning');
      return;
    }

    dom.btnToggle.disabled = true;

    // Ensure audio capture is running
    if (!state.mediaStream) {
      const success = await startAudioCapture();
      if (!success) {
        dom.btnToggle.disabled = false;
        return;
      }
    }

    sendWsMessage({ type: 'start', languages: languages });
    state.lastToggle = Date.now();

    state.isStreaming = true;
    updateToggleButton();
    startUptime();

    dom.btnToggle.disabled = false;
    showToast('Traduction démarrée ! 🎙️', 'success');
  }

  function stopStreaming() {
    sendWsMessage({ type: 'stop' });
    state.lastToggle = Date.now();

    // Keep audio capture active for local VU preview, just mark streaming as inactive
    state.isStreaming = false;
    updateToggleButton();
    stopUptime();

    showToast('Traduction arrêtée.', 'success');
  }

  function getSelectedLanguages() {
    const checkboxes = dom.languageGrid.querySelectorAll('input[name="lang"]:checked');
    return Array.from(checkboxes).map(cb => cb.value);
  }

  function updateToggleButton() {
    if (state.isStreaming) {
      dom.btnToggle.className = 'btn-main-action stop';
      dom.btnToggle.innerHTML = '<span class="btn-icon"></span> Arrêter la traduction';
      dom.streamingBadge.classList.add('active');
    } else {
      dom.btnToggle.className = 'btn-main-action start';
      dom.btnToggle.innerHTML = '<span class="btn-icon"></span> Lancer la traduction';
      dom.streamingBadge.classList.remove('active');
    }
  }

  // ====================================================
  // VU METER ANIMATION
  // ====================================================
  function startVuMeterAnimation() {
    let smoothRms = 0;

    function animate() {
      const targetRms = state.vuLevel;
      const attack = 0.35;
      const release = 0.08;

      if (targetRms > smoothRms) {
        smoothRms += (targetRms - smoothRms) * attack;
      } else {
        smoothRms += (targetRms - smoothRms) * release;
      }

      // Calculate dB logarithmic scale: dB = 20 * log10(rms)
      if (smoothRms > 0.0005) {
        const db = Math.max(-60, Math.min(0, 20 * Math.log10(smoothRms)));
        // Map dB scale [-60 dB, 0 dB] to percentage [0%, 100%]
        const pct = ((db + 60) / 60) * 100;

        if (dom.vuMeterFill) dom.vuMeterFill.style.width = `${pct}%`;
        if (dom.vuLevelDb) dom.vuLevelDb.textContent = `${Math.round(db)} dB`;
      } else {
        if (dom.vuMeterFill) dom.vuMeterFill.style.width = '0%';
        if (dom.vuLevelDb) dom.vuLevelDb.textContent = '-∞ dB';
      }

      state.vuAnimationFrame = requestAnimationFrame(animate);
    }

    animate();
  }

  // ====================================================
  // UPTIME TIMER
  // ====================================================
  function startUptime() {
    state.uptimeStart = Date.now();
    clearInterval(state.uptimeInterval);
    state.uptimeInterval = setInterval(updateUptime, 1000);
    updateUptime();
  }

  function stopUptime() {
    clearInterval(state.uptimeInterval);
    state.uptimeStart = null;
    if (dom.uptimeValue) dom.uptimeValue.textContent = '00:00:00';
  }

  function updateUptime() {
    if (!state.uptimeStart) return;
    const elapsed = Math.floor((Date.now() - state.uptimeStart) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    if (dom.uptimeValue) dom.uptimeValue.textContent = `${h}:${m}:${s}`;
  }

  // ====================================================
  // TOAST NOTIFICATIONS
  // ====================================================
  function showToast(message, type = 'info') {
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${escapeHtml(message)}</span>`;

    if (dom.toastContainer) dom.toastContainer.appendChild(toast);

    setTimeout(() => {
      toast.classList.add('toast-exit');
      toast.addEventListener('animationend', () => toast.remove());
    }, 4000);
  }

  // ====================================================
  // EVENT LISTENERS
  // ====================================================
  function setupEventListeners() {
    dom.audioDeviceSelect.addEventListener('change', () => {
      updateDeviceLabel();
      startAudioCapture();
    });

    dom.btnToggle.addEventListener('click', () => {
      toggleStreaming();
    });

    dom.btnCopyUrl.addEventListener('click', () => {
      const url = dom.clientUrl.textContent;
      if (url && url !== '—') {
        navigator.clipboard.writeText(url).then(() => {
          showToast('URL copiée dans le presse-papiers ! 📋', 'success');
          dom.btnCopyUrl.textContent = '✅ Copié !';
          setTimeout(() => { dom.btnCopyUrl.textContent = '📋 Copier'; }, 2000);
        }).catch(() => {
          selectText(dom.clientUrl);
          showToast('Sélectionnez et copiez l\'URL manuellement.', 'info');
        });
      }
    });

    navigator.mediaDevices.addEventListener('devicechange', () => {
      enumerateDevices();
    });
  }

  // ====================================================
  // UTILITIES
  // ====================================================
  function arrayBufferToBase64(buffer) {
    const bytes = new Uint8Array(buffer);
    let binary = '';
    const chunkSize = 8192;
    for (let i = 0; i < bytes.length; i += chunkSize) {
      const chunk = bytes.subarray(i, i + chunkSize);
      binary += String.fromCharCode.apply(null, chunk);
    }
    return btoa(binary);
  }

  function escapeHtml(text) {
    const div = document.createElement('div');
    div.textContent = text;
    return div.innerHTML;
  }

  function selectText(element) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }

  // ====================================================
  // BOOT
  // ====================================================
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

})();

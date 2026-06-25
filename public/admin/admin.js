/**
 * TransAudio — Admin Dashboard Logic
 * 
 * Gère la connexion WebSocket, la capture audio via AudioWorklet,
 * l'envoi de données PCM au serveur, et toute la logique UI.
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
    qrCode: document.getElementById('qrCode'),
    toastContainer: document.getElementById('toastContainer'),
  };

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
  function setClientUrl() {
    const url = `${location.protocol}//${location.host}`;
    dom.clientUrl.textContent = url;
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
      showToast('Connecté au serveur', 'success');

      // Demander le statut immédiatement
      sendWsMessage({ type: 'get_status' });

      // Polling du statut toutes les 5 secondes
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

      if (!event.wasClean) {
        scheduleReconnect();
      }
    };

    state.ws.onerror = () => {
      // L'événement onclose sera déclenché après
    };

    state.ws.onmessage = (event) => {
      handleWsMessage(event.data);
    };
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
      dot.className = 'status-dot';
      if (status === 'connected') dot.classList.add('connected');
      else if (status === 'reconnecting') dot.classList.add('reconnecting');
    });

    const labels = {
      connected: 'Connecté',
      disconnected: 'Déconnecté',
      reconnecting: 'Reconnexion…',
    };

    dom.wsStatusText.textContent = labels[status] || status;
    dom.wsStatusTextFooter.textContent = `WebSocket : ${labels[status] || status}`;
  }

  // ====================================================
  // DASHBOARD STATUS UPDATE
  // ====================================================
  function updateDashboardStatus(msg) {
    const { streaming, sessions, clients } = msg;

    // Streaming state
    if (typeof streaming === 'boolean' && streaming !== state.isStreaming) {
      // Le serveur nous dit que le streaming est actif/inactif
      // mais on ne change l'UI que si c'est incohérent
    }

    // Sessions
    const sessionEntries = sessions ? Object.entries(sessions) : [];
    dom.statSessions.textContent = sessionEntries.length;

    // Total listeners
    const clientEntries = clients ? Object.entries(clients) : [];
    let totalListeners = 0;
    clientEntries.forEach(([, count]) => { totalListeners += count; });
    dom.statListeners.textContent = totalListeners;

    // Status text
    dom.statStatus.textContent = streaming ? 'En direct' : 'Inactif';
    dom.statStatus.style.color = streaming ? 'var(--green)' : 'var(--text-muted)';

    // Session list
    if (sessionEntries.length === 0) {
      dom.sessionList.innerHTML = '<div class="session-empty">Aucune session active</div>';
    } else {
      const langNames = {
        en: '🇬🇧 Anglais',
        es: '🇪🇸 Espagnol',
        fr: '🇫🇷 Français',
        pt: '🇧🇷 Portugais',
        de: '🇩🇪 Allemand',
        zh: '🇨🇳 Chinois',
        ar: '🇸🇦 Arabe',
      };

      const statusLabels = {
        connected: 'Connecté',
        connecting: 'Connexion…',
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
            <div class="session-listeners">
              <span>👥</span>
              <span>${listeners}</span>
            </div>
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
      // Demander une permission temporaire pour accéder aux noms des périphériques
      const tempStream = await navigator.mediaDevices.getUserMedia({ audio: true });
      tempStream.getTracks().forEach(t => t.stop());

      const devices = await navigator.mediaDevices.enumerateDevices();
      const audioInputs = devices.filter(d => d.kind === 'audioinput');

      dom.audioDeviceSelect.innerHTML = '';

      if (audioInputs.length === 0) {
        dom.audioDeviceSelect.innerHTML = '<option value="">Aucun périphérique audio trouvé</option>';
        return;
      }

      audioInputs.forEach((device, index) => {
        const option = document.createElement('option');
        option.value = device.deviceId;
        option.textContent = device.label || `Microphone ${index + 1}`;
        dom.audioDeviceSelect.appendChild(option);
      });

      // Sélectionner le premier par défaut
      state.selectedDeviceId = audioInputs[0].deviceId;
      updateDeviceLabel();
    } catch (err) {
      console.error('Erreur énumération périphériques:', err);
      dom.audioDeviceSelect.innerHTML = '<option value="">Erreur d\'accès aux périphériques</option>';
      showToast('Impossible d\'accéder aux périphériques audio. Vérifiez les permissions.', 'error');
    }
  }

  function updateDeviceLabel() {
    const select = dom.audioDeviceSelect;
    const selected = select.options[select.selectedIndex];
    if (selected && selected.value) {
      dom.deviceNameLabel.textContent = `🎤 ${selected.textContent}`;
      state.selectedDeviceId = selected.value;
    } else {
      dom.deviceNameLabel.textContent = 'Aucun périphérique sélectionné';
    }
  }

  // ====================================================
  // AUDIO CAPTURE
  // ====================================================
  async function startAudioCapture() {
    try {
      // Contraintes audio
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

      // Créer l'AudioContext
      state.audioContext = new (window.AudioContext || window.webkitAudioContext)({
        sampleRate: 48000,
      });

      // Charger le worklet
      await state.audioContext.audioWorklet.addModule('/admin/audio-processor.worklet.js');

      // Créer le nœud worklet
      state.workletNode = new AudioWorkletNode(state.audioContext, 'audio-capture-processor');

      // Écouter les messages du worklet
      state.workletNode.port.onmessage = (event) => {
        const msg = event.data;

        if (msg.type === 'audio' && msg.buffer) {
          // Convertir ArrayBuffer en base64 et envoyer au serveur
          const base64 = arrayBufferToBase64(msg.buffer);
          sendWsMessage({ type: 'audio', data: base64 });
        } else if (msg.type === 'level') {
          state.vuLevel = msg.level;
        }
      };

      // Connecter source → worklet
      const source = state.audioContext.createMediaStreamSource(state.mediaStream);
      source.connect(state.workletNode);
      // Ne pas connecter à la destination (pas de retour audio)

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
      // STOP
      stopStreaming();
    } else {
      // START
      await startStreaming();
    }
  }

  async function startStreaming() {
    if (!state.wsConnected) {
      showToast('Non connecté au serveur. Veuillez patienter…', 'warning');
      return;
    }

    // Récupérer les langues sélectionnées
    const languages = getSelectedLanguages();
    if (languages.length === 0) {
      showToast('Veuillez sélectionner au moins une langue.', 'warning');
      return;
    }

    dom.btnToggle.disabled = true;

    // Démarrer la capture audio
    const success = await startAudioCapture();
    if (!success) {
      dom.btnToggle.disabled = false;
      return;
    }

    // Envoyer la commande start au serveur
    sendWsMessage({ type: 'start', languages: languages });

    // Mettre à jour l'UI
    state.isStreaming = true;
    updateToggleButton();
    startUptime();

    dom.btnToggle.disabled = false;
    showToast('Traduction démarrée ! 🎙️', 'success');
  }

  function stopStreaming() {
    // Envoyer la commande stop
    sendWsMessage({ type: 'stop' });

    // Arrêter la capture
    stopAudioCapture();

    // Mettre à jour l'UI
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
      dom.btnToggle.innerHTML = '<span class="btn-icon">⏹</span> Arrêter la Traduction';
      dom.streamingBadge.classList.add('active');
    } else {
      dom.btnToggle.className = 'btn-main-action start';
      dom.btnToggle.innerHTML = '<span class="btn-icon">⚡</span> Démarrer la Traduction';
      dom.streamingBadge.classList.remove('active');
    }
  }

  // ====================================================
  // VU METER ANIMATION
  // ====================================================
  function startVuMeterAnimation() {
    let smoothLevel = 0;

    function animate() {
      // Lissage exponentiel
      const target = state.vuLevel;
      const attack = 0.3;  // Montée rapide
      const release = 0.08; // Descente lente

      if (target > smoothLevel) {
        smoothLevel += (target - smoothLevel) * attack;
      } else {
        smoothLevel += (target - smoothLevel) * release;
      }

      // Clamp
      smoothLevel = Math.max(0, Math.min(1, smoothLevel));

      // Mettre à jour le DOM
      const pct = smoothLevel * 100;
      dom.vuMeterFill.style.width = `${pct}%`;

      // Calculer le dB pour l'affichage
      if (smoothLevel > 0.001) {
        const db = Math.round((smoothLevel * 60) - 60);
        dom.vuLevelDb.textContent = `${db} dB`;
      } else {
        dom.vuLevelDb.textContent = '-∞ dB';
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
    dom.uptimeValue.textContent = '00:00:00';
  }

  function updateUptime() {
    if (!state.uptimeStart) return;
    const elapsed = Math.floor((Date.now() - state.uptimeStart) / 1000);
    const h = String(Math.floor(elapsed / 3600)).padStart(2, '0');
    const m = String(Math.floor((elapsed % 3600) / 60)).padStart(2, '0');
    const s = String(elapsed % 60).padStart(2, '0');
    dom.uptimeValue.textContent = `${h}:${m}:${s}`;
  }

  // ====================================================
  // TOAST NOTIFICATIONS
  // ====================================================
  function showToast(message, type = 'info') {
    const icons = {
      success: '✅',
      error: '❌',
      warning: '⚠️',
      info: 'ℹ️',
    };

    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.innerHTML = `<span>${icons[type] || ''}</span><span>${escapeHtml(message)}</span>`;

    dom.toastContainer.appendChild(toast);

    // Auto-dismiss après 4 secondes
    setTimeout(() => {
      toast.classList.add('toast-exit');
      toast.addEventListener('animationend', () => toast.remove());
    }, 4000);
  }

  // ====================================================
  // EVENT LISTENERS
  // ====================================================
  function setupEventListeners() {
    // Sélection de périphérique
    dom.audioDeviceSelect.addEventListener('change', () => {
      updateDeviceLabel();
    });

    // Bouton Start/Stop
    dom.btnToggle.addEventListener('click', () => {
      toggleStreaming();
    });

    // Copier URL
    dom.btnCopyUrl.addEventListener('click', () => {
      const url = dom.clientUrl.textContent;
      if (url && url !== '—') {
        navigator.clipboard.writeText(url).then(() => {
          showToast('URL copiée dans le presse-papiers ! 📋', 'success');
          dom.btnCopyUrl.textContent = '✅ Copié !';
          setTimeout(() => { dom.btnCopyUrl.textContent = '📋 Copier'; }, 2000);
        }).catch(() => {
          // Fallback
          selectText(dom.clientUrl);
          showToast('Sélectionnez et copiez l\'URL manuellement.', 'info');
        });
      }
    });

    // Détecter les changements de périphériques
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

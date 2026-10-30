/**
 * AudioPlayer — Streaming PCM playback engine
 * Decodes base64-encoded Int16 PCM chunks (24 kHz) and plays them continuously.
 * Uses AudioWorkletNode with fallback to ScriptProcessorNode.
 * Includes memory alignment safety, continuous resampling, and jitter buffering.
 */
class AudioPlayer {
  /**
   * @param {number} [inputSampleRate=24000] — sample rate of incoming PCM data from Gemini
   * @param {number} [bufferDuration=1.0] — circular buffer length in seconds
   */
  constructor(inputSampleRate = 24000, bufferDuration = 1.0) {
    this._inputSampleRate = inputSampleRate;
    this._bufferDuration = bufferDuration;
    this._ctx = null;
    this._gainNode = null;
    this._workletNode = null;
    this._processorNode = null;

    // Resampler boundary state
    this._lastResampleSample = 0;

    // Fallback circular buffer state
    this._bufferSize = 0;
    this._buffer = null;
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;
    this._isFallbackBuffering = true;

    // State
    this._playing = false;
    this._level = 0;
    this._volume = 1;
    this._isWorklet = false;
  }

  get isPlaying() {
    return this._playing;
  }

  /**
   * Start playback. MUST be called from a user-gesture handler so that
   * AudioContext.resume() succeeds on Safari / iOS.
   */
  async start() {
    if (this._playing) return;

    // Everything up to the first await runs inside the user's tap, which
    // mobile browsers require to start audio.
    if (!this._ctx || this._ctx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      try {
        this._ctx = new AC({ sampleRate: this._inputSampleRate });
      } catch (e) {
        this._ctx = new AC();
      }
      this._ctx.addEventListener?.('statechange', () => {
        // iOS "interrupts" audio for calls or Siri; resume once allowed.
        if (this._playing && this._ctx.state !== 'running' && this._ctx.state !== 'closed') {
          this._ctx.resume().catch(() => {});
        }
      });
    }

    // iOS 17+: declare this as media playback so it keeps playing with the
    // screen locked and ignores the silent switch.
    try {
      if (navigator.audioSession) navigator.audioSession.type = 'playback';
    } catch (e) {}

    // Play through a regular <audio> element: browsers keep media elements
    // playing in the background and show lock-screen controls for them,
    // which they do not do for bare Web Audio.
    const playPromise = this._startOutputElement();

    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    this._gainNode = this._ctx.createGain();
    this._gainNode.gain.value = this._volume;

    let routedToElement = false;
    if (playPromise) {
      try {
        await playPromise;
        routedToElement = true;
      } catch (err) {
        console.warn('[AudioPlayer] Background playback element refused, using direct output:', err);
      }
    }
    this._gainNode.connect(routedToElement ? this._streamDest : this._ctx.destination);
    this._backgroundCapable = routedToElement;

    const contextRate = this._ctx.sampleRate;
    const maxLatencySamples = Math.ceil(contextRate * 0.6);

    try {
      if (this._ctx.audioWorklet) {
        await this._ctx.audioWorklet.addModule('audio-player.worklet.js');
        this._workletNode = new AudioWorkletNode(this._ctx, 'audio-player-processor', {
          outputChannelCount: [2]
        });
        this._workletNode.port.onmessage = (e) => {
          if (e.data && e.data.type === 'level') {
            this._level = e.data.level;
          }
        };
        this._workletNode.connect(this._gainNode);
        this._isWorklet = true;
      } else {
        throw new Error('AudioWorklet not supported');
      }
    } catch (err) {
      console.warn('[AudioPlayer] AudioWorklet init failed, falling back to ScriptProcessor:', err);
      this._isWorklet = false;

      this._bufferSize = Math.ceil(contextRate * this._bufferDuration);
      this._buffer = new Float32Array(this._bufferSize);
      this._writePos = 0;
      this._readPos = 0;
      this._bufferedSamples = 0;
      this._maxLatencySamples = maxLatencySamples;
      this._isFallbackBuffering = true;

      const FRAME = 2048;
      this._processorNode = this._ctx.createScriptProcessor(FRAME, 1, 1);
      this._processorNode.onaudioprocess = (e) => this._onFallbackProcess(e);
      this._processorNode.connect(this._gainNode);
    }

    this._playing = true;
  }

  /** True when audio goes through the media element (survives screen lock). */
  get backgroundCapable() {
    return !!this._backgroundCapable;
  }

  /**
   * Bring audio back after the page returns to the foreground or after an
   * interruption (call, other app). Safe to call at any time.
   */
  resume() {
    if (!this._playing || !this._ctx) return;
    if (this._ctx.state !== 'running' && this._ctx.state !== 'closed') {
      this._ctx.resume().catch(() => {});
    }
    if (this._outputEl && this._backgroundCapable && this._outputEl.paused) {
      this._outputEl.play().catch(() => {});
    }
  }

  /** Stop playback and release resources */
  stop() {
    this._playing = false;
    if (this._outputEl) {
      this._outputEl.pause();
    }
    if (this._workletNode) {
      try {
        this._workletNode.port.postMessage({ type: 'clear' });
        this._workletNode.disconnect();
      } catch (e) {}
      this._workletNode = null;
    }
    if (this._processorNode) {
      this._processorNode.disconnect();
      this._processorNode.onaudioprocess = null;
      this._processorNode = null;
    }
    if (this._gainNode) {
      this._gainNode.disconnect();
      this._gainNode = null;
    }
    if (this._buffer) {
      this._buffer.fill(0);
      this._writePos = 0;
      this._readPos = 0;
      this._bufferedSamples = 0;
    }
    this._level = 0;
    this._lastResampleSample = 0;
  }

  /**
   * Feed a base64-encoded Int16 PCM chunk (24 kHz) into the player.
   * @param {string} base64Chunk
   */
  feed(base64Chunk) {
    if (!this._playing || !this._ctx) return;

    // 1. Decode Int16 PCM to Float32 at 24kHz
    const rawFloat32 = this._decodeBase64ToFloat32(base64Chunk);
    if (!rawFloat32 || rawFloat32.length === 0) return;

    // 2. Resample Float32 to AudioContext target sampleRate if different from 24kHz
    const targetRate = this._ctx.sampleRate;
    const resampledFloat32 = this._resample(rawFloat32, this._inputSampleRate, targetRate);

    // 3. Send to Worklet or Fallback buffer
    if (this._isWorklet && this._workletNode) {
      const maxLatencySamples = Math.ceil(targetRate * 0.6);
      this._workletNode.port.postMessage({
        type: 'feed',
        samples: resampledFloat32,
        sampleRate: targetRate,
        maxLatencySamples: maxLatencySamples
      });
    } else if (this._buffer) {
      this._feedFallback(resampledFloat32, targetRate);
    }
  }

  getLevel() {
    return this._level;
  }

  setVolume(value) {
    this._volume = Math.max(0, Math.min(1, value));
    if (this._gainNode && this._ctx) {
      this._gainNode.gain.setValueAtTime(this._volume, this._ctx.currentTime);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  /**
   * Create (once) a hidden <audio> element fed by the AudioContext and start
   * it. Returns the play() promise, or null when not supported.
   */
  _startOutputElement() {
    if (typeof this._ctx.createMediaStreamDestination !== 'function') return null;
    try {
      if (!this._outputEl) {
        this._streamDest = this._ctx.createMediaStreamDestination();
        const el = document.createElement('audio');
        el.setAttribute('playsinline', '');
        el.style.display = 'none';
        el.srcObject = this._streamDest.stream;
        document.body.appendChild(el);
        this._outputEl = el;
      }
      return this._outputEl.play();
    } catch (err) {
      console.warn('[AudioPlayer] Background playback element unavailable:', err);
      return null;
    }
  }

  /** Smooth boundary-aware linear resampler */
  _resample(samples, sourceRate, targetRate) {
    if (!samples || sourceRate === targetRate) return samples;
    const ratio = targetRate / sourceRate;
    const newLength = Math.round(samples.length * ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const originPos = i / ratio;
      const index = Math.floor(originPos);
      const fraction = originPos - index;

      const s0 = (index === 0) ? this._lastResampleSample : samples[index - 1];
      const s1 = samples[index];

      result[i] = s0 + fraction * (s1 - s0);
    }
    this._lastResampleSample = samples[samples.length - 1];
    return result;
  }

  /** Decode base64 PCM Int16 safely with memory alignment check */
  _decodeBase64ToFloat32(base64) {
    try {
      const binaryStr = atob(base64);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const pairCount = Math.floor(bytes.byteLength / 2);
      if (pairCount === 0) return null;

      const int16 = new Int16Array(bytes.buffer, bytes.byteOffset, pairCount);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
      return float32;
    } catch (err) {
      console.warn('[AudioPlayer] Failed to decode audio chunk:', err);
      return null;
    }
  }

  /** ScriptProcessor fallback feed with pre-buffering */
  _feedFallback(float32, targetRate) {
    const minPrebuffer = Math.ceil(targetRate * 0.15); // 150ms

    if (this._bufferedSamples + float32.length > this._bufferSize) {
      const overflow = (this._bufferedSamples + float32.length) - this._maxLatencySamples;
      if (overflow > 0) {
        const skip = Math.min(overflow, this._bufferedSamples);
        this._readPos = (this._readPos + skip) % this._bufferSize;
        this._bufferedSamples -= skip;
      }
    }
    for (let i = 0; i < float32.length; i++) {
      this._buffer[this._writePos] = float32[i];
      this._writePos = (this._writePos + 1) % this._bufferSize;
    }
    this._bufferedSamples += float32.length;

    if (this._isFallbackBuffering && this._bufferedSamples >= minPrebuffer) {
      this._isFallbackBuffering = false;
    }
  }

  /** ScriptProcessor fallback callback */
  _onFallbackProcess(event) {
    const output = event.outputBuffer.getChannelData(0);
    const len = output.length;
    let sumSq = 0;

    const minPrebuffer = Math.ceil((this._ctx?.sampleRate || 24000) * 0.15);

    if (this._isFallbackBuffering) {
      if (this._bufferedSamples >= minPrebuffer) {
        this._isFallbackBuffering = false;
      } else {
        output.fill(0);
        return;
      }
    }

    for (let i = 0; i < len; i++) {
      if (this._bufferedSamples > 0) {
        const sample = this._buffer[this._readPos];
        output[i] = sample;
        sumSq += sample * sample;
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._bufferedSamples--;
      } else {
        output[i] = 0;
        this._isFallbackBuffering = true;
      }
    }

    const rms = Math.sqrt(sumSq / len);
    this._level = this._level * 0.7 + rms * 0.3;
  }
}

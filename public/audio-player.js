/**
 * AudioPlayer — Streaming PCM playback engine
 * Decodes base64-encoded Int16 PCM chunks (24 kHz) and plays them continuously.
 * Uses AudioWorkletNode with fallback to ScriptProcessorNode.
 * Includes memory alignment safety and context rate resampling.
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
    this._processorNode = null; // Fallback ScriptProcessor

    // Fallback circular buffer state
    this._bufferSize = 0;
    this._buffer = null;
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;

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

    // Initialize AudioContext without forcing non-standard sampleRate
    if (!this._ctx || this._ctx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AC();
    }

    // Safari: must resume inside a user gesture
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    // GainNode for volume control
    this._gainNode = this._ctx.createGain();
    this._gainNode.gain.value = this._volume;
    this._gainNode.connect(this._ctx.destination);

    const contextRate = this._ctx.sampleRate;
    const maxLatencySamples = Math.ceil(contextRate * 0.6);

    // Try AudioWorklet first
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

      // Fallback: ScriptProcessorNode
      this._bufferSize = Math.ceil(contextRate * this._bufferDuration);
      this._buffer = new Float32Array(this._bufferSize);
      this._writePos = 0;
      this._readPos = 0;
      this._bufferedSamples = 0;
      this._maxLatencySamples = maxLatencySamples;

      const FRAME = 2048;
      this._processorNode = this._ctx.createScriptProcessor(FRAME, 1, 1);
      this._processorNode.onaudioprocess = (e) => this._onFallbackProcess(e);
      this._processorNode.connect(this._gainNode);
    }

    this._playing = true;
  }

  /** Stop playback and release resources */
  stop() {
    this._playing = false;
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
  }

  /**
   * Feed a base64-encoded Int16 PCM chunk (24 kHz) into the player.
   * @param {string} base64Chunk
   */
  feed(base64Chunk) {
    if (!this._playing || !this._ctx) return;

    // 1. Decode Int16 PCM to Float32 at source rate (24000 Hz)
    const rawFloat32 = this._decodeBase64ToFloat32(base64Chunk);
    if (!rawFloat32 || rawFloat32.length === 0) return;

    // 2. Resample Float32 to AudioContext target sampleRate if needed
    const targetRate = this._ctx.sampleRate;
    const resampledFloat32 = this._resample(rawFloat32, this._inputSampleRate, targetRate);

    // 3. Send to Worklet or Fallback buffer
    if (this._isWorklet && this._workletNode) {
      const maxLatencySamples = Math.ceil(targetRate * 0.6);
      this._workletNode.port.postMessage({
        type: 'feed',
        samples: resampledFloat32,
        maxLatencySamples: maxLatencySamples
      });
    } else if (this._buffer) {
      this._feedFallback(resampledFloat32);
    }
  }

  /** Returns current RMS audio level (0–1) */
  getLevel() {
    return this._level;
  }

  /** Set volume (0–1) */
  setVolume(value) {
    this._volume = Math.max(0, Math.min(1, value));
    if (this._gainNode && this._ctx) {
      this._gainNode.gain.setValueAtTime(this._volume, this._ctx.currentTime);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                         */
  /* ------------------------------------------------------------------ */

  /** Linear resampling helper */
  _resample(samples, sourceRate, targetRate) {
    if (!samples || sourceRate === targetRate) return samples;
    const ratio = targetRate / sourceRate;
    const newLength = Math.round(samples.length * ratio);
    const result = new Float32Array(newLength);
    for (let i = 0; i < newLength; i++) {
      const originPos = i / ratio;
      const index = Math.floor(originPos);
      const fraction = originPos - index;
      const nextIndex = Math.min(index + 1, samples.length - 1);
      result[i] = samples[index] * (1 - fraction) + samples[nextIndex] * fraction;
    }
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

      // Explicit byteOffset and length to prevent iOS Safari memory alignment RangeError
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

  /** ScriptProcessor fallback feed */
  _feedFallback(float32) {
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
  }

  /** ScriptProcessor fallback callback */
  _onFallbackProcess(event) {
    const output = event.outputBuffer.getChannelData(0);
    const len = output.length;
    let sumSq = 0;

    for (let i = 0; i < len; i++) {
      if (this._bufferedSamples > 0) {
        const sample = this._buffer[this._readPos];
        output[i] = sample;
        sumSq += sample * sample;
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._bufferedSamples--;
      } else {
        output[i] = 0;
      }
    }

    const rms = Math.sqrt(sumSq / len);
    this._level = this._level * 0.7 + rms * 0.3;
  }
}

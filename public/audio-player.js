/**
 * AudioPlayer — Streaming PCM 24kHz playback engine
 * Decodes base64-encoded Int16 PCM chunks and plays them continuously
 * using a ScriptProcessorNode with a circular buffer.
 */
class AudioPlayer {
  /**
   * @param {number} [sampleRate=24000] — sample rate of incoming PCM data
   * @param {number} [bufferDuration=1.0] — circular buffer length in seconds
   */
  constructor(sampleRate = 24000, bufferDuration = 1.0) {
    this._inputSampleRate = sampleRate;
    this._ctx = null;
    this._gainNode = null;
    this._processorNode = null;

    // Circular buffer (Float32)
    this._bufferSize = Math.ceil(sampleRate * bufferDuration);
    this._buffer = new Float32Array(this._bufferSize);
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;

    // State
    this._playing = false;
    this._level = 0;
    this._volume = 1;
    this._underrun = false;

    // Max tolerated latency in samples (~600 ms). If buffer exceeds this we skip.
    this._maxLatencySamples = Math.ceil(sampleRate * 0.6);
  }

  /* ------------------------------------------------------------------ */
  /*  Public API                                                         */
  /* ------------------------------------------------------------------ */

  /** true while actively playing */
  get isPlaying() {
    return this._playing;
  }

  /**
   * Start playback. MUST be called from a user-gesture handler so that
   * AudioContext.resume() succeeds on Safari / iOS.
   */
  async start() {
    if (this._playing) return;

    // Create or re-use AudioContext at native rate (we resample manually)
    if (!this._ctx || this._ctx.state === 'closed') {
      const AC = window.AudioContext || window.webkitAudioContext;
      this._ctx = new AC({ sampleRate: this._inputSampleRate });
    }

    // Safari: must resume inside a user gesture
    if (this._ctx.state === 'suspended') {
      await this._ctx.resume();
    }

    // GainNode for volume control
    this._gainNode = this._ctx.createGain();
    this._gainNode.gain.value = this._volume;
    this._gainNode.connect(this._ctx.destination);

    // ScriptProcessorNode (2048 frame buffer, mono in, mono out)
    const FRAME = 2048;
    this._processorNode = this._ctx.createScriptProcessor(FRAME, 1, 1);
    this._processorNode.onaudioprocess = (e) => this._onProcess(e);
    this._processorNode.connect(this._gainNode);

    this._playing = true;
  }

  /** Stop playback and release resources */
  stop() {
    this._playing = false;
    if (this._processorNode) {
      this._processorNode.disconnect();
      this._processorNode.onaudioprocess = null;
      this._processorNode = null;
    }
    if (this._gainNode) {
      this._gainNode.disconnect();
      this._gainNode = null;
    }
    // Clear circular buffer
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;
    this._level = 0;
    this._buffer.fill(0);
  }

  /**
   * Feed a base64-encoded Int16 PCM chunk into the playback buffer.
   * @param {string} base64Chunk
   */
  feed(base64Chunk) {
    const float32 = this._decodeBase64ToFloat32(base64Chunk);
    if (!float32 || float32.length === 0) return;

    // If buffer is getting dangerously full, skip oldest data to stay real-time
    if (this._bufferedSamples + float32.length > this._bufferSize) {
      const overflow = (this._bufferedSamples + float32.length) - this._maxLatencySamples;
      if (overflow > 0) {
        const skip = Math.min(overflow, this._bufferedSamples);
        this._readPos = (this._readPos + skip) % this._bufferSize;
        this._bufferedSamples -= skip;
      }
    }

    // Write into circular buffer
    for (let i = 0; i < float32.length; i++) {
      this._buffer[this._writePos] = float32[i];
      this._writePos = (this._writePos + 1) % this._bufferSize;
    }
    this._bufferedSamples += float32.length;
  }

  /**
   * Returns current RMS audio level (0–1) for visualisation.
   */
  getLevel() {
    return this._level;
  }

  /**
   * Set playback volume.
   * @param {number} value 0–1
   */
  setVolume(value) {
    this._volume = Math.max(0, Math.min(1, value));
    if (this._gainNode) {
      this._gainNode.gain.setValueAtTime(this._volume, this._ctx.currentTime);
    }
  }

  /* ------------------------------------------------------------------ */
  /*  Internals                                                          */
  /* ------------------------------------------------------------------ */

  /**
   * ScriptProcessorNode callback — pulls samples from the circular buffer.
   */
  _onProcess(event) {
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
        this._underrun = false;
      } else {
        // Buffer underrun — output silence
        output[i] = 0;
        this._underrun = true;
      }
    }

    // RMS level (smoothed)
    const rms = Math.sqrt(sumSq / len);
    // Exponential smoothing
    this._level = this._level * 0.7 + rms * 0.3;
  }

  /**
   * Decode a base64 string containing Int16 PCM into a Float32Array
   * normalised to [-1, 1].
   */
  _decodeBase64ToFloat32(base64) {
    try {
      const binaryStr = atob(base64);
      const len = binaryStr.length;
      const bytes = new Uint8Array(len);
      for (let i = 0; i < len; i++) {
        bytes[i] = binaryStr.charCodeAt(i);
      }
      const int16 = new Int16Array(bytes.buffer);
      const float32 = new Float32Array(int16.length);
      for (let i = 0; i < int16.length; i++) {
        float32[i] = int16[i] / 32768;
      }
      return float32;
    } catch (err) {
      console.warn('[AudioPlayer] Failed to decode chunk:', err);
      return null;
    }
  }
}

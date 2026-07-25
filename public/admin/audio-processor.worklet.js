/**
 * AudioCaptureProcessor — AudioWorklet that captures microphone audio,
 * resamples it smoothly using continuous phase accumulation from input rate (e.g. 48kHz)
 * to 16 kHz mono PCM (Int16), using a pre-allocated ring buffer to eliminate GC pressure.
 *
 * Sends to main thread:
 *   { type: 'audio', buffer: ArrayBuffer }   — Int16 PCM at 16 kHz (100 ms chunks)
 *   { type: 'level', level: number }         — RMS level 0‥1
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._targetRate = 16000;
    this._samplesPerChunk = 1600; // 100ms at 16kHz

    // Pre-allocated ring buffer (32768 samples = 2+ seconds at 16kHz)
    this._ringBufferSize = 32768;
    this._ringBuffer = new Float32Array(this._ringBufferSize);
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedCount = 0;

    // Resampling phase accumulator
    this._phaseAccumulator = 0;
    this._lastInputSample = 0;

    // Level meter timer counter
    this._levelCounter = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const samples = input[0]; // Float32Array mono channel
    const len = samples.length;

    // 1. Smooth linear resampling with continuous phase accumulation
    const step = sampleRate / this._targetRate;

    while (this._phaseAccumulator < len) {
      const index = Math.floor(this._phaseAccumulator);
      const frac = this._phaseAccumulator - index;

      const s0 = (index === 0) ? this._lastInputSample : samples[index - 1];
      const s1 = samples[index];

      const interpolated = s0 + frac * (s1 - s0);

      if (this._bufferedCount < this._ringBufferSize) {
        this._ringBuffer[this._writePos] = interpolated;
        this._writePos = (this._writePos + 1) % this._ringBufferSize;
        this._bufferedCount++;
      }

      this._phaseAccumulator += step;
    }

    this._phaseAccumulator -= len;
    this._lastInputSample = samples[len - 1];

    this._levelCounter += len;
    if (this._levelCounter >= sampleRate * 0.05) {
      let sum = 0;
      for (let i = 0; i < len; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / len);
      this.port.postMessage({ type: 'level', level: rms });
      this._levelCounter = 0;
    }

    // 3. Emit 1600-sample PCM Int16 chunks
    while (this._bufferedCount >= this._samplesPerChunk) {
      const pcm = new Int16Array(this._samplesPerChunk);
      for (let i = 0; i < this._samplesPerChunk; i++) {
        const s = Math.max(-1, Math.min(1, this._ringBuffer[this._readPos]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
        this._readPos = (this._readPos + 1) % this._ringBufferSize;
      }
      this._bufferedCount -= this._samplesPerChunk;

      this.port.postMessage(
        { type: 'audio', buffer: pcm.buffer },
        [pcm.buffer]
      );
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

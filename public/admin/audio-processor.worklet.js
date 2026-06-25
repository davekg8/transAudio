/**
 * AudioCaptureProcessor — AudioWorklet that captures microphone audio,
 * resamples it from the source sample rate to 16 kHz mono PCM (Int16),
 * and computes RMS level for the VU meter.
 *
 * Sends to main thread:
 *   { type: 'audio', buffer: ArrayBuffer }   — Int16 PCM at 16 kHz (~100 ms chunks)
 *   { type: 'level', level: number }         — RMS level 0‥1
 */
class AudioCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this._buffer = [];
    this._samplesPerChunk = 1600; // 100ms at 16kHz
    this._levelCounter = 0;
  }

  process(inputs) {
    const input = inputs[0];
    if (!input || !input[0] || input[0].length === 0) return true;

    const samples = input[0]; // Float32Array, mono channel

    // Resample from sampleRate to 16kHz
    const ratio = sampleRate / 16000;
    const outputLength = Math.floor(samples.length / ratio);

    for (let i = 0; i < outputLength; i++) {
      const srcIndex = i * ratio;
      const floor = Math.floor(srcIndex);
      const ceil = Math.min(floor + 1, samples.length - 1);
      const frac = srcIndex - floor;

      // Linear interpolation
      const sample = samples[floor] * (1 - frac) + samples[ceil] * frac;
      this._buffer.push(sample);
    }

    // Compute RMS level every ~50ms for the VU meter
    this._levelCounter += samples.length;
    if (this._levelCounter >= sampleRate * 0.05) {
      let sum = 0;
      for (let i = 0; i < samples.length; i++) {
        sum += samples[i] * samples[i];
      }
      const rms = Math.sqrt(sum / samples.length);
      this.port.postMessage({ type: 'level', level: Math.min(rms * 3, 1) });
      this._levelCounter = 0;
    }

    // When we have enough samples, send a chunk
    while (this._buffer.length >= this._samplesPerChunk) {
      const chunk = this._buffer.splice(0, this._samplesPerChunk);

      // Convert Float32 to Int16 PCM
      const pcm = new Int16Array(chunk.length);
      for (let i = 0; i < chunk.length; i++) {
        const s = Math.max(-1, Math.min(1, chunk[i]));
        pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff;
      }

      this.port.postMessage(
        { type: 'audio', buffer: pcm.buffer },
        [pcm.buffer]
      );
    }

    return true;
  }
}

registerProcessor('audio-capture-processor', AudioCaptureProcessor);

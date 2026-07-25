/**
 * AudioPlayerProcessor — AudioWorkletProcessor for high-performance,
 * stutter-free audio streaming playback with a circular buffer.
 */
class AudioPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    // 3 seconds max ring buffer (supports up to 192kHz)
    this._bufferSize = 192000;
    this._buffer = new Float32Array(this._bufferSize);
    this._writePos = 0;
    this._readPos = 0;
    this._bufferedSamples = 0;
    this._level = 0;

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'feed' && msg.samples) {
        const float32 = msg.samples;
        const maxLatency = msg.maxLatencySamples || 28800;

        // Skip oldest samples if buffer exceeds max latency
        if (this._bufferedSamples + float32.length > this._bufferSize) {
          const overflow = (this._bufferedSamples + float32.length) - maxLatency;
          if (overflow > 0) {
            const skip = Math.min(overflow, this._bufferedSamples);
            this._readPos = (this._readPos + skip) % this._bufferSize;
            this._bufferedSamples -= skip;
          }
        }

        // Write new samples into circular buffer
        for (let i = 0; i < float32.length; i++) {
          this._buffer[this._writePos] = float32[i];
          this._writePos = (this._writePos + 1) % this._bufferSize;
        }
        this._bufferedSamples += float32.length;
      } else if (msg.type === 'clear') {
        this._writePos = 0;
        this._readPos = 0;
        this._bufferedSamples = 0;
        this._level = 0;
        this._buffer.fill(0);
      }
    };
  }

  process(inputs, outputs) {
    const output = outputs[0];
    if (!output || !output[0]) return true;

    const channel = output[0];
    const len = channel.length;
    let sumSq = 0;

    for (let i = 0; i < len; i++) {
      if (this._bufferedSamples > 0) {
        const sample = this._buffer[this._readPos];
        channel[i] = sample;
        sumSq += sample * sample;
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._bufferedSamples--;
      } else {
        channel[i] = 0;
      }
    }

    // Duplicate mono channel to second output channel if present (stereo)
    if (output.length > 1 && output[1]) {
      output[1].set(channel);
    }

    // Compute RMS audio level
    const rms = Math.sqrt(sumSq / len);
    this._level = this._level * 0.7 + rms * 0.3;

    // Send level to main thread for UI meter
    this.port.postMessage({ type: 'level', level: this._level });

    return true;
  }
}

registerProcessor('audio-player-processor', AudioPlayerProcessor);

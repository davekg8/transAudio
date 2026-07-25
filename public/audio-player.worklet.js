/**
 * AudioPlayerProcessor — AudioWorkletProcessor for high-performance,
 * stutter-free audio streaming playback with jitter pre-buffering.
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

    // Jitter pre-buffering state (~150ms buffer required before playback starts/resumes)
    this._isBuffering = true;
    this._minPrebufferSamples = 3600; // default for 24kHz

    this.port.onmessage = (event) => {
      const msg = event.data;
      if (!msg) return;

      if (msg.type === 'feed' && msg.samples) {
        const float32 = msg.samples;
        const maxLatency = msg.maxLatencySamples || 28800; // ~600ms

        if (msg.sampleRate) {
          this._minPrebufferSamples = Math.ceil(msg.sampleRate * 0.15); // 150ms
        }

        // Manage latency overflow
        if (this._bufferedSamples + float32.length > this._bufferSize) {
          const overflow = (this._bufferedSamples + float32.length) - maxLatency;
          if (overflow > 0) {
            const skip = Math.min(overflow, this._bufferedSamples);
            this._readPos = (this._readPos + skip) % this._bufferSize;
            this._bufferedSamples -= skip;
          }
        }

        // Write new samples into ring buffer
        for (let i = 0; i < float32.length; i++) {
          this._buffer[this._writePos] = float32[i];
          this._writePos = (this._writePos + 1) % this._bufferSize;
        }
        this._bufferedSamples += float32.length;

        // Resume playback when pre-buffer threshold is reached
        if (this._isBuffering && this._bufferedSamples >= this._minPrebufferSamples) {
          this._isBuffering = false;
        }
      } else if (msg.type === 'clear') {
        this._writePos = 0;
        this._readPos = 0;
        this._bufferedSamples = 0;
        this._level = 0;
        this._isBuffering = true;
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

    // Output silence during pre-buffering phase
    if (this._isBuffering) {
      if (this._bufferedSamples >= this._minPrebufferSamples) {
        this._isBuffering = false;
      } else {
        channel.fill(0);
        if (output.length > 1 && output[1]) output[1].fill(0);
        return true;
      }
    }

    for (let i = 0; i < len; i++) {
      if (this._bufferedSamples > 0) {
        const sample = this._buffer[this._readPos];
        channel[i] = sample;
        sumSq += sample * sample;
        this._readPos = (this._readPos + 1) % this._bufferSize;
        this._bufferedSamples--;
      } else {
        // Buffer underrun — enter pre-buffering mode to absorb network jitter
        channel[i] = 0;
        this._isBuffering = true;
      }
    }

    // Duplicate mono channel for stereo output
    if (output.length > 1 && output[1]) {
      output[1].set(channel);
    }

    // RMS level calculation
    const rms = Math.sqrt(sumSq / len);
    this._level = this._level * 0.7 + rms * 0.3;

    this.port.postMessage({ type: 'level', level: this._level });

    return true;
  }
}

registerProcessor('audio-player-processor', AudioPlayerProcessor);

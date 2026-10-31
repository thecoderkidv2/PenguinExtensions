class AudioAnalyzerExtension {
  constructor() {
    this._analyser = null;
    this._audioEngine = null;
  }

  getInfo() {
    return {
      id: 'penguinmodAudioAnalyzer',
      name: 'Audio Analyzer',
      color1: '#0FBD8C',
      color2: '#0DA57A',
      color3: '#0B8C68',
      blocks: [
        {
          opcode: 'getVolume',
          blockType: Scratch.BlockType.REPORTER,
          text: 'current audio volume (0–100)',
          disableMonitor: false
        },
        {
          opcode: 'getPitch',
          blockType: Scratch.BlockType.REPORTER,
          text: 'current audio pitch (Hz)',
          disableMonitor: false
        },
        {
          opcode: 'getSpectrum',
          blockType: Scratch.BlockType.REPORTER,
          text: 'audio spectrum with [BINS] bins',
          arguments: {
            BINS: {
              type: Scratch.ArgumentType.NUMBER,
              defaultValue: 32
            }
          },
          disableMonitor: true
        },
        {
          opcode: 'getVolumeAtFrequency',
          blockType: Scratch.BlockType.REPORTER,
          text: 'volume at [FREQ] Hz (0–100)',
          arguments: {
            FREQ: {
              type: Scratch.ArgumentType.NUMBER,
              defaultValue: 440
            }
          },
          disableMonitor: false
        }
      ]
    };
  }

  // Grab the audio engine from the runtime (unsandboxed only).
  _getAudioEngine(util) {
    return util && util.runtime && util.runtime.audioEngine;
  }

  // Create an AnalyserNode once and connect the master output to it.
  // The analyser is NOT connected to the speakers, so it does not
  // change what you hear.
  _ensureAnalyser(util) {
    const audioEngine = this._getAudioEngine(util);
    if (!audioEngine) return null;

    if (this._analyser && this._audioEngine === audioEngine) {
      return this._analyser;
    }

    const ctx =
      audioEngine.audioContext ||
      (audioEngine.inputNode && audioEngine.inputNode.context);

    if (!ctx) return null;

    const analyser = ctx.createAnalyser();
    analyser.fftSize = 2048;          // 1024 frequency bins
    analyser.smoothingTimeConstant = 0.8;

    try {
      if (audioEngine.inputNode) {
        audioEngine.inputNode.connect(analyser);
      }
    } catch (e) {
      // Already connected or failed; ignore.
    }

    this._analyser = analyser;
    this._audioEngine = audioEngine;
    return analyser;
  }

  _getTimeDomainData(analyser) {
    const data = new Float32Array(analyser.fftSize);
    analyser.getFloatTimeDomainData(data);
    return data;
  }

  _getFrequencyData(analyser) {
    const data = new Uint8Array(analyser.frequencyBinCount);
    analyser.getByteFrequencyData(data);
    return data;
  }

  // ------------------------------------------------------------
  // Reporter: current volume (RMS, 0–100)
  // ------------------------------------------------------------
  getVolume(args, util) {
    const analyser = this._ensureAnalyser(util);
    if (!analyser) return 0;

    const data = this._getTimeDomainData(analyser);
    let sum = 0;
    for (let i = 0; i < data.length; i++) {
      const v = data[i];
      sum += v * v;
    }

    const rms = Math.sqrt(sum / data.length);
    return Math.round(Math.min(100, rms * 100));
  }

  // ------------------------------------------------------------
  // Reporter: current pitch in Hz (autocorrelation)
  // ------------------------------------------------------------
  getPitch(args, util) {
    const analyser = this._ensureAnalyser(util);
    if (!analyser) return 0;

    const data = this._getTimeDomainData(analyser);
    const sampleRate = analyser.context.sampleRate;

    // Ignore very quiet signals.
    let rms = 0;
    for (let i = 0; i < data.length; i++) {
      rms += data[i] * data[i];
    }
    rms = Math.sqrt(rms / data.length);
    if (rms < 0.01) return 0;

    const SIZE = data.length;

    // Limit the search range to roughly 50 Hz – 2000 Hz.
    const minLag = Math.max(1, Math.floor(sampleRate / 2000));
    const maxLag = Math.min(SIZE - 1, Math.floor(sampleRate / 50));

    const c = new Float32Array(maxLag + 2).fill(0);

    for (let lag = minLag; lag <= maxLag; lag++) {
      let sum = 0;
      for (let i = 0; i < SIZE - lag; i++) {
        sum += data[i] * data[i + lag];
      }
      c[lag] = sum;
    }

    let maxVal = -Infinity;
    let maxLagIndex = -1;

    for (let lag = minLag; lag <= maxLag; lag++) {
      if (c[lag] > maxVal) {
        maxVal = c[lag];
        maxLagIndex = lag;
      }
    }

    if (maxLagIndex < 0) return 0;

    // Parabolic interpolation around the peak for a smoother value.
    let T0 = maxLagIndex;

    if (T0 > minLag && T0 < maxLag) {
      const x1 = c[T0 - 1];
      const x2 = c[T0];
      const x3 = c[T0 + 1];
      const a = (x1 + x3 - 2 * x2) / 2;
      const b = (x3 - x1) / 2;

      if (a !== 0) {
        T0 = T0 - b / (2 * a);
      }
    }

    if (T0 <= 0) return 0;

    const pitch = sampleRate / T0;

    if (pitch < 20 || pitch > 20000) return 0;
    return Math.round(pitch * 100) / 100;
  }

  // ------------------------------------------------------------
  // Reporter: frequency spectrum (list of 0–100 values)
  // ------------------------------------------------------------
  getSpectrum(args, util) {
    const analyser = this._ensureAnalyser(util);
    if (!analyser) return [];

    const binCount = Math.max(
      1,
      Math.min(256, Math.round(Number(args.BINS) || 32))
    );

    const data = this._getFrequencyData(analyser);
    const rawBins = data.length;
    const result = new Array(binCount).fill(0);
    const perBin = rawBins / binCount;

    for (let i = 0; i < binCount; i++) {
      const start = Math.floor(i * perBin);
      const end = Math.floor((i + 1) * perBin);
      let sum = 0;
      let count = 0;

      for (let j = start; j < end; j++) {
        sum += data[j];
        count++;
      }

      result[i] = count > 0 ? Math.round(sum / count) : 0;
    }

    return result;
  }

  // ------------------------------------------------------------
  // Reporter: volume at a specific frequency (0–100)
  // ------------------------------------------------------------
  getVolumeAtFrequency(args, util) {
    const analyser = this._ensureAnalyser(util);
    if (!analyser) return 0;

    const freq = Number(args.FREQ) || 0;
    const sampleRate = analyser.context.sampleRate;
    const binCount = analyser.frequencyBinCount;
    const binIndex = Math.round(
      (freq / (sampleRate / 2)) * binCount
    );

    if (binIndex < 0 || binIndex >= binCount) return 0;

    const data = this._getFrequencyData(analyser);
    return Math.round((data[binIndex] / 255) * 100);
  }
}

Scratch.extensions.register(new AudioAnalyzerExtension());

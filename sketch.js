/* Sonic Architecture: sketch.js
 * ------------------------------------------------------------
 * Sound in -> frequency analysis -> procedural architecture out.
 *
 *  1. AUDIO     Microphone (Web Audio AnalyserNode, live) or a decoded
 *               file / synthesised demo (own radix-2 FFT, offline).
 *  2. FRAMES    Each moment of sound becomes a "frame": energy in eight
 *               log-spaced bands + loudness + spectral centroid.
 *  3. BUILD     A structure mode turns frames into buildings: bass sets
 *               footprints, mids + loudness set storeys, brightness picks
 *               glass towers over masonry, quiet grows parks and trees.
 *  4. OUTPUT    PNG poster (render + section drawing) or GLB model.
 * ------------------------------------------------------------ */
(() => {
  'use strict';

  const T = window.THREE;
  if (!T) {
    document.getElementById('status').textContent = 'three.js failed to load. Check that vendor/three.bundle.js is next to index.html.';
    return;
  }

  /* =========================================================
   * 0. CONSTANTS + SMALL HELPERS
   * ========================================================= */

  // Eight log-spaced bands, grouped into bass (0-2), mids (3-5), highs (6-7).
  const BANDS = [[30, 60], [60, 120], [120, 250], [250, 500], [500, 1000], [1000, 2500], [2500, 6000], [6000, 16000]];
  const BAND_GROUP = [0, 0, 0, 1, 1, 1, 2, 2];
  const FFT_SIZE = 2048;
  const LIVE_FPS = 12;            // live frames captured per second while recording
  const LIVE_MAX_FRAMES = 600;    // 50 seconds
  const MAX_BOXES = 40000;

  const clamp = (v, a = 0, b = 1) => Math.min(b, Math.max(a, v));
  const lerp = (a, b, t) => a + (b - a) * t;
  const fmtTime = (s) => {
    s = Math.max(0, s || 0);
    return `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;
  };

  // Deterministic pseudo-random, so the same sound always builds the same structure.
  // `variation` is bumped by the "New variation" button to re-roll every layout.
  let variation = 0;
  function mulberry32(seed) {
    let a = (seed + Math.imul(variation, 0x9E3779B1)) >>> 0;
    return () => {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      let t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  function percentile(arr, p) {
    const s = Float32Array.from(arr).sort();
    if (!s.length) return 0;
    return s[Math.min(s.length - 1, Math.floor(p * (s.length - 1)))];
  }

  const $ = (id) => document.getElementById(id);
  const ui = {
    app: $('app'),
    viewport: $('viewport'),
    empty: $('emptyState'),
    status: $('status'),
    stats: $('stats'),
    sourceName: $('sourceName'),
    btnRecord: $('btnRecord'),
    btnDemo: $('btnDemo'),
    fileInput: $('fileInput'),
    btnPng: $('btnPng'),
    btnGlb: $('btnGlb'),
    btnPlay: $('btnPlay'),
    time: $('timeDisplay'),
    spectrum: $('spectrum'),
    spectrumLabel: $('spectrumLabel'),
    timeline: $('timeline'),
    micSelect: $('micSelect'),
    btnSpeed: $('btnSpeed'),
    btnShuffle: $('btnShuffle'),
    btnRestart: $('btnRestart'),
    pitchLegend: $('pitchLegend'),
    sliders: {
      bassMass: [$('bassMass'), $('outBass')],
      spikes: [$('spikes'), $('outSpikes')],
      height: [$('height'), $('outHeight')],
      layers: [$('layers'), $('outLayers')],
    },
  };

  let statusTimer = null;
  function setStatus(msg, { error = false, sticky = false } = {}) {
    ui.status.textContent = msg;
    ui.status.classList.toggle('is-error', error);
    clearTimeout(statusTimer);
    if (msg && !sticky) statusTimer = setTimeout(() => { ui.status.textContent = ''; }, error ? 9000 : 4500);
  }

  /* =========================================================
   * 1. STATE
   * ========================================================= */

  const state = {
    mode: 'city',
    palette: 'flyer',
    districts: 0,
    params: { bassMass: 1, spikes: 1, height: 1, layers: 140 },
    rawFrames: [],     // [{ db: Float32Array(8), rms, centroid, pitch, t }]
    allFrames: [],     // every analysed frame of the loaded sound
    frames: [],        // the frames built so far (revealed as the sound plays)
    playedUntil: -1,   // furthest point of the sound heard so far (s); -1 = not yet
    expected: 0,       // total frames of a loaded file (0 while recording live)
    buffer: null,      // AudioBuffer for playback / re-analysis
    sourceLabel: '',
    recording: false,
    playing: false,
    playStart: 0,      // audioCtx.currentTime when playback started
    playOffset: 0,     // seconds into the buffer
    rate: 1,           // playback speed: 1, 2 or 4
    currentFrame: -1,
    anchors: [],       // per-frame playhead positions
    ranges: [],        // per-frame instance index ranges, for highlighting
  };

  /* =========================================================
   * 2. FFT (own implementation, used for offline analysis)
   * ========================================================= */

  const FFT = (() => {
    const n = FFT_SIZE;
    const levels = Math.log2(n);
    const rev = new Uint32Array(n);
    for (let i = 0; i < n; i++) {
      let r = 0;
      for (let b = 0; b < levels; b++) r = (r << 1) | ((i >>> b) & 1);
      rev[i] = r;
    }
    const cos = new Float32Array(n / 2), sin = new Float32Array(n / 2);
    for (let i = 0; i < n / 2; i++) {
      cos[i] = Math.cos((2 * Math.PI * i) / n);
      sin[i] = Math.sin((2 * Math.PI * i) / n);
    }
    const hann = new Float32Array(n);
    for (let i = 0; i < n; i++) hann[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (n - 1));
    const re = new Float32Array(n), im = new Float32Array(n);

    // Returns power spectrum (n/2 bins) of `samples` starting at `start`.
    function power(samples, start, out) {
      for (let i = 0; i < n; i++) {
        const s = samples[start + i] || 0;
        re[rev[i]] = s * hann[i];
        im[rev[i]] = 0;
      }
      for (let size = 2; size <= n; size <<= 1) {
        const half = size >>> 1, step = n / size;
        for (let i = 0; i < n; i += size) {
          for (let j = 0, k = 0; j < half; j++, k += step) {
            const a = i + j, b = a + half;
            const tr = re[b] * cos[k] + im[b] * sin[k];
            const ti = -re[b] * sin[k] + im[b] * cos[k];
            re[b] = re[a] - tr; im[b] = im[a] - ti;
            re[a] += tr; im[a] += ti;
          }
        }
      }
      for (let i = 0; i < n / 2; i++) {
        const mr = re[i] / n, mi = im[i] / n;
        out[i] = mr * mr + mi * mi;
      }
      return out;
    }
    return { power, size: n };
  })();

  // Bin ranges for each band at a given sample rate.
  function bandBins(sampleRate) {
    const binHz = sampleRate / FFT_SIZE;
    return BANDS.map(([lo, hi]) => {
      const a = Math.max(1, Math.floor(lo / binHz));
      const b = Math.min(FFT_SIZE / 2 - 1, Math.max(a, Math.ceil(hi / binHz)));
      return [a, b];
    });
  }

  /* Pitch: harmonic product spectrum over 100-1400 Hz (the melody range),
   * refined with parabolic interpolation. Returns 0 for unpitched sound. */
  function detectPitch(powerArr, sampleRate) {
    const binHz = sampleRate / FFT_SIZE;
    const k0 = Math.ceil(100 / binHz), k1 = Math.min(Math.floor(1400 / binHz), Math.floor((powerArr.length - 2) / 3));
    const m = (k) => Math.sqrt(powerArr[k] || 0) + 1e-9;
    let best = -Infinity, bk = k0, mean = 0;
    for (let k = k0; k <= k1; k++) {
      const score = Math.log(m(k)) + 0.8 * Math.log(m(2 * k)) + 0.6 * Math.log(m(3 * k));
      if (score > best) { best = score; bk = k; }
      mean += m(k);
    }
    mean /= k1 - k0 + 1;
    if (m(bk) / mean < 4) return 0;
    const a = m(bk - 1), b = m(bk), c = m(bk + 1), den = a - 2 * b + c;
    const off = den !== 0 ? clamp((0.5 * (a - c)) / den, -0.5, 0.5) : 0;
    return (bk + off) * binHz;
  }

  // Power spectrum -> raw frame (band dB, centroid, pitch). Shared by live + offline paths.
  function spectrumToRaw(powerArr, sampleRate, rmsDb, t) {
    const bins = bandBins(sampleRate);
    const db = new Float32Array(8);
    for (let b = 0; b < 8; b++) {
      const [a, z] = bins[b];
      let sum = 0;
      for (let i = a; i <= z; i++) sum += powerArr[i];
      db[b] = 10 * Math.log10(sum / (z - a + 1) + 1e-14);
    }
    const binHz = sampleRate / FFT_SIZE;
    let num = 0, den = 0;
    for (let i = 1; i < powerArr.length; i++) {
      const m = Math.sqrt(powerArr[i]);
      num += m * i * binHz; den += m;
    }
    return { db, rms: rmsDb, centroid: den > 0 ? num / den : 0, pitch: detectPitch(powerArr, sampleRate), t };
  }

  /* Offline analysis of a whole AudioBuffer into `layers` frames.
   * Each frame averages up to 4 FFT windows across its slice of time. */
  async function analyseBuffer(buffer, layers) {
    const len = buffer.length, sr = buffer.sampleRate;
    const mono = new Float32Array(len);
    for (let c = 0; c < buffer.numberOfChannels; c++) {
      const d = buffer.getChannelData(c);
      for (let i = 0; i < len; i++) mono[i] += d[i] / buffer.numberOfChannels;
    }
    const raw = [];
    const pw = new Float32Array(FFT_SIZE / 2), acc = new Float32Array(FFT_SIZE / 2);
    const slice = len / layers;
    const windows = Math.max(1, Math.min(4, Math.floor(slice / (FFT_SIZE / 2))));
    for (let f = 0; f < layers; f++) {
      acc.fill(0);
      const s0 = Math.floor(f * slice);
      for (let w = 0; w < windows; w++) {
        const start = Math.min(len - FFT_SIZE, Math.floor(s0 + (w + 0.5) * (slice / windows) - FFT_SIZE / 2));
        FFT.power(mono, Math.max(0, start), pw);
        for (let i = 0; i < pw.length; i++) acc[i] += pw[i] / windows;
      }
      let sq = 0, cnt = 0;
      for (let i = s0, e = Math.min(len, Math.floor(s0 + slice)); i < e; i += 4) { sq += mono[i] * mono[i]; cnt++; }
      const rmsDb = 10 * Math.log10(sq / Math.max(1, cnt) + 1e-12);
      raw.push(spectrumToRaw(acc, sr, rmsDb, (f / layers) * buffer.duration));
      if (f % 40 === 39) await new Promise((r) => setTimeout(r)); // keep the UI responsive
    }
    return raw;
  }

  const TILT = BANDS.map(([a, b]) => 3 * Math.log2(Math.sqrt(a * b) / 250)); // pink-noise compensation

  // tone: 0..1 position of the note between 100 Hz and 1400 Hz (about 3.8 octaves).
  // Unpitched sound (drums, noise) falls back to its brightness.
  const toneOf = (pitch, centroidN) => (pitch > 0 ? clamp(Math.log2(pitch / 100) / Math.log2(14)) : clamp(centroidN * 0.8));

  function deriveFrame(r, bands, level) {
    const group = (g) => {
      const vals = [...bands].filter((_, b) => BAND_GROUP[b] === g);
      return 0.5 * (vals.reduce((s, v) => s + v, 0) / vals.length) + 0.5 * Math.max(...vals);
    };
    const centroid = clamp(Math.log2(Math.max(100, r.centroid) / 100) / Math.log2(80));
    return {
      t: r.t, bands, level, centroid,
      bass: group(0), mid: group(1), high: group(2),
      pitch: r.pitch || 0,
      tone: toneOf(r.pitch || 0, centroid),
    };
  }

  /* Raw frames -> normalised 0..1 values, relative to the whole recording,
   * so a quiet phone mic and a mastered track both build something legible.
   * Files are analysed in full before playing, so these values never change. */
  function normalise(raw) {
    if (!raw.length) return [];
    const adj = raw.map((r) => Array.from(r.db, (v, b) => (Number.isFinite(v) ? v + TILT[b] : -140)));
    const gMax = percentile(adj.flat(), 0.985);
    const range = 48;
    const lo = [], hi = [];
    for (let b = 0; b < 8; b++) {
      const col = adj.map((a) => a[b]);
      lo.push(percentile(col, 0.05));
      hi.push(percentile(col, 0.98));
    }
    const rmsArr = raw.map((r) => (Number.isFinite(r.rms) ? r.rms : -120));
    const rmsMax = percentile(rmsArr, 0.98);
    // Stretch this sound's own pitch range over the full height range:
    // its lowest notes build low, its highest notes build the tallest towers.
    const logs = raw.filter((r) => r.pitch > 0).map((r) => Math.log2(r.pitch));
    const pLo = logs.length > 4 ? percentile(logs, 0.03) : Math.log2(100);
    const pHi = logs.length > 4 ? Math.max(percentile(logs, 0.97), pLo + 1) : Math.log2(1400);
    const toneFile = (pitch, centroidN) => (pitch > 0 ? clamp((Math.log2(pitch) - pLo) / (pHi - pLo)) : clamp(centroidN * 0.6));
    return raw.map((r, i) => {
      const bands = new Float32Array(8);
      for (let b = 0; b < 8; b++) {
        const v = adj[i][b];
        const abs = clamp((v - (gMax - range)) / range);
        const rel = clamp((v - lo[b]) / (hi[b] - lo[b] + 6));
        bands[b] = clamp(abs * (0.45 + 0.55 * rel));
      }
      const fr = deriveFrame(r, bands, clamp((rmsArr[i] - (rmsMax - 40)) / 40));
      fr.tone = toneFile(fr.pitch, fr.centroid);
      return fr;
    });
  }

  /* Live (microphone) normaliser: a slowly decaying peak-hold reference.
   * Each frame is normalised once, when it is captured, and then frozen,
   * so buildings already standing never shrink when a louder sound arrives. */
  function makeLiveNormaliser() {
    let gMax = -50, rMax = -32;
    return (r) => {
      const adj = Array.from(r.db, (v, b) => (Number.isFinite(v) ? v + TILT[b] : -140));
      gMax = Math.max(gMax - 0.06, ...adj);
      const rms = Number.isFinite(r.rms) ? r.rms : -120;
      rMax = Math.max(rMax - 0.06, rms, -32);
      const bands = new Float32Array(8);
      for (let b = 0; b < 8; b++) {
        const abs = clamp((adj[b] - (gMax - 48)) / 48);
        bands[b] = Math.pow(abs, 1.3);
      }
      return deriveFrame(r, bands, clamp((rms - (rMax - 40)) / 40));
    };
  }

  /* =========================================================
   * 3. AUDIO: context, microphone, file, demo, playback
   * ========================================================= */

  let audioCtx = null, analyser = null, micStream = null, micSource = null;
  let recorder = null, recChunks = [], liveTimer = null, liveStart = 0;
  let playSource = null;
  const anFloat = new Float32Array(FFT_SIZE / 2);
  const anTime = new Float32Array(FFT_SIZE);
  const anPower = new Float32Array(FFT_SIZE / 2);

  function ensureAudio() {
    if (!audioCtx) {
      const Ctx = window.AudioContext || window.webkitAudioContext;
      if (!Ctx) throw new Error('This browser does not support the Web Audio API.');
      audioCtx = new Ctx();
      analyser = audioCtx.createAnalyser();
      analyser.fftSize = FFT_SIZE;
      analyser.smoothingTimeConstant = 0.55;
    }
    if (audioCtx.state === 'suspended') audioCtx.resume();
    return audioCtx;
  }

  function sampleAnalyser(t) {
    analyser.getFloatFrequencyData(anFloat);
    analyser.getFloatTimeDomainData(anTime);
    for (let i = 0; i < anFloat.length; i++) {
      const v = anFloat[i];
      anPower[i] = Number.isFinite(v) ? Math.pow(10, v / 10) : 0;
    }
    let sq = 0;
    for (let i = 0; i < anTime.length; i++) sq += anTime[i] * anTime[i];
    return spectrumToRaw(anPower, audioCtx.sampleRate, 10 * Math.log10(sq / anTime.length + 1e-12), t);
  }

  /* Microphone picker. Browsers only reveal device names after the first
   * permission grant, so the list is refreshed once recording starts. */
  async function listMics() {
    const sel = ui.micSelect;
    if (!navigator.mediaDevices || !navigator.mediaDevices.enumerateDevices) { sel.disabled = true; return; }
    let devices = [];
    try { devices = (await navigator.mediaDevices.enumerateDevices()).filter((d) => d.kind === 'audioinput'); } catch (_) { /* ignore */ }
    const keep = sel.value;
    sel.textContent = '';
    const def = new Option('Default microphone', '');
    sel.add(def);
    let n = 0;
    devices.forEach((d) => {
      if (d.deviceId === 'default' || d.deviceId === 'communications' || !d.deviceId) return;
      n++;
      sel.add(new Option(d.label || `Microphone ${n}`, d.deviceId));
    });
    if ([...sel.options].some((o) => o.value === keep)) sel.value = keep;
    sel.title = n > 1 ? `${n} microphones found` : n === 1 ? '1 microphone found' : 'Microphone names appear after you allow access';
  }
  if (navigator.mediaDevices && navigator.mediaDevices.addEventListener) {
    navigator.mediaDevices.addEventListener('devicechange', listMics);
  }
  listMics();

  async function startRecording() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
      setStatus('Microphone access needs a secure page (https or localhost). Load an audio file instead.', { error: true });
      return;
    }
    try {
      ensureAudio();
      const deviceId = ui.micSelect.value;
      micStream = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, ...(deviceId ? { deviceId: { exact: deviceId } } : {}) },
      });
    } catch (err) {
      const denied = err && (err.name === 'NotAllowedError' || err.name === 'SecurityError');
      if (err && err.name === 'OverconstrainedError') {
        setStatus('That microphone is no longer available. Pick another one from the list.', { error: true });
        listMics();
        return;
      }
      setStatus(denied
        ? 'Microphone permission was blocked. Allow it in the address bar, or load an audio file instead.'
        : `No microphone found (${err.name || err}). Plug one in, or load an audio file.`, { error: true });
      return;
    }
    stopPlayback();
    listMics(); // names are visible now that access was granted
    const track = micStream.getAudioTracks()[0];
    micSource = audioCtx.createMediaStreamSource(micStream);
    micSource.connect(analyser); // not to destination: avoids feedback

    state.rawFrames = [];
    state.allFrames = [];
    state.frames = [];
    state.expected = 0;
    state.playedUntil = 0;
    state.buffer = null;
    state.recording = true;
    const liveNorm = makeLiveNormaliser();
    state.sourceLabel = 'Microphone recording';
    liveStart = audioCtx.currentTime;
    ui.btnRecord.setAttribute('aria-pressed', 'true');
    ui.btnRecord.querySelector('.btn-label').textContent = 'Stop';
    ui.sourceName.textContent = `Recording from ${track && track.label ? track.label : 'the microphone'}… sing or whistle: higher builds taller.`;
    setStatus('Recording. The structure grows while you listen.');

    recChunks = [];
    if (window.MediaRecorder) {
      try {
        recorder = new MediaRecorder(micStream);
        recorder.ondataavailable = (e) => e.data.size && recChunks.push(e.data);
        recorder.start();
      } catch (_) { recorder = null; }
    }

    liveTimer = setInterval(() => {
      const t = audioCtx.currentTime - liveStart;
      const raw = sampleAnalyser(t);
      state.rawFrames.push(raw);
      state.allFrames.push(liveNorm(raw)); // normalised once, then frozen
      state.frames = state.allFrames.slice();
      state.playedUntil = t;
      rebuild({ live: true });
      if (state.rawFrames.length >= LIVE_MAX_FRAMES) stopRecording('Reached the 50-second limit, recording stopped.');
    }, 1000 / LIVE_FPS);
  }

  async function stopRecording(note) {
    if (!state.recording) return;
    state.recording = false;
    clearInterval(liveTimer);
    ui.btnRecord.setAttribute('aria-pressed', 'false');
    ui.btnRecord.querySelector('.btn-label').textContent = 'Record';
    if (micSource) micSource.disconnect();
    const stream = micStream;
    micStream = null;

    const done = () => {
      if (stream) stream.getTracks().forEach((tr) => tr.stop());
      const last = state.rawFrames[state.rawFrames.length - 1];
      const secs = last ? last.t : 0;
      ui.sourceName.textContent = `Microphone recording, ${secs.toFixed(1)} s, ${state.rawFrames.length} layers`;
      setStatus(note || 'Recording stopped. Play it back, press Back to start to grow it again, or save the result.');
      state.playedUntil = secs + 1;
      state.playOffset = 0;
      rebuild({ fit: true });
      updateButtons();
    };

    if (recorder && recorder.state !== 'inactive') {
      recorder.onstop = async () => {
        try {
          const blob = new Blob(recChunks, { type: recorder.mimeType });
          const arr = await blob.arrayBuffer();
          state.buffer = await audioCtx.decodeAudioData(arr);
        } catch (_) { state.buffer = null; }
        done();
      };
      recorder.stop();
    } else {
      done();
    }
  }

  async function loadFile(file) {
    if (!file) return;
    if (file.type && !file.type.startsWith('audio') && !file.type.startsWith('video')) {
      setStatus(`"${file.name}" is not an audio file. Try MP3, WAV, M4A or OGG.`, { error: true });
      return;
    }
    if (state.recording) await stopRecording();
    stopPlayback();
    setStatus(`Reading "${file.name}"…`, { sticky: true });
    try {
      ensureAudio();
      const arr = await file.arrayBuffer();
      const buffer = await audioCtx.decodeAudioData(arr);
      await useBuffer(buffer, file.name);
    } catch (err) {
      setStatus(`Could not decode "${file.name}". Try MP3, WAV, M4A or OGG.`, { error: true });
    }
  }

  async function useBuffer(buffer, label) {
    // About 12 analysis frames per second: fine enough to separate syllables.
    const auto = clamp(Math.round((buffer.duration * 12) / 10) * 10, 60, 1500);
    const [slider, out] = ui.sliders.layers;
    slider.value = String(auto);
    out.textContent = String(auto);
    state.params.layers = auto;
    state.buffer = buffer;
    state.sourceLabel = label;
    state.playOffset = 0;
    state.playedUntil = -1;
    ui.sourceName.textContent = `${label}, ${fmtTime(buffer.duration)}`;
    resetCamera();
    await reanalyse();
    setStatus('');
  }

  async function reanalyse() {
    if (!state.buffer) return;
    setStatus('Analysing frequencies…', { sticky: true });
    state.rawFrames = await analyseBuffer(state.buffer, state.params.layers);
    state.allFrames = normalise(state.rawFrames);
    state.expected = state.allFrames.length;
    state.frames = state.allFrames.slice(0, revealedCount());
    rebuild({ fit: state.frames.length > 0 });
    updateButtons();
    setStatus('');
  }

  /* Demo sound: a 16-second piece synthesised with an OfflineAudioContext.
   * A sawtooth melody rides over bass, pads, kick and hats; it climbs to a
   * long high note near the end, which becomes the tallest building. */
  async function makeDemo() {
    const sr = 44100, dur = 16;
    const Off = window.OfflineAudioContext || window.webkitOfflineAudioContext;
    const ctx = new Off(1, sr * dur, sr);
    const master = ctx.createGain();
    master.gain.value = 0.8;
    master.connect(ctx.destination);
    const beat = 60 / 112;

    // Sub drone + bassline
    const bassNotes = [41.2, 41.2, 49.0, 36.7]; // E1 E1 G1 D1
    const bLp = ctx.createBiquadFilter();
    bLp.type = 'lowpass'; bLp.frequency.value = 220;
    bLp.connect(master);
    for (let bar = 0; bar < dur / (beat * 4); bar++) {
      const t0 = bar * beat * 4;
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sawtooth';
      o.frequency.value = bassNotes[bar % 4];
      g.gain.setValueAtTime(0.0001, t0);
      g.gain.exponentialRampToValueAtTime(0.32, t0 + 0.08);
      g.gain.exponentialRampToValueAtTime(0.16, t0 + beat * 4 - 0.05);
      g.gain.linearRampToValueAtTime(0.0001, t0 + beat * 4);
      o.connect(g).connect(bLp);
      o.start(t0); o.stop(t0 + beat * 4);
    }

    // Kick from 4 s
    for (let t = 4; t < dur - 0.3; t += beat) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.frequency.setValueAtTime(130, t);
      o.frequency.exponentialRampToValueAtTime(42, t + 0.18);
      g.gain.setValueAtTime(0.9, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.35);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.4);
    }

    // Pad chords (mids), swelling in from 2 s
    const chords = [[164.8, 196, 246.9], [196, 246.9, 293.7], [146.8, 185, 220], [164.8, 207.7, 246.9]];
    for (let bar = 0; bar * beat * 4 < dur; bar++) {
      const t0 = bar * beat * 4;
      if (t0 < 2) continue;
      chords[bar % 4].forEach((f) => {
        [f, f * 2].forEach((ff, k) => {
          const o = ctx.createOscillator(), g = ctx.createGain();
          o.type = 'triangle'; o.frequency.value = ff;
          const peak = (k ? 0.02 : 0.035) * (t0 > 12 ? 1.3 : 1);
          g.gain.setValueAtTime(0.0001, t0);
          g.gain.linearRampToValueAtTime(peak, t0 + 0.6);
          g.gain.linearRampToValueAtTime(0.0001, t0 + beat * 4);
          o.connect(g).connect(master);
          o.start(t0); o.stop(t0 + beat * 4 + 0.05);
        });
      });
    }

    // Hi-hats (noise) from 8 s, denser from 12 s
    const noise = ctx.createBuffer(1, sr, sr);
    const nd = noise.getChannelData(0);
    for (let i = 0; i < nd.length; i++) nd[i] = Math.random() * 2 - 1;
    const hp = ctx.createBiquadFilter();
    hp.type = 'highpass'; hp.frequency.value = 7000;
    hp.connect(master);
    for (let t = 8; t < dur - 0.2; t += beat / (t >= 12 ? 4 : 2)) {
      const s = ctx.createBufferSource(), g = ctx.createGain();
      s.buffer = noise;
      g.gain.setValueAtTime(0.35, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.06);
      s.connect(g).connect(hp);
      s.start(t, Math.random() * 0.5, 0.08);
    }

    // Bell arpeggio (highs), 10-15 s
    const arp = [1318.5, 1568, 1975.5, 2637, 1975.5, 1568];
    let k = 0;
    for (let t = 10; t < 15; t += beat / 2, k++) {
      const o = ctx.createOscillator(), g = ctx.createGain();
      o.type = 'sine'; o.frequency.value = arp[k % arp.length];
      g.gain.setValueAtTime(0.12, t);
      g.gain.exponentialRampToValueAtTime(0.001, t + 0.4);
      o.connect(g).connect(master);
      o.start(t); o.stop(t + 0.45);
    }

    // Lead melody: climbs, falls, then soars to a long high note (the tallest tower).
    const melody = [[64, 1], [67, 1], [69, 1], [71, 1], [74, 2], [76, 2], [74, 1], [71, 1], [69, 2], [67, 1], [64, 1],
      [0, 1], [76, 1], [79, 1], [81, 2], [83, 1], [86, 3], [88, 4], [0, 1]];
    const leadLp = ctx.createBiquadFilter();
    leadLp.type = 'lowpass'; leadLp.frequency.value = 2600;
    leadLp.connect(master);
    let tm = 0.5;
    for (const [midi, beats] of melody) {
      const len = beats * beat;
      if (midi) {
        const o = ctx.createOscillator(), g = ctx.createGain();
        o.type = 'sawtooth';
        o.frequency.value = 440 * Math.pow(2, (midi - 69) / 12);
        g.gain.setValueAtTime(0.0001, tm);
        g.gain.linearRampToValueAtTime(0.16, tm + 0.03);
        g.gain.setValueAtTime(0.13, tm + len - 0.08);
        g.gain.linearRampToValueAtTime(0.0001, tm + len - 0.01);
        o.connect(g).connect(leadLp);
        o.start(tm); o.stop(tm + len);
      }
      tm += len;
    }

    master.gain.setValueAtTime(0.8, dur - 1.2);
    master.gain.linearRampToValueAtTime(0.0001, dur);
    return ctx.startRendering();
  }

  // How many frames the listener has heard so far.
  function revealedCount() {
    const f = state.allFrames, t = state.playedUntil;
    if (t < 0) return 0;
    let lo = 0, hi = f.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (f[mid].t <= t) lo = mid + 1; else hi = mid; }
    return lo;
  }

  let lastGrowBuild = 0, growPending = false;
  // Called every animation frame while playing: build whatever has just been heard.
  function revealUpTo(t) {
    if (t <= state.playedUntil) return;
    state.playedUntil = t;
    const count = revealedCount();
    if (count !== state.frames.length) {
      const first = state.frames.length === 0;
      state.frames = state.allFrames.slice(0, count);
      const now = performance.now();
      if (first || now - lastGrowBuild > 90 || count === state.allFrames.length) {
        lastGrowBuild = now;
        rebuild({ live: true, fit: first });
      } else growPending = true;
    }
  }

  function currentPlayTime() {
    if (!state.buffer) return 0;
    if (!state.playing) return state.playOffset;
    return clamp((audioCtx.currentTime - state.playStart) * state.rate + state.playOffset, 0, state.buffer.duration);
  }

  // 1x -> 2x -> 4x -> 1x. Changing speed mid-play keeps the position.
  function cycleSpeed() {
    const next = state.rate === 1 ? 2 : state.rate === 2 ? 4 : 1;
    if (state.playing) {
      state.playOffset = currentPlayTime();
      state.playStart = audioCtx.currentTime;
      if (playSource) playSource.playbackRate.setValueAtTime(next, audioCtx.currentTime);
    }
    state.rate = next;
    ui.btnSpeed.textContent = `${next}×`;
    ui.btnSpeed.setAttribute('aria-label', `Playback speed ${next} times. Click to change.`);
    ui.btnSpeed.classList.toggle('is-fast', next > 1);
  }

  function startPlayback(offset = state.playOffset) {
    if (!state.buffer || state.recording) return;
    ensureAudio();
    stopSource();
    if (offset >= state.buffer.duration - 0.05) offset = 0;
    playSource = audioCtx.createBufferSource();
    playSource.buffer = state.buffer;
    playSource.playbackRate.value = state.rate;
    playSource.connect(analyser);
    analyser.connect(audioCtx.destination);
    playSource.onended = () => {
      if (!state.playing) return;
      state.playing = false;
      revealUpTo(state.buffer.duration + 1); // the whole sound has been heard
      state.playOffset = 0;
      ui.btnPlay.classList.remove('is-playing');
      ui.btnPlay.setAttribute('aria-label', 'Play');
    };
    state.playStart = audioCtx.currentTime;
    state.playOffset = offset;
    state.playing = true;
    playSource.start(0, offset);
    ui.btnPlay.classList.add('is-playing');
    ui.btnPlay.setAttribute('aria-label', 'Pause');
  }

  function stopSource() {
    if (playSource) {
      playSource.onended = null;
      try { playSource.stop(); } catch (_) { /* already stopped */ }
      playSource.disconnect();
      playSource = null;
    }
    if (analyser && audioCtx) { try { analyser.disconnect(audioCtx.destination); } catch (_) { /* not connected */ } }
  }

  function stopPlayback() {
    if (state.playing) state.playOffset = currentPlayTime();
    state.playing = false;
    stopSource();
    ui.btnPlay.classList.remove('is-playing');
    ui.btnPlay.setAttribute('aria-label', 'Play');
  }

  function seekTo(seconds) {
    const wasPlaying = state.playing;
    stopPlayback();
    state.playOffset = clamp(seconds, 0, state.buffer ? state.buffer.duration : 0);
    if (wasPlaying) startPlayback(state.playOffset);
  }

  /* =========================================================
   * 4. SCENE
   * ========================================================= */

  // Palettes. Building materials (render, brick, concrete, stone, glass, roof) plus
  // the site (road, plaza, lawn, tree, water). bass/mid/high colour the 2D meters.
  const PALETTES = {
    flyer: {
      skyTop: '#0F2FB8', skyBottom: '#4A7DFF', fog: '#3A68F0',
      road: '#2353E6', road2: '#121212', plaza: '#FFFFFF', plaza2: '#F4F1EA', gridLine: '#E4E0D8',
      lawn: '#2DB84B', lawn2: '#23A23F', tree: '#2DB84B', tree2: '#7ED957', water: '#0E2A9E',
      render: '#FFFFFF', render2: '#F3F0E8', brick: '#F2481B', brick2: '#DB3B12', concrete: '#1C1C1C', concrete2: '#333333',
      stone: '#FFE422', stone2: '#F7D20C', glass: '#CFE0FF', glass2: '#E8F0FF', house: '#FFFFFF', house2: '#FFF1B8',
      roof: '#F2481B', roof2: '#141414', lamp: '#141414', lamp2: '#2A2A2A',
      cars: ['#F2481B', '#FFFFFF', '#141414', '#FFE422', '#2DB84B'],
      win: '#2447B8', lit: '#FFE07A', night: 0,
      bass: '#111111', mid: '#FFFFFF', mid2: '#F2481B', high: '#1F4FE0',
      accent: '#22C34A', exposure: 1.0, env: 0.45, sun: 2.7, hemi: 1.05,
    },
    get pitch() { return { ...PALETTES.flyer, pitch: true, accent: '#111111' }; },
    daylight: {
      skyTop: '#8FB4D8', skyBottom: '#E8EFF5', fog: '#D9E3EC',
      road: '#4A4E54', road2: '#3C4046', plaza: '#CBC7BE', plaza2: '#B9B4AA', gridLine: '#B5B0A6',
      lawn: '#6F9A4C', lawn2: '#5E8A40', tree: '#4C7A34', tree2: '#7AA449', water: '#3D6580',
      render: '#E9E2D4', render2: '#D6CBB6', brick: '#A75B43', brick2: '#8A4835', concrete: '#B9B5AD', concrete2: '#9E9A92',
      stone: '#D2C9B6', stone2: '#BCB19B', glass: '#6F8FA7', glass2: '#90AFC3', house: '#EEE7D7', house2: '#D9C9AD',
      roof: '#8E4B39', roof2: '#5D6067', lamp: '#2C2F35', lamp2: '#44474E',
      cars: ['#C8372D', '#2F5F9E', '#E9E9E6', '#2A2B2E', '#B8BCC2', '#D9A62B'],
      win: '#43596B', lit: '#FFD79A', night: 0,
      bass: '#3B4150', mid: '#E9E2D4', mid2: '#BCB19B', high: '#6F8FA7',
      accent: '#2A3BD6', exposure: 1.0, env: 0.6, sun: 2.7, hemi: 0.8,
    },
    maquette: {
      skyTop: '#B9C1CC', skyBottom: '#EEF0F3', fog: '#DCE0E6',
      road: '#4B5161', road2: '#5B6272', plaza: '#E9E8E4', plaza2: '#DAD8D2', gridLine: '#D2D0CA',
      lawn: '#C6CDB2', lawn2: '#B2BC9A', tree: '#DCE2CB', tree2: '#BCC8A0', water: '#AEBBC9',
      render: '#F4F3EF', render2: '#E6E4DE', brick: '#ECE9E2', brick2: '#DFDBD2', concrete: '#EFEDE8', concrete2: '#DEDCD6',
      stone: '#F1EFEA', stone2: '#E3E0D9', glass: '#C9D2DA', glass2: '#DCE3E8', house: '#F6F5F1', house2: '#E8E6E0',
      roof: '#DAD7CF', roof2: '#C9C6BE', lamp: '#3A3F4B', lamp2: '#555B68',
      cars: ['#F4F3EF', '#E3E1DC', '#CFCDC7'],
      win: '#717A89', lit: '#FFE2A8', night: 0,
      bass: '#3B4150', mid: '#F4F3EF', mid2: '#D9D6CE', high: '#8E96A6',
      accent: '#2A3BD6', exposure: 1.0, env: 0.55, sun: 2.4, hemi: 0.9,
    },
    night: {
      skyTop: '#04060E', skyBottom: '#1A2546', fog: '#121A33',
      road: '#0E1322', road2: '#262D40', plaza: '#3E4660', plaza2: '#2F3650', gridLine: '#4A5370',
      lawn: '#1C3524', lawn2: '#24432D', tree: '#2A5A35', tree2: '#3C7444', water: '#0C1C36',
      render: '#4A5064', render2: '#3E4458', brick: '#55403F', brick2: '#463534', concrete: '#43485A', concrete2: '#373C4C',
      stone: '#4C4E5C', stone2: '#40424F', glass: '#2A3B58', glass2: '#344A6C', house: '#4E5468', house2: '#43485C',
      roof: '#2E313C', roof2: '#262833', lamp: '#2B2E38', lamp2: '#3A3E4A',
      cars: ['#8A2A22', '#26406A', '#6A6E78', '#2A2D33'],
      win: '#121925', lit: '#FFC56E', night: 1, lane: '#FFE3A0', bulb: '#FFF1C8', glow: '#FFA845',
      bass: '#33406B', mid: '#A9BBDF', mid2: '#D7E1F4', high: '#FFB547',
      accent: '#FF6A3D', exposure: 1.35, env: 0.3, sun: 0.9, hemi: 0.6,
    },
  };

  const renderer = new T.WebGLRenderer({ antialias: true, preserveDrawingBuffer: false });
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 1.5)); // light on purpose
  renderer.outputColorSpace = T.SRGBColorSpace;
  renderer.toneMapping = T.ACESFilmicToneMapping;
  renderer.shadowMap.enabled = true;
  renderer.shadowMap.type = T.PCFShadowMap;
  renderer.domElement.setAttribute('role', 'img');
  renderer.domElement.setAttribute('aria-label', 'Empty building site. Add sound to start building.');
  ui.viewport.prepend(renderer.domElement);

  const scene = new T.Scene();
  const camera = new T.PerspectiveCamera(40, 1, 0.1, 600);
  camera.position.set(18, 14, 22);

  const controls = new T.OrbitControls(camera, renderer.domElement);
  controls.enableDamping = true;
  controls.dampingFactor = 0.08;
  controls.maxPolarAngle = Math.PI * 0.495;
  controls.minDistance = 2;
  controls.maxDistance = 200;
  controls.autoRotateSpeed = 0.6;
  controls.zoomToCursor = true;        // scroll zooms toward what is under the mouse
  controls.screenSpacePanning = false; // right-drag slides across the ground, like a map
  controls.panSpeed = 1.2;
  controls.listenToKeyEvents(window);  // arrow keys move the view too
  controls.keyPanSpeed = 20;
  controls.target.set(0, 4, 0);

  const pmrem = new T.PMREMGenerator(renderer);
  scene.environment = pmrem.fromScene(new T.RoomEnvironment(), 0.04).texture;

  const hemi = new T.HemisphereLight(0xffffff, 0x8890a0, 0.9);
  scene.add(hemi);
  const sun = new T.DirectionalLight(0xffffff, 2.4);
  sun.position.set(14, 26, 10);
  sun.castShadow = true;
  sun.shadow.mapSize.set(1024, 1024);
  sun.shadow.bias = -0.0004;
  sun.shadow.normalBias = 0.03;
  scene.add(sun, sun.target);

  const ground = new T.Mesh(new T.CircleGeometry(800, 64), new T.MeshStandardMaterial({ roughness: 0.95 }));
  ground.rotation.x = -Math.PI / 2;
  ground.receiveShadow = true;
  scene.add(ground);

  /* ---------- Instanced primitives: one draw call per kind ---------- */

  const FH = 0.3;          // one storey
  const MAX_ROOFS = 12000;

  // Boxes carry a per-instance facade description (storeys, bays across x,
  // bays across z, style + seed) that a small shader patch turns into windows.
  const boxGeo = new T.BoxGeometry(1, 1, 1);
  boxGeo.setAttribute('aUvF', boxGeo.attributes.uv.clone());
  const facadeAttr = new T.InstancedBufferAttribute(new Float32Array(MAX_BOXES * 4), 4);
  facadeAttr.setUsage(T.DynamicDrawUsage);
  boxGeo.setAttribute('aFacade', facadeAttr);

  // Gable roof: a triangular prism, ridge along local z, base at y = 0.
  const roofGeo = new T.ExtrudeGeometry(
    new T.Shape([new T.Vector2(-0.5, 0), new T.Vector2(0.5, 0), new T.Vector2(0, 1)]),
    { depth: 1, bevelEnabled: false }
  ).translate(0, 0, -0.5);

  const boxMat = new T.MeshStandardMaterial({ roughness: 0.82, metalness: 0.0 });
  const roofMat = new T.MeshStandardMaterial({ roughness: 0.75 });

  const facadeUniforms = { uWin: { value: new T.Color() }, uLit: { value: new T.Color() }, uNight: { value: 0 } };
  boxMat.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, facadeUniforms);
    shader.vertexShader = shader.vertexShader
      .replace('#include <common>', `#include <common>
attribute vec4 aFacade;
attribute vec2 aUvF;
varying vec4 vFacade;
varying vec2 vUvF;
varying vec3 vObjN;`)
      .replace('#include <beginnormal_vertex>', `#include <beginnormal_vertex>
vFacade = aFacade; vUvF = aUvF; vObjN = objectNormal;`);
    shader.fragmentShader = shader.fragmentShader
      .replace('#include <common>', `#include <common>
uniform vec3 uWin; uniform vec3 uLit; uniform float uNight;
varying vec4 vFacade; varying vec2 vUvF; varying vec3 vObjN;
float fHash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }`)
      .replace('#include <color_fragment>', `#include <color_fragment>
float wMask = 0.0, wLit = 0.0, wY = 0.0;
float fStyle = floor(vFacade.w + 0.001);
if (fStyle > 0.5 && abs(vObjN.y) < 0.5) {
  float bays = abs(vObjN.x) > 0.5 ? vFacade.z : vFacade.y;
  vec2 g = vUvF * vec2(max(bays, 1.0), max(vFacade.x, 1.0));
  vec2 id = floor(g), f = fract(g);
  wY = f.y;
  if (fStyle < 1.5) {        // punched windows (housing)
    wMask = step(0.26, f.x) * step(f.x, 0.74) * step(0.34, f.y) * step(f.y, 0.8);
  } else if (fStyle < 2.5) { // ribbon windows (offices)
    wMask = step(0.3, f.y) * step(f.y, 0.88) * step(0.05, f.x);
  } else if (fStyle < 3.5) { // curtain wall (glass towers)
    wMask = (1.0 - step(0.95, f.x)) * (1.0 - step(0.92, f.y));
  } else {                   // small house windows
    wMask = step(0.3, f.x) * step(f.x, 0.7) * step(0.32, f.y) * step(f.y, 0.74);
  }
  wLit = step(0.55, fHash(id + fract(vFacade.w) * 97.0 + vObjN.xz * 13.0));
  vec3 pane = uWin * (0.85 + 0.8 * f.y);
  pane = mix(pane, diffuseColor.rgb, (fStyle > 2.5 && fStyle < 3.5) ? 0.4 : 0.12);
  diffuseColor.rgb = mix(diffuseColor.rgb, pane, wMask);
}`)
      .replace('#include <roughnessmap_fragment>', `#include <roughnessmap_fragment>
roughnessFactor = mix(roughnessFactor, 0.12, wMask);`)
      .replace('#include <metalnessmap_fragment>', `#include <metalnessmap_fragment>
metalnessFactor = mix(metalnessFactor, 0.55, wMask * (1.0 - uNight));`)
      .replace('#include <emissivemap_fragment>', `#include <emissivemap_fragment>
totalEmissiveRadiance += uLit * wMask * wLit * uNight * (0.55 + 0.6 * wY);`);
  };

  const boxes = new T.InstancedMesh(boxGeo, boxMat, MAX_BOXES);
  const roofs = new T.InstancedMesh(roofGeo, roofMat, MAX_ROOFS);
  const icos = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0), // low-poly trees
    new T.MeshStandardMaterial({ roughness: 1, flatShading: true }), 8000);
  const cyls = new T.InstancedMesh(new T.CylinderGeometry(1, 1, 1, 6).translate(0, 0.5, 0),
    new T.MeshStandardMaterial({ roughness: 0.6 }), 12000);
  // Night lighting: unlit lamp bulbs and soft additive pools of light on the street.
  const bulbs = new T.InstancedMesh(new T.IcosahedronGeometry(1, 0),
    new T.MeshBasicMaterial({ color: 0xffffff, toneMapped: false }), 3000);
  const pools = new T.InstancedMesh(new T.CircleGeometry(1, 20).rotateX(-Math.PI / 2),
    new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.75, blending: T.AdditiveBlending, depthWrite: false, toneMapped: false, map: (() => { const c = document.createElement('canvas'); c.width = c.height = 64; const g = c.getContext('2d'); const gr = g.createRadialGradient(32, 32, 0, 32, 32, 32); gr.addColorStop(0, 'rgba(255,255,255,1)'); gr.addColorStop(0.5, 'rgba(255,255,255,0.45)'); gr.addColorStop(1, 'rgba(255,255,255,0)'); g.fillStyle = gr; g.fillRect(0, 0, 64, 64); return new T.CanvasTexture(c); })() }), 3000);
  boxes.name = 'buildings'; roofs.name = 'roofs'; icos.name = 'trees'; cyls.name = 'lamps_trunks_tanks';
  bulbs.name = 'bulbs'; pools.name = 'light_pools';
  const INSTANCED = [boxes, roofs, icos, cyls, bulbs, pools];
  for (const m of INSTANCED) {
    m.instanceMatrix.setUsage(T.DynamicDrawUsage);
    m.setColorAt(0, new T.Color());
    m.instanceColor.setUsage(T.DynamicDrawUsage);
    m.castShadow = true;
    m.receiveShadow = true;
    m.count = 0;
    m.frustumCulled = false;
    m.userData.base = new Float32Array(m.instanceMatrix.count * 3); // un-highlighted colours
    scene.add(m);
  }
  bulbs.castShadow = pools.castShadow = pools.receiveShadow = false;
  pools.renderOrder = 2;

  // Moon, halo and stars for the night palette.
  const MOON_DIR = new T.Vector3(-0.55, 0.6, -0.58).normalize();
  const SUN_DIR = new T.Vector3(0.45, 0.8, 0.35).normalize();
  const moon = new T.Mesh(new T.SphereGeometry(9, 24, 16), new T.MeshBasicMaterial({ color: 0xFFF4D6, fog: false, toneMapped: false }));
  const haloCanvas = document.createElement('canvas');
  haloCanvas.width = haloCanvas.height = 128;
  {
    const hc = haloCanvas.getContext('2d');
    const gr = hc.createRadialGradient(64, 64, 8, 64, 64, 64);
    gr.addColorStop(0, 'rgba(255,240,200,0.55)'); gr.addColorStop(0.35, 'rgba(180,200,255,0.18)'); gr.addColorStop(1, 'rgba(120,150,255,0)');
    hc.fillStyle = gr; hc.fillRect(0, 0, 128, 128);
  }
  const halo = new T.Sprite(new T.SpriteMaterial({ map: new T.CanvasTexture(haloCanvas), blending: T.AdditiveBlending, depthWrite: false, fog: false, transparent: true }));
  halo.scale.set(80, 80, 1);
  moon.add(halo);
  const stars = (() => {
    const pos = new Float32Array(900 * 3), rnd = mulberry32(2024);
    for (let i = 0; i < 900; i++) {
      const a = rnd() * Math.PI * 2, el = 0.08 + rnd() * 1.4, r = 420;
      pos[i * 3] = Math.cos(a) * Math.cos(el) * r; pos[i * 3 + 1] = Math.sin(el) * r; pos[i * 3 + 2] = Math.sin(a) * Math.cos(el) * r;
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(pos, 3));
    return new T.Points(g, new T.PointsMaterial({ color: 0xffffff, size: 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.85 }));
  })();
  scene.add(moon, stars);

  // Site surfaces (plazas, lawns, roads, water): ordinary meshes rebuilt on every change.
  const landscape = new T.Group();
  landscape.name = 'landscape';
  scene.add(landscape);
  const gridCanvas = document.createElement('canvas');
  gridCanvas.width = gridCanvas.height = 128;
  const gridTex = new T.CanvasTexture(gridCanvas);
  gridTex.wrapS = gridTex.wrapT = T.RepeatWrapping;
  gridTex.colorSpace = T.SRGBColorSpace;
  gridTex.anisotropy = 4;
  gridTex.repeat.set(1 / 0.8, 1 / 0.8); // paving slabs
  const LMAT = {
    plaza: new T.MeshStandardMaterial({ roughness: 0.9, map: gridTex }),
    curb: new T.MeshStandardMaterial({ roughness: 0.8 }),
    floor: new T.MeshStandardMaterial({ roughness: 0.9 }),
    lawn: new T.MeshStandardMaterial({ roughness: 1 }),
    road: new T.MeshStandardMaterial({ roughness: 0.95 }),
    lane: new T.MeshStandardMaterial({ roughness: 0.8 }),
    water: new T.MeshStandardMaterial({ roughness: 0.08, metalness: 0.35 }),
  };

  // Playhead: a thin ring that travels to the layer currently sounding.
  const ring = new T.Mesh(
    new T.TorusGeometry(1, 0.035, 8, 64),
    new T.MeshBasicMaterial({ color: 0x2A3BD6, transparent: true, opacity: 0.9, depthWrite: false, depthTest: false })
  );
  ring.rotation.x = Math.PI / 2;
  ring.visible = false;
  ring.renderOrder = 5;
  scene.add(ring);

  function applyPalette() {
    const p = PALETTES[state.palette];
    const bg = document.createElement('canvas');
    bg.width = 2; bg.height = 256;
    const g = bg.getContext('2d');
    const grad = g.createLinearGradient(0, 0, 0, 256);
    grad.addColorStop(0, p.skyTop); grad.addColorStop(1, p.skyBottom);
    g.fillStyle = grad; g.fillRect(0, 0, 2, 256);
    const tex = new T.CanvasTexture(bg);
    tex.colorSpace = T.SRGBColorSpace;
    if (scene.background && scene.background.dispose) scene.background.dispose();
    scene.background = tex;
    scene.fog = new T.Fog(p.fog, 60, 220);
    ground.material.color.set(p.road);
    renderer.toneMappingExposure = p.exposure;
    scene.environmentIntensity = p.env;
    sun.intensity = p.sun;
    hemi.intensity = p.hemi;
    ring.material.color.set(p.accent);
    facadeUniforms.uWin.value.set(p.win);
    facadeUniforms.uLit.value.set(p.lit).multiplyScalar(2.2);
    facadeUniforms.uNight.value = p.night;
    // Paving slabs
    const gc = gridCanvas.getContext('2d');
    gc.fillStyle = p.plaza; gc.fillRect(0, 0, 128, 128);
    gc.strokeStyle = p.gridLine; gc.lineWidth = 3;
    gc.strokeRect(0, 0, 128, 128);
    gridTex.needsUpdate = true;
    LMAT.curb.color.set(p.plaza2);
    LMAT.floor.color.set(p.plaza2);
    LMAT.lawn.color.set(p.lawn);
    LMAT.road.color.set(p.road2);
    LMAT.lane.color.set(p.lane || p.plaza);
    LMAT.lane.emissive.set(p.night ? '#8A6A20' : '#000000');
    // Night: moon, stars, glowing lamps and pools of light; moonlight is cool and soft
    const night = !!p.night;
    moon.visible = stars.visible = bulbs.visible = pools.visible = night;
    sun.color.set(night ? '#A9BDFF' : '#FFFFFF');
    hemi.color.set(night ? '#7186C8' : '#FFFFFF');
    hemi.groundColor.set(night ? '#1A1F30' : '#8890A0');
    if (ui.pitchLegend) ui.pitchLegend.hidden = !p.pitch;
    LMAT.water.color.set(p.water);
    // Night: street lamps and car lights glow
    cyls.material.emissive.set(p.night ? '#FFB860' : '#000000');
    cyls.material.emissiveIntensity = 0;
    ui.viewport.classList.toggle('night', !!p.night);
    drawTimeline();
  }

  function resize() {
    const r = ui.viewport.getBoundingClientRect();
    const w = Math.max(1, r.width), h = Math.max(1, r.height);
    renderer.setSize(w, h, false);
    camera.aspect = w / h;
    camera.updateProjectionMatrix();
    for (const c of [ui.spectrum, ui.timeline]) {
      const cr = c.getBoundingClientRect();
      const dpr = Math.min(window.devicePixelRatio || 1, 2);
      c.width = Math.max(1, Math.round(cr.width * dpr));
      c.height = Math.max(1, Math.round(cr.height * dpr));
    }
    drawTimeline();
  }
  new ResizeObserver(resize).observe(ui.viewport);
  window.addEventListener('resize', resize);

  /* =========================================================
   * 5. PROCEDURAL BUILDERS
   * Builders call kit.box / kit.roof / kit.cyl / kit.ico / kit.mesh
   * and mark(frame, position, radius, instanceRange) for the playhead.
   * ========================================================= */

  const _m = new T.Matrix4(), _q = new T.Quaternion(), _e = new T.Euler();
  const _p = new T.Vector3(), _s = new T.Vector3(), _c = new T.Color(), _c2 = new T.Color();

  function makeKit() {
    const pal = PALETTES[state.palette];
    const col = {};
    for (const [k, v] of Object.entries(pal)) if (typeof v === 'string' && v[0] === '#') col[k] = new T.Color(v);
    let nb = 0, nr = 0, ni = 0, ny = 0, nl = 0, np = 0;
    const kit = {
      pal,
      // role: a palette key ('render', 'glass', 'lawn'…) or a '#hex' colour; shade mixes toward role+'2'
      color(role, shade = 0) {
        if (role[0] === '#') return _c.set(role);
        const a = col[role] || col.concrete, b = col[role + '2'] || a;
        return _c.copy(a).lerp(b, clamp(shade));
      },
      // fac: [storeys, baysX, baysZ, style+seed]; omitted = plain surface
      box(x, y, z, sx, sy, sz, rotY, role, shade = 0, fac) {
        if (nb >= MAX_BOXES || sx <= 0 || sy <= 0 || sz <= 0) return;
        _e.set(0, rotY || 0, 0);
        _q.setFromEuler(_e);
        _m.compose(_p.set(x, y, z), _q, _s.set(sx, sy, sz));
        boxes.setMatrixAt(nb, _m);
        boxes.setColorAt(nb, kit.color(role, shade));
        facadeAttr.array.set(fac || [0, 0, 0, 0], nb * 4);
        nb++;
      },
      // Gable roof: span across, height, length along the ridge
      roof(x, y, z, span, h, len, rotY, role = 'roof', shade = 0) {
        if (nr >= MAX_ROOFS) return;
        _e.set(0, rotY || 0, 0);
        _q.setFromEuler(_e);
        _m.compose(_p.set(x, y, z), _q, _s.set(span, h, len));
        roofs.setMatrixAt(nr, _m);
        roofs.setColorAt(nr, kit.color(role, shade));
        nr++;
      },
      ico(x, y, z, r, role = 'tree', shade = 0, sy = 0.9) {
        if (ni >= icos.instanceMatrix.count) return;
        _e.set(x * 3.1, z * 2.3, 0); _q.setFromEuler(_e);
        _m.compose(_p.set(x, y, z), _q, _s.set(r, r * sy, r));
        icos.setMatrixAt(ni, _m);
        icos.setColorAt(ni, kit.color(role, shade));
        ni++;
      },
      cyl(x, y, z, r, h, role = 'lamp', shade = 0) {
        if (ny >= cyls.instanceMatrix.count) return;
        _q.identity();
        _m.compose(_p.set(x, y, z), _q, _s.set(r, h, r));
        cyls.setMatrixAt(ny, _m);
        cyls.setColorAt(ny, kit.color(role, shade));
        ny++;
      },
      mesh(geometry, material, { shadow = false, bounds = true } = {}) {
        const m = new T.Mesh(geometry, material);
        m.castShadow = shadow;
        m.receiveShadow = true;
        m.userData.noBounds = !bounds;
        landscape.add(m);
        return m;
      },
      bulb(x, y, z, r) {
        if (nl >= bulbs.instanceMatrix.count) return;
        _q.identity(); _m.compose(_p.set(x, y, z), _q, _s.set(r, r, r));
        bulbs.setMatrixAt(nl, _m); bulbs.setColorAt(nl, _c.set(pal.bulb || '#FFE2A0')); nl++;
      },
      pool(x, y, z, r) {
        if (np >= pools.instanceMatrix.count) return;
        _q.identity(); _m.compose(_p.set(x, y, z), _q, _s.set(r, 1, r));
        pools.setMatrixAt(np, _m); pools.setColorAt(np, _c.set(pal.glow || '#FFB860')); np++;
      },
      counts: () => [nb, nr],
      allCounts: () => [nb, nr, ni, ny, nl, np],
    };
    return kit;
  }

  /* ---------- Shared architecture vocabulary ---------- */

  const facade = (storeys, w, d, style, seed) =>
    [storeys, Math.max(1, Math.round(w / 0.3)), Math.max(1, Math.round(d / 0.3)), style + clamp(seed, 0, 0.98)];

  /* Group consecutive frames into storeys / modules / buildings of a FIXED size,
   * so a group that is complete never changes as more sound arrives. The pitch
   * (tone) of a group is its highest note: a high note keeps its height. */
  function groupBy(frames, per) {
    const out = [];
    for (let a = 0; a < frames.length; a += per) {
      const fr = frames.slice(a, a + per), g = { a, b: a + fr.length };
      for (const k of ['bass', 'mid', 'high', 'level', 'centroid']) g[k] = fr.reduce((t, f) => t + f[k], 0) / fr.length;
      g.tone = Math.max(...fr.map((f) => f.tone));
      out.push(g);
    }
    return out;
  }
  // Frames per group: from the file's full length, or a fixed rate while recording live.
  const perFor = (count, live) => (state.expected ? Math.max(1, Math.ceil(state.expected / count)) : live);

  /* What a moment of sound becomes:
   *   loudness + bass weight -> number of storeys (louder / heavier = taller)
   *   brightness (highs + centroid) -> glass towers instead of masonry offices */
  function chooseBuilding(f, P, boost = 1) {
    const e = clamp(0.72 * f.tone + 0.16 * f.level + 0.12 * f.bass * P.bassMass);
    const storeys = Math.max(1, Math.round((1 + Math.pow(e, 1.8) * 36 * boost + (f.sustain || 0)) * P.height));
    const detail = clamp((f.high * 0.6 + f.centroid * 0.4) * P.spikes);
    const type = storeys <= 2 ? 'house' : storeys <= 8 ? 'apartment' : detail > 0.36 ? 'glass' : 'office';
    return { storeys, type, detail };
  }

  /* One building at (x, y0, z) with footprint w × d, rotated by rot.
   * Returns the height of its top. */
  function building(kit, o) {
    const { x, z, w, d, type, rand } = o;
    const tint = o.tint ? o.tint.body : null;          // Pitch colours: the note decides the colour
    const tintDark = o.tint ? o.tint.dark : null;
    const rot = o.rot || 0, y0 = o.y || 0, storeys = Math.max(1, o.storeys), detail = o.detail || 0;
    const cs = Math.cos(rot), sn = Math.sin(rot);
    const at = (u, v) => [x + u * cs + v * sn, z - u * sn + v * cs]; // local -> world

    if (type === 'house') {
      const fl = Math.min(storeys, 2), h = FH * 1.15 * fl;
      const role = tint || (rand() < 0.3 ? 'brick' : 'house');
      kit.box(x, y0 + h / 2, z, w, h, d, rot, role, rand(), facade(fl, w, d, 4, rand()));
      const alongX = w >= d;
      const span = (alongX ? d : w) * 1.12, len = (alongX ? w : d) * 1.08, rh = span * 0.42;
      kit.roof(x, y0 + h, z, span, rh, len, rot + (alongX ? Math.PI / 2 : 0), tintDark || 'roof', rand() * 0.4);
      if (rand() < 0.5) {
        const [cx, cz] = at(w * 0.22, d * 0.12);
        kit.box(cx, y0 + h + rh * 0.55, cz, 0.06, rh * 0.7, 0.06, rot, 'brick', 0.6);
      }
      return y0 + h + rh;
    }

    if (type === 'apartment') {
      const h = FH * storeys;
      const role = tint || ['render', 'brick', 'concrete', 'render'][Math.floor(rand() * 4)];
      kit.box(x, y0 + h / 2, z, w, h, d, rot, role, rand(), facade(storeys, w, d, 1, rand()));
      kit.box(x, y0 + h + 0.025, z, w + 0.03, 0.05, d + 0.03, rot, 'concrete', 0.2); // parapet
      if (detail > 0.55) { // balconies with glass rails on the long face (bright sounds only)
        const alongX = w >= d, span = (alongX ? w : d) * 0.62;
        for (let fl = 2; fl < storeys; fl += 2) {
          const yy = y0 + fl * FH;
          for (const side of [1, -1]) {
            if (alongX) {
              const [bx, bz] = at(0, side * (d / 2 + 0.06)), [rx, rz] = at(0, side * (d / 2 + 0.115));
              kit.box(bx, yy, bz, span, 0.025, 0.12, rot, 'concrete', 0.1);
              kit.box(rx, yy + 0.045, rz, span, 0.07, 0.012, rot, 'glass2', 0.3);
            } else {
              const [bx, bz] = at(side * (w / 2 + 0.06), 0), [rx, rz] = at(side * (w / 2 + 0.115), 0);
              kit.box(bx, yy, bz, 0.12, 0.025, span, rot, 'concrete', 0.1);
              kit.box(rx, yy + 0.045, rz, 0.012, 0.07, span, rot, 'glass2', 0.3);
            }
          }
        }
      }
      const units = rand() < 0.5 ? 1 : 0; // rooftop plant and a water tank
      for (let k = 0; k < units; k++) {
        const [ux, uz] = at((rand() - 0.5) * w * 0.55, (rand() - 0.5) * d * 0.55);
        kit.box(ux, y0 + h + 0.1, uz, 0.12 + rand() * 0.12, 0.1, 0.12, rot, 'concrete2', 0.5);
      }
      if (rand() < 0.6) {
        const [tx, tz] = at((rand() - 0.5) * w * 0.4, (rand() - 0.5) * d * 0.4);
        kit.cyl(tx, y0 + h + 0.05, tz, 0.07, 0.18, 'concrete2', 0.6);
      }
      return y0 + h + 0.2;
    }

    // Office (masonry, ribbon windows) or glass tower (curtain wall): podium, shaft, setback, crown.
    const glass = type === 'glass';
    const seed = rand();
    let y = y0;
    const podFl = Math.min(2, Math.floor(storeys / 5));
    if (podFl > 0) {
      const ph = FH * podFl * 1.15, pw = w * 1.2, pd = d * 1.2;
      kit.box(x, y + ph / 2, z, pw, ph, pd, rot, tintDark || 'stone', rand(), facade(podFl, pw, pd, 3, seed));
      y += ph;
    }
    const shaft = storeys - podFl;
    const lower = shaft > 10 && !glass ? Math.round(shaft * 0.7) : shaft;
    const role = tint || (glass ? 'glass' : rand() < 0.5 ? 'concrete' : 'stone');
    const style = glass ? 3 : 2;
    kit.box(x, y + (FH * lower) / 2, z, w, FH * lower, d, rot, role, rand() * 0.6, facade(lower, w, d, style, seed));
    y += FH * lower;
    let tw = w, td = d;
    if (lower < shaft) {
      const rest = shaft - lower;
      tw = w * 0.74; td = d * 0.74;
      kit.box(x, y + 0.02, z, w + 0.02, 0.04, d + 0.02, rot, 'concrete', 0.3);
      kit.box(x, y + (FH * rest) / 2, z, tw, FH * rest, td, rot, role, rand() * 0.6, facade(rest, tw, td, style, seed));
      y += FH * rest;
    }
    if (glass && shaft > 14) {
      const ch = FH * 2, cw = tw * 0.8, cd = td * 0.8;
      kit.box(x, y + ch / 2, z, cw, ch, cd, rot, tint || 'glass2', 0.4, facade(2, cw, cd, 3, seed));
      y += ch; tw = cw; td = cd;
    }
    kit.box(x, y + 0.09, z, tw * 0.5, 0.18, td * 0.5, rot, 'concrete2', 0.5); // plant room
    y += 0.18;
    if (shaft > 22 && detail > 0.45) { // a single slim mast on the tallest, brightest towers
      const mh = 0.4 + detail * 1.1;
      kit.cyl(x, y, z, 0.022, mh, 'lamp2', 0);
      y += mh;
    }
    return y;
  }

  // Pitch colours: low notes blue, through green and yellow, to red for high notes.
  const _tc = new T.Color();
  function pitchTint(tone) {
    const h = (230 * (1 - clamp(tone))) / 360;
    return {
      body: '#' + _tc.setHSL(h, 0.85, 0.56).getHexString(),
      dark: '#' + _tc.setHSL(h, 0.8, 0.36).getHexString(),
    };
  }

  function tree(kit, x, y, z, s, rand) {
    const h = (0.25 + rand() * 0.2) * s;
    kit.cyl(x, y, z, 0.025 * s, h + 0.1 * s, 'roof2', 0.5);
    const blobs = 2 + Math.floor(rand() * 2), shade = rand();
    for (let b = 0; b < blobs; b++) {
      const a = rand() * Math.PI * 2, dd = rand() * 0.16 * s;
      kit.ico(x + Math.cos(a) * dd, y + h + (0.12 + rand() * 0.18) * s, z + Math.sin(a) * dd,
        (0.14 + rand() * 0.08) * s, 'tree', shade * 0.7 + rand() * 0.3);
    }
  }

  function streetLamp(kit, x, y, z) {
    kit.cyl(x, y, z, 0.018, 0.5, 'lamp2', 0.2);
    kit.cyl(x, y + 0.5, z, 0.045, 0.03, 'lamp', 0);
    kit.bulb(x, y + 0.48, z, 0.07);
    kit.pool(x, 0.03, z, 1.35);
  }

  function car(kit, x, y, z, rot, rand) {
    const cars = kit.pal.cars, colour = cars[Math.floor(rand() * cars.length)];
    const cs = Math.cos(rot), sn = Math.sin(rot);
    kit.box(x, y + 0.06, z, 0.34, 0.08, 0.16, rot, colour);
    kit.box(x - 0.02 * cs, y + 0.13, z + 0.02 * sn, 0.18, 0.07, 0.145, rot, '#22262D', 0, [1, 1, 1, 3.5]);
  }

  /* ---------- Site geometry helpers ---------- */

  const PLAZA_H = 0.06, FLOOR_TOP = 0.09;

  // Causal segmentation: a new district starts when the sound changes character
  // (or a district gets long), so earlier districts stay put while recording.
  function segmentFrames(frames) {
    const n = frames.length, minLen = 5, maxLen = 26, thr = 0.12;
    const out = [];
    const mean = new Float32Array(8);
    let start = 0, cnt = 0, meanLvl = 0;
    for (let i = 0; i < n; i++) {
      const len = i - start;
      if (len >= minLen) {
        const a = Math.max(start, i - 2), w = i - a + 1;
        let d = 0, rl = 0;
        for (let b = 0; b < 8; b++) {
          let r = 0;
          for (let k = a; k <= i; k++) r += frames[k].bands[b];
          d += Math.abs(r / w - mean[b]);
        }
        for (let k = a; k <= i; k++) rl += frames[k].level;
        d = d / 8 + Math.abs(rl / w - meanLvl) * 0.5;
        if (d > thr || len >= maxLen) {
          out.push([start, i]);
          start = i; cnt = 0; mean.fill(0); meanLvl = 0;
        }
      }
      cnt++;
      for (let b = 0; b < 8; b++) mean[b] += (frames[i].bands[b] - mean[b]) / cnt;
      meanLvl += (frames[i].level - meanLvl) / cnt;
    }
    out.push([start, n]);
    return out;
  }

  // An organic outline: a stretched ellipse wobbled by a few low harmonics.
  function makeIsland(cx, cz, R, stretch, axis, rand, wobble) {
    const waves = [];
    for (let k = 2; k <= 5; k++) {
      waves.push({ k, a: (0.03 + rand() * 0.07 + wobble * 0.05) / (k * 0.45), ph: rand() * Math.PI * 2 });
    }
    const total = waves.reduce((s, w) => s + w.a, 0);
    if (total > 0.32) waves.forEach((w) => { w.a *= 0.32 / total; }); // never self-intersects
    const A = R * Math.sqrt(stretch), B = R / Math.sqrt(stretch);
    const r = (th) => {
      const ph = th - axis;
      const base = (A * B) / Math.sqrt((B * Math.cos(ph)) ** 2 + (A * Math.sin(ph)) ** 2);
      let m = 1;
      for (const w of waves) m += w.a * Math.sin(w.k * th + w.ph);
      return base * m;
    };
    return { cx, cz, R, A, B, axis, r, rMax: A * 1.32, plaza: 1.12 + rand() * 0.12 };
  }

  const insideIsland = (isl, x, z, scale = 1, margin = 0) => {
    const dx = x - isl.cx, dz = z - isl.cz;
    return Math.hypot(dx, dz) < isl.r(Math.atan2(dz, dx)) * scale + margin;
  };

  function outline(isl, scale, N = 96, offset = 0) {
    const pts = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2;
      const rr = Math.max(0.1, isl.r(th) * scale + offset);
      pts.push([isl.cx + Math.cos(th) * rr, isl.cz + Math.sin(th) * rr]);
    }
    return pts;
  }

  const circlePts = (cx, cz, r, N = 72) =>
    Array.from({ length: N }, (_, i) => [cx + Math.cos((i / N) * Math.PI * 2) * r, cz + Math.sin((i / N) * Math.PI * 2) * r]);

  // Flat slab from an outline (x,z pairs), from y0 up by depth.
  function extrudeOutline(pts, depth, y0, bevel = 0) {
    const shape = new T.Shape(pts.map(([x, z]) => new T.Vector2(x, -z)));
    const g = new T.ExtrudeGeometry(shape, {
      depth, steps: 1, bevelEnabled: bevel > 0, bevelSize: bevel, bevelThickness: bevel, bevelSegments: 2,
    });
    g.rotateX(-Math.PI / 2);
    g.translate(0, y0, 0);
    return g;
  }

  // Kerb around a block: a thin ring wall following the island outline.
  function kerb(isl, h, y0, thick) {
    const N = 120, pos = [], idx = [];
    for (let i = 0; i < N; i++) {
      const th = (i / N) * Math.PI * 2, ro = isl.r(th), ri = Math.max(0.15, ro - thick);
      const c = Math.cos(th), s = Math.sin(th);
      const ox = isl.cx + c * ro, oz = isl.cz + s * ro, ix = isl.cx + c * ri, iz = isl.cz + s * ri;
      pos.push(ox, y0, oz, ox, y0 + h, oz, ix, y0 + h, iz, ix, y0, iz);
    }
    const quad = (p, q, r, s) => idx.push(p, r, q, p, s, r);
    for (let i = 0; i < N; i++) {
      const a = i * 4, b = ((i + 1) % N) * 4;
      quad(a, b, b + 1, a + 1); quad(a + 1, b + 1, b + 2, a + 2); quad(a + 2, b + 2, b + 3, a + 3);
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    g.computeVertexNormals();
    return g;
  }

  // Flat strips along polylines: roads, lane markings, promenades, water.
  function ribbonGeometry(strips) {
    const pos = [], idx = [];
    for (const { pts, width, yAt, dash } of strips) {
      for (let i = 0; i < pts.length - 1; i++) {
        if (dash && Math.floor(i / dash) % 2) continue;
        const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
        const tx = x1 - x0, tz = z1 - z0, tl = Math.hypot(tx, tz) || 1;
        const nx = (-tz / tl) * width / 2, nz = (tx / tl) * width / 2;
        const y0 = yAt(x0, z0), y1 = yAt(x1, z1);
        const base = pos.length / 3;
        pos.push(x0 + nx, y0, z0 + nz, x0 - nx, y0, z0 - nz, x1 - nx, y1, z1 - nz, x1 + nx, y1, z1 + nz);
        idx.push(base, base + 2, base + 1, base, base + 3, base + 2); // wound to face up
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.Float32BufferAttribute(pos, 3));
    const nrm = new Float32Array(pos.length);
    for (let i = 1; i < nrm.length; i += 3) nrm[i] = 1;
    g.setAttribute('normal', new T.BufferAttribute(nrm, 3));
    g.setIndex(idx);
    return g;
  }

  // Parked/driving cars along a road polyline, on alternating sides.
  function carsAlong(kit, pts, width, yAt, density, rand) {
    for (let i = 2; i < pts.length - 2; i += 4) {
      if (rand() > density) continue;
      const [x0, z0] = pts[i], [x1, z1] = pts[i + 1];
      const tx = x1 - x0, tz = z1 - z0, tl = Math.hypot(tx, tz) || 1;
      const side = rand() < 0.5 ? 1 : -1, off = width * 0.24 * side;
      const x = x0 + (-tz / tl) * off, z = z0 + (tx / tl) * off;
      car(kit, x, yAt(x, z), z, -Math.atan2(tz, tx), rand);
    }
  }

  /* =========================================================
   * 5a. CITY
   * Every word (or syllable, or note) becomes one building.
   *   highest pitch of the word  -> how tall the building is
   *   bass                       -> how wide
   *   silence between words      -> a small park
   *   new passage of the sound   -> the city opens a new block
   * Blocks are laid out on a street grid that spirals out from the centre,
   * so roads are straight, meet at clean crossings and never overlap.
   * Placement only depends on sound already heard: nothing that is standing
   * ever moves or shrinks.
   * ========================================================= */

  const SOUNDING = (f) => f.level > 0.1 || Math.max(f.bass, f.mid, f.high) > 0.4;

  /* Split the sound into words / syllables / notes. A new unit starts:
   *   - when sound begins after silence,
   *   - when the loudness dips and rises again (the breath between syllables),
   *   - on a sharp onset (a consonant, a drum hit, a plucked note),
   *   - on a large pitch leap (a new note in a melody),
   *   - or when a unit gets very long (a held note).
   * A unit's height uses its highest *voiced* pitch, median-filtered over three
   * frames so a single mis-detected frame cannot spike it. Every rule only
   * looks backwards and every value is a running maximum, so a finished unit
   * never changes and a sounding one can only grow. */
  function segmentUnits(frames) {
    const units = [];
    let cur = null, gap = 0, prevLevel = 0, fluxMean = 0.04;
    const med3 = (a) => {
      if (a.length === 1) return a[0] * 0.85;
      if (a.length === 2) return Math.min(a[0], a[1]);
      return a.slice().sort((x, y) => x - y)[1];
    };
    for (let i = 0; i < frames.length; i++) {
      const f = frames[i], prev = frames[i - 1];
      const flux = prev
        ? f.bands.reduce((s, v, b) => s + Math.max(0, v - prev.bands[b]), 0) / 8 + Math.max(0, f.level - prev.level) * 0.6
        : 0;
      const onset = flux > Math.max(0.09, fluxMean * 3);
      fluxMean += (flux - fluxMean) * 0.06;
      if (!SOUNDING(f)) { cur = null; gap++; prevLevel = f.level; continue; }

      let split = !cur;
      if (cur) {
        const len = i - cur.a;
        if (f.level < cur.peak * 0.55) cur.dipped = true;
        const rose = cur.dipped && f.level > prevLevel * 1.18 && f.level > cur.peak * 0.4;
        const leap = f.pitch > 0 && prev && prev.pitch > 0 && Math.abs(12 * Math.log2(f.pitch / prev.pitch)) > 4.5;
        split = (len >= 2 && (rose || onset || leap)) || len >= 18;
      }
      if (split) {
        cur = { a: i, b: i + 1, gap, peak: f.level, level: f.level, bass: f.bass, sumBass: f.bass,
          bright: f.high * 0.6 + f.centroid * 0.4, recent: [], voiced: 0, fallback: 0, dipped: false };
        units.push(cur);
        gap = 0;
      } else {
        cur.b = i + 1;
        cur.peak = Math.max(cur.peak, f.level);
        cur.level = Math.max(cur.level, f.level);
        cur.bass = Math.max(cur.bass, f.bass);
        cur.sumBass += f.bass;
        cur.bright = Math.max(cur.bright, f.high * 0.6 + f.centroid * 0.4);
        if (f.level > prevLevel * 1.1 && !cur.dipped) cur.peak = Math.max(cur.peak, f.level);
      }
      if (f.pitch > 0) {
        cur.recent.push(f.tone);
        if (cur.recent.length > 3) cur.recent.shift();
        cur.voiced = Math.max(cur.voiced, med3(cur.recent));
      }
      cur.fallback = Math.max(cur.fallback, Math.min(0.3, f.centroid * 0.4)); // unvoiced: low, never tall
      cur.tone = Math.max(cur.voiced, cur.fallback);
      prevLevel = f.level;
    }
    return units;
  }

  // Cells of a square spiral: (0,0), (1,0), (1,1), (0,1), (-1,1), ...
  function spiralCells(n) {
    const out = [[0, 0]];
    let x = 0, y = 0, dx = 1, dy = 0, len = 1;
    while (out.length < n) {
      for (let r = 0; r < 2 && out.length < n; r++) {
        for (let s = 0; s < len && out.length < n; s++) { x += dx; y += dy; out.push([x, y]); }
        [dx, dy] = [-dy, dx];
      }
      len++;
    }
    return out;
  }
  const CELLS = spiralCells(900);

  const BLOCK = 4.2, ROAD_W = 0.66, WALK = 0.36;
  const CORR = ROAD_W + 2 * WALK, GRID = BLOCK + CORR;
  const GARDEN = 1.15; // a reserved courtyard garden in the middle of each block

  function buildCity(frames, P, kit, mark) {
    const sections = segmentFrames(frames);
    const secOf = new Int32Array(frames.length);
    sections.forEach(([a, b], k) => { for (let i = a; i < b; i++) secOf[i] = k; });
    const units = segmentUnits(frames);
    const pitchMode = !!kit.pal.pitch;
    const H = BLOCK / 2;
    const rv = variation % 4, mirror = (variation >> 2) & 1;
    const blocks = [];
    let blk = null, buildingsCount = 0, lastSection = -1;

    const openBlock = () => {
      let [i, j] = CELLS[blocks.length];
      for (let r = 0; r < rv; r++) [i, j] = [-j, i];
      if (mirror) i = -i;
      const b = { i, j, cx: i * GRID, cz: j * GRID, side: 0, cursor: 0.12, count: 0,
        rects: [{ x0: i * GRID - GARDEN / 2, x1: i * GRID + GARDEN / 2, z0: j * GRID - GARDEN / 2, z1: j * GRID + GARDEN / 2 }] };
      blocks.push(b);
      return b;
    };
    const overlaps = (b, r) => b.rects.some((o) => r.x0 < o.x1 && r.x1 > o.x0 && r.z0 < o.z1 && r.z1 > o.z0);

    // Next free w × d lot on the block's edge, facing the street (clockwise from the north side).
    const placeLot = (b, w, d) => {
      while (b.side < 4) {
        if (b.cursor + w > BLOCK - 0.12) { b.side++; b.cursor = 0.12; continue; }
        const c = b.cursor + w / 2;
        let x, z, rot, ex, ez;
        if (b.side === 0) { x = b.cx - H + c; z = b.cz + H - d / 2; rot = 0; ex = w / 2; ez = d / 2; }
        else if (b.side === 1) { x = b.cx + H - d / 2; z = b.cz + H - c; rot = Math.PI / 2; ex = d / 2; ez = w / 2; }
        else if (b.side === 2) { x = b.cx + H - c; z = b.cz - H + d / 2; rot = Math.PI; ex = w / 2; ez = d / 2; }
        else { x = b.cx - H + d / 2; z = b.cz - H + c; rot = -Math.PI / 2; ex = d / 2; ez = w / 2; }
        const r = { x0: x - ex - 0.05, x1: x + ex + 0.05, z0: z - ez - 0.05, z1: z + ez + 0.05 };
        if (overlaps(b, r)) { b.cursor += 0.25; continue; }
        b.rects.push(r);
        return { x, z, rot, side: b.side, c, w };
      }
      return null;
    };
    // Point on the block's edge strip at distance c along a side, `inset` in from the kerb line.
    const sidePoint = (b, side, c, inset) => {
      if (side === 0) return [b.cx - H + c, b.cz + H - inset];
      if (side === 1) return [b.cx + H - inset, b.cz + H - c];
      if (side === 2) return [b.cx + H - c, b.cz - H + inset];
      return [b.cx - H + inset, b.cz - H + c];
    };
    const lot = (w, d) => {
      let at = placeLot(blk, w, d);
      if (!at) { blk = openBlock(); at = placeLot(blk, w, d); }
      return at;
    };

    units.forEach((u, ui) => {
      const rand = mulberry32(u.a * 977 + 13);
      const sec = secOf[u.a];
      if (!blk || (sec !== lastSection && blk.count >= 7)) blk = openBlock();
      lastSection = sec;

      // A pause before this word becomes a small park
      if (u.gap >= 3 && ui > 0) {
        const pw = clamp(0.8 + u.gap * 0.07, 0.9, 2.2), pd = 1.2;
        const [b0, r0] = kit.counts();
        const at = lot(pw, pd);
        if (at) {
          const along = at.rot === 0 || at.rot === Math.PI;
          kit.box(at.x, 0.07, at.z, along ? pw : pd, 0.03, along ? pd : pw, 0, 'lawn', rand());
          const nTrees = 2 + Math.round(pw * 1.4);
          for (let t = 0; t < nTrees; t++) {
            const ux = (rand() - 0.5) * (along ? pw : pd) * 0.75, uz = (rand() - 0.5) * (along ? pd : pw) * 0.75;
            tree(kit, at.x + ux, 0.085, at.z + uz, 1.25 + rand() * 0.7, rand);
          }
          blk.cursor = at.c + pw / 2 + 0.15;
          const [b1, r1] = kit.counts();
          for (let fi = u.a - u.gap; fi < u.a; fi++) mark(fi, [at.x, 0.15, at.z], Math.max(pw, pd) * 0.6, [b0, b1, r0, r1]);
        }
      }

      // The word's building
      const len = u.b - u.a;
      const bassAvg = u.sumBass / len;
      const w = clamp(0.7 + bassAvg * 0.85 * P.bassMass, 0.65, 1.6);
      const d = clamp(0.95 + rand() * 0.45 + u.level * 0.15, 0.9, H - GARDEN / 2 - 0.12);
      const f = { tone: u.tone, level: u.level, bass: u.bass, high: u.bright, centroid: u.bright, sustain: Math.min(len, 12) * 0.12 };
      const b = chooseBuilding(f, P, 1);
      const [b0, r0] = kit.counts();
      const at = lot(w, d);
      if (!at) return;
      const top = building(kit, { x: at.x, y: 0.05, z: at.z, w, d, storeys: b.storeys, type: b.type, detail: b.detail, rot: at.rot, rand,
        tint: pitchMode ? pitchTint(u.tone) : null });
      // A gap after the building, with a tree in it now and then
      const gapAfter = 0.16 + rand() * 0.24;
      blk.cursor = at.c + w / 2 + gapAfter;
      if (gapAfter > 0.27) {
        const [tx, tz] = sidePoint(blk, at.side, at.c + w / 2 + gapAfter / 2, 0.22);
        tree(kit, tx, 0.05, tz, 1.0 + rand() * 0.4, rand);
      }
      const [b1, r1] = kit.counts();
      blk.count++;
      buildingsCount++;
      for (let fi = u.a; fi < u.b; fi++) mark(fi, [at.x, Math.min(top, 0.7), at.z], Math.max(w, d) * 0.7, [b0, b1, r0, r1]);
    });

    /* Blocks: pavement slab, courtyard garden, street trees and corner lamps. */
    const edges = new Map();
    blocks.forEach((bk, k) => {
      const rand = mulberry32(k * 7907 + 3);
      kit.box(bk.cx, 0.025, bk.cz, BLOCK + 2 * WALK, 0.05, BLOCK + 2 * WALK, 0, 'plaza', 0.15);
      kit.box(bk.cx, 0.06, bk.cz, GARDEN, 0.025, GARDEN, 0, 'lawn', rand());
      for (let t = 0; t < 3; t++) tree(kit, bk.cx + (rand() - 0.5) * GARDEN * 0.6, 0.07, bk.cz + (rand() - 0.5) * GARDEN * 0.6, 1.3 + rand() * 0.6, rand);
      const kerb = H + WALK * 0.55;
      for (const [sx, sz] of [[1, 1], [1, -1], [-1, 1], [-1, -1]]) streetLamp(kit, bk.cx + sx * kerb, 0.05, bk.cz + sz * kerb);
      for (let side = 0; side < 4; side++) {
        for (let c = 0.75; c < BLOCK - 0.4; c += 0.95) {
          const [tx, tz] = sidePoint(bk, side, c, -WALK * 0.5);
          tree(kit, tx, 0.05, tz, 0.95 + rand() * 0.35, rand);
        }
      }
      // The four road segments around the block (shared with neighbours)
      edges.set(`h${2 * bk.j + 1}:${bk.i}`, [bk.cx, bk.cz + GRID / 2, 0]);
      edges.set(`h${2 * bk.j - 1}:${bk.i}`, [bk.cx, bk.cz - GRID / 2, 0]);
      edges.set(`v${2 * bk.i + 1}:${bk.j}`, [bk.cx + GRID / 2, bk.cz, 1]);
      edges.set(`v${2 * bk.i - 1}:${bk.j}`, [bk.cx - GRID / 2, bk.cz, 1]);
    });

    /* Roads: one straight segment per block edge; dashes stop short of the crossings. */
    const laneRole = kit.pal.lane ? 'lane' : 'plaza';
    let e = 0;
    for (const [key, [x, z, vert]] of edges) {
      const rand = mulberry32(e++ * 31 + key.length * 977 + Math.round(x * 13 + z * 7));
      const L = GRID + ROAD_W;
      kit.box(x, 0.008, z, vert ? ROAD_W : L, 0.016, vert ? L : ROAD_W, 0, 'road2', 0);
      for (let s = -BLOCK / 2 + 0.25; s < BLOCK / 2 - 0.25; s += 0.5) {
        kit.box(vert ? x : x + s, 0.018, vert ? z + s : z, vert ? 0.03 : 0.24, 0.004, vert ? 0.24 : 0.03, 0, laneRole, 0);
      }
      const nCars = Math.floor(rand() * 2.2);
      for (let c = 0; c < nCars; c++) {
        const s = (rand() - 0.5) * (BLOCK - 0.8), lane = (rand() < 0.5 ? 1 : -1) * ROAD_W * 0.24;
        car(kit, vert ? x + lane : x + s, 0.016, vert ? z + s : z + lane, vert ? Math.PI / 2 : 0, rand);
      }
    }

    state.districts = blocks.length;
    state.buildingsCount = buildingsCount;
  }

  const BUILDERS = {
    /* TOWER: a skyscraper, one storey per moment of sound.
     * Bass (smoothed, stepped) -> floor plate and setbacks, brightness -> glass
     * or ribbon-window bands, highs -> balconies. */
    tower(frames, P, kit, mark) {
      const S = groupBy(frames, perFor(60, 3));
      const pitchMode = !!kit.pal.pitch;
      const first = S.slice(0, 10);
      const aBass = first.reduce((t, s) => t + s.bass, 0) / first.length; // the opening sets the podium
      const tail = S.slice(-6), aHigh = tail.reduce((t, s) => t + s.high, 0) / tail.length;
      const sm = S.map((_, i) => { // causal smoothing: only what came before
        let t = 0, c = 0;
        for (let k = -5; k <= 0; k++) if (S[i + k]) { t += S[i + k].bass; c++; }
        return t / c;
      });
      const site = mulberry32(17);
      const baseW = 2.0 + aBass * 2.4 * P.bassMass;
      kit.mesh(extrudeOutline(circlePts(0, 0, baseW * 2.4), PLAZA_H, 0), LMAT.plaza);
      // Podium
      const podH = FH * 3.3;
      kit.box(0, PLAZA_H + podH / 2, 0, baseW * 1.55, podH, baseW * 1.25, 0, 'stone', 0.3, facade(3, baseW * 1.55, baseW * 1.25, 3, 0.4));
      kit.box(0, PLAZA_H + podH + 0.02, 0, baseW * 1.57, 0.04, baseW * 1.27, 0, 'concrete', 0.2);
      let y = PLAZA_H + podH;
      let prevW = baseW * 1.15;
      for (let i = 0; i < S.length; i++) {
        const s = S[i];
        let w = 1.2 + (Math.round(sm[i] * 6) / 6) * 2.4 * P.bassMass; // stepped setbacks
        w = Math.min(w, prevW * 1.04);
        prevW = w;
        const d = w * 0.78;
        const rot = 0;
        // high notes and loud, heavy moments make taller storeys
        const fh = FH * P.height * (0.35 + s.tone * 0.8 + s.level * 0.4 + s.bass * 0.2);
        const bright = (s.high * 0.6 + s.centroid * 0.4) * P.spikes;
        const glass = bright > 0.36;
        const [b0, r0] = kit.counts();
        kit.box(0, y + fh / 2, 0, w, fh, d, rot, pitchMode ? pitchTint(s.tone).body : glass ? 'glass' : 'concrete', 0.2 + s.level * 0.5,
          facade(1, w, d, glass ? 3 : 2, ((i * 0.137) % 1)));
        kit.box(0, y + fh - 0.012, 0, w + 0.025, 0.024, d + 0.025, rot, 'concrete2', 0.2); // slab edge
        if (s.high * P.spikes > 0.42 && i > 1) { // balconies with glass rails
          const cs = Math.cos(rot), sn = Math.sin(rot);
          for (const side of [1, -1]) {
            const ox = side * (d / 2 + 0.07) * sn, oz = side * (d / 2 + 0.07) * cs;
            kit.box(ox, y + 0.01, oz, w * 0.7, 0.022, 0.14, rot, 'concrete', 0.1);
            kit.box(ox * 1.5, y + 0.06, oz * 1.5, w * 0.7, 0.08, 0.01, rot, 'glass2', 0.3);
          }
        }
        const [b1, r1] = kit.counts();
        for (let fi = s.a; fi < s.b; fi++) mark(fi, [0, y + fh / 2, 0], Math.max(w, d) * 0.66, [b0, b1, r0, r1]);
        y += fh;
      }
      // Crown: two plant floors, and a mast if the ending is bright
      const topW = prevW * 0.7;
      kit.box(0, y + FH, 0, topW, FH * 2, topW * 0.78, 0, 'concrete2', 0.4, facade(2, topW, topW * 0.78, 2, 0.5));
      y += FH * 2;
      if (aHigh * P.spikes > 0.25) kit.cyl(0, y, 0, 0.03, 1 + aHigh * 3, 'lamp2', 0);
      // Ring road with traffic, trees and lamps on the plaza
      const R = baseW * 2.4;
      const pts = circlePts(0, 0, R + 0.45, 120);
      pts.push(pts[0]);
      kit.mesh(ribbonGeometry([{ pts, width: 0.75, yAt: () => 0.012 }]), LMAT.road, { bounds: false });
      kit.mesh(ribbonGeometry([{ pts, width: 0.025, yAt: () => 0.016, dash: 2 }]), LMAT.lane, { bounds: false });
      carsAlong(kit, pts, 0.75, () => 0.012, 0.5, site);
      const trees = 28;
      for (let t = 0; t < trees; t++) {
        const a = (t / trees) * Math.PI * 2 + site() * 0.2, r = baseW * lerp(1.25, 2.2, site());
        tree(kit, Math.cos(a) * r, PLAZA_H, Math.sin(a) * r, 1.3 + site() * 0.8, site);
      }
      for (let t = 0; t < 12; t++) {
        const a = (t / 12) * Math.PI * 2;
        streetLamp(kit, Math.cos(a) * (R - 0.15), PLAZA_H, Math.sin(a) * (R - 0.15));
      }
    },

    city: (frames, P, kit, mark) => buildCity(frames, P, kit, mark),

    /* RIVER: a riverside city that grows downstream while the sound plays.
     * Each word / note alternates between the two banks and becomes a building
     * on the quay (highest pitch = height, bass = frontage), with a lower row
     * behind the riverside road. A bridge marks a new passage of the sound,
     * at most one every stretch of river. The river's course is fixed in
     * advance, so nothing built ever moves. */
    river(frames, P, kit, mark) {
      const S = segmentUnits(frames).map((u) => {
        const len = u.b - u.a;
        return { a: u.a, b: u.b, gap: u.gap, tone: u.tone, level: u.level, bass: u.sumBass / len, high: u.bright, centroid: u.bright, len };
      });
      const pitchMode = !!kit.pal.pitch;
      const RIVER = 3.0, QUAY = 0.6, ROADW = 0.6;
      // Fixed meander: depends only on distance downstream
      const cz = (x) => 2.6 * Math.sin(x * 0.11) + 1.1 * Math.sin(x * 0.27 + 1.3);
      const at = (x) => {
        const z = cz(x), dz = (cz(x + 0.05) - cz(x - 0.05)) / 0.1, tl = Math.hypot(1, dz);
        return { x, z, tx: 1 / tl, tz: dz / tl, nx: -dz / tl, nz: 1 / tl }; // n points to the north bank
      };
      const off = (p, o) => [p.x + p.nx * o, p.z + p.nz * o];

      // Lay out moments: two banks, each with its own cursor downstream
      const cursor = [0, 0.6];
      const placed = S.map((s, i) => {
        const rand = mulberry32(s.a * 409 + 3);
        const bank = cursor[0] <= cursor[1] ? 0 : 1;
        if (s.gap >= 3 && i > 0) cursor[bank] += Math.min(2.2, 0.5 + s.gap * 0.06); // a pause leaves a garden gap
        const w = clamp(0.75 + s.bass * 1.1 * P.bassMass, 0.7, 1.8);
        const x = cursor[bank] + w / 2;
        cursor[bank] += w + 0.2 + rand() * 0.18;
        return { s, i, bank, w, x, rand };
      });
      const L = Math.max(cursor[0], cursor[1]);
      const x0 = -5, x1 = L + 5;
      const line = (o, step = 0.25) => {
        const out = [];
        for (let x = x0; x <= x1 + 1e-6; x += step) out.push(off(at(x), o));
        return out;
      };
      // Water, quays, roads, back-street pavements
      kit.mesh(ribbonGeometry([{ pts: line(0), width: RIVER * 2, yAt: () => 0.006 }]), LMAT.water, { bounds: false });
      for (const sg of [1, -1]) {
        kit.mesh(ribbonGeometry([{ pts: line(sg * (RIVER + QUAY / 2)), width: QUAY, yAt: () => 0.04 }]), LMAT.plaza);
        const road = line(sg * (RIVER + QUAY + 2.6 + ROADW / 2));
        kit.mesh(ribbonGeometry([{ pts: road, width: ROADW, yAt: () => 0.014 }]), LMAT.road, { bounds: false });
        kit.mesh(ribbonGeometry([{ pts: road, width: 0.022, yAt: () => 0.018, dash: 2 }]), LMAT.lane, { bounds: false });
        carsAlong(kit, road, ROADW, () => 0.014, 0.35, mulberry32(sg > 0 ? 11 : 12));
      }

      // Buildings on the quays
      let section = 0, lastBridge = -Infinity;
      const BRIDGE_EVERY = 11; // at most one bridge per this much river
      const sections = segmentFrames(frames);
      placed.forEach(({ s, i, bank, w, x, rand }) => {
        const p = at(x), sg = bank ? -1 : 1;
        const rot = -Math.atan2(p.tz, p.tx);
        const f = { ...s, sustain: Math.min(s.len, 12) * 0.12 };
        const b = chooseBuilding(f, P, 1.1);
        const d = 1.1 + rand() * 0.6;
        const [bx, bz] = off(p, sg * (RIVER + QUAY + d / 2 + 0.05));
        const tint = pitchMode ? pitchTint(s.tone) : null;
        const [b0, r0] = kit.counts();
        let top;
        if (b.type === 'house') { // a pair of canal houses
          for (const k of [-1, 1]) {
            building(kit, { x: bx + p.tx * k * w * 0.25, y: 0.02, z: bz + p.tz * k * w * 0.25, w: w * 0.46, d: d * 0.85,
              storeys: Math.max(2, b.storeys), type: 'house', rot, rand, tint });
          }
          top = FH * 3;
        } else {
          top = building(kit, { x: bx, y: 0.02, z: bz, w, d, storeys: b.storeys, type: b.type, detail: b.detail, rot, rand, tint });
        }
        const [b1, r1] = kit.counts();
        for (let fi = s.a; fi < s.b; fi++) mark(fi, [bx, Math.min(top, 0.8), bz], Math.max(w, d) * 0.65, [b0, b1, r0, r1]);

        // Back row behind the riverside road: lower, a quieter echo
        if (rand() < 0.8) {
          const d2 = 0.9 + rand() * 0.5;
          const [cx2, cz2] = off(p, sg * (RIVER + QUAY + 2.6 + ROADW + 0.25 + d2 / 2));
          const b2 = chooseBuilding({ ...f, tone: s.tone * 0.6, level: s.level * 0.7 }, P, 0.75);
          building(kit, { x: cx2, y: 0.02, z: cz2, w: w * (0.85 + rand() * 0.15), d: d2, storeys: b2.storeys,
            type: b2.type === 'glass' ? 'office' : b2.type, detail: b2.detail, rot, rand, tint: tint && pitchTint(s.tone * 0.6) });
        }
        // Gardens between the front building and the road: trees, and lamps on the quay
        const [gx, gz] = off(p, sg * (RIVER + QUAY + d + 0.55 + rand() * 0.6));
        tree(kit, gx + p.tx * (rand() - 0.5) * w * 0.6, 0.02, gz + p.tz * (rand() - 0.5) * w * 0.6, 1.3 + rand() * 0.7, rand);
        if (rand() < 0.6) {
          const [hx, hz] = off(p, sg * (RIVER + QUAY + d + 1.6 + rand() * 0.5));
          tree(kit, hx, 0.02, hz, 1.2 + rand() * 0.6, rand);
        }
        const [lx, lz] = off(at(x - w / 2), sg * (RIVER + 0.12));
        if (i % 2 === 0) streetLamp(kit, lx, 0.04, lz);
        else tree(kit, lx, 0.04, lz, 1.0 + rand() * 0.4, rand);

        // A bridge whenever the sound moves into a new passage
        let newPassage = false;
        while (section < sections.length - 1 && s.a >= sections[section + 1][0]) { section++; newPassage = true; }
        if (newPassage && x - lastBridge >= BRIDGE_EVERY) {
          lastBridge = x;
          const q = at(x - w / 2 - 0.1), span = (RIVER + QUAY) * 2 + 0.4;
          const brot = -Math.atan2(q.nz, q.nx);
          kit.box(q.x, 0.24, q.z, span, 0.08, 0.7, brot, 'stone', 0.4);
          for (const k of [-1, 1]) {
            const [rx, rz] = [q.x + q.tx * k * 0.33, q.z + q.tz * k * 0.33];
            kit.box(rx, 0.32, rz, span, 0.08, 0.04, brot, 'stone', 0.3); // parapets
          }
          for (const k of [-0.5, 0.5]) kit.cyl(q.x + q.nx * k * RIVER, 0, q.z + q.nz * k * RIVER, 0.12, 0.22, 'concrete2', 0.4);
          streetLamp(kit, q.x + q.tx * 0.3, 0.28, q.z + q.tz * 0.3);
        }
        // Boats on the water now and then
        if (rand() < 0.25) {
          const [wx, wz] = off(p, (rand() - 0.5) * RIVER * 1.2);
          kit.box(wx, 0.05, wz, 0.55, 0.08, 0.2, rot, 'render', 0.2);
          kit.box(wx - p.tx * 0.06, 0.12, wz - p.tz * 0.06, 0.22, 0.07, 0.15, rot, 'brick', 0.2);
        }
      });
    },
  };

  const MODE_LABEL = { city: 'City', tower: 'Tower', river: 'River' };

  const bbox = new T.Box3();
  let fitGoal = null; // { target, distance, dir? } eased toward each frame
  // Once the visitor zooms or drags, automatic framing steps aside until they
  // pick another form, load a new sound or go back to the start.
  let userCam = false;
  controls.addEventListener('start', () => { userCam = true; fitGoal = null; });

  // Preferred viewing direction per mode: the City is read from above, like a site model.
  const VIEW_DIR = {
    tower: new T.Vector3(0.75, 0.42, 1),
    city: new T.Vector3(0.6, 0.85, 0.8),
    river: new T.Vector3(0.15, 1.25, 1),
  };

  function clearLandscape() {
    for (const m of [...landscape.children]) {
      landscape.remove(m);
      m.geometry.dispose();
    }
  }

  function setEmpty(title, text) {
    const [a, b] = ui.empty.querySelectorAll('p');
    a.textContent = title;
    b.textContent = text;
  }

  function rebuild({ fit = false, live = false } = {}) {
    // Nothing is built until there is sound: skip the silence at the start.
    let start = 0;
    while (start < state.frames.length && !SOUNDING(state.frames[start])) start++;
    const frames = state.frames.slice(start);
    ui.empty.hidden = frames.length > 0;
    if (!frames.length) {
      if (state.playing || state.recording) setEmpty('Listening', 'Waiting for the first sound.');
      else if (state.allFrames.length) setEmpty('Ready to build', 'Press play: the city grows while the sound plays.');
      else setEmpty('Nothing built yet', 'Record a few seconds of sound, load a track, or press Demo.');
    }
    state.anchors = [];
    state.ranges = [];
    clearLandscape();
    if (!frames.length) {
      INSTANCED.forEach((m) => { m.count = 0; });
      ring.visible = false;
      ui.btnPng.disabled = ui.btnGlb.disabled = true;
      ui.stats.textContent = '';
      drawTimeline();
      updateButtons();
      return;
    }
    const kit = makeKit();
    const mark = (i, pos, radius, range) => { state.anchors[i + start] = { pos, radius }; state.ranges[i + start] = range; };
    BUILDERS[state.mode](frames, state.params, kit, mark);
    const counts = kit.allCounts();

    // Bounds -> shadow camera + framing
    bbox.makeEmpty();
    const tmp = new T.Box3();
    facadeAttr.needsUpdate = true;
    INSTANCED.forEach((m, k) => {
      m.count = counts[k];
      m.instanceMatrix.needsUpdate = true;
      m.instanceColor.needsUpdate = true;
      m.userData.base.set(m.instanceColor.array.subarray(0, counts[k] * 3));
      if (counts[k]) {
        m.computeBoundingSphere();
        m.computeBoundingBox();
        bbox.union(tmp.copy(m.boundingBox));
      }
    });
    landscape.children.forEach((c) => { if (!c.userData.noBounds) bbox.union(tmp.setFromObject(c)); });
    state.currentFrame = -1;
    ring.visible = false;

    const size = bbox.getSize(new T.Vector3());
    const centre = bbox.getCenter(new T.Vector3());
    const radius = Math.max(4, size.length() / 2);
    const sc = sun.shadow.camera;
    sc.left = -radius; sc.right = radius; sc.top = radius; sc.bottom = -radius;
    sc.near = 1; sc.far = radius * 5;
    sc.updateProjectionMatrix();
    sun.target.position.copy(centre);
    const night = !!PALETTES[state.palette].night;
    sun.position.copy(centre).addScaledVector(night ? MOON_DIR : SUN_DIR, radius * 2.2);
    stars.position.copy(centre);
    sun.shadow.mapSize.set(radius > 18 ? 2048 : 1024, radius > 18 ? 2048 : 1024);
    if (sun.shadow.map && sun.shadow.map.width !== sun.shadow.mapSize.x) { sun.shadow.map.dispose(); sun.shadow.map = null; }

    // Fog scales with the model so the horizon always dissolves softly.
    scene.fog.near = radius * 2.6;
    scene.fog.far = radius * 8;

    if (fit && !live) userCam = false; // a new form or variation: frame it again
    if ((fit && !live) || ((fit || live) && !userCam)) {
      const fill = { city: 0.66, river: 0.6 }[state.mode] || 0.92;
      const dist = radius / Math.sin((camera.fov * Math.PI) / 360) * fill;
      fitGoal = {
        target: centre.clone(),
        distance: Math.max(dist, 8),
        snap: fit && !live,
        dir: fit && !live ? VIEW_DIR[state.mode].clone().normalize() : null,
      };
    }

    ui.btnPng.disabled = ui.btnGlb.disabled = false;
    describeStructure(size);
    drawTimeline();
    updateButtons();
  }

  function describeStructure(size) {
    const f = state.frames, n = f.length;
    const avg = (k) => f.reduce((s, x) => s + x[k], 0) / n;
    const b = avg('bass'), m = avg('mid'), h = avg('high');
    const city = state.mode === 'city';
    const dominant = city
      ? (b >= m && b >= h ? 'with broad blocks and low-rise housing' : h >= m ? 'with many glass towers' : 'with dense mid-rise blocks')
      : (b >= m && b >= h ? 'bass-heavy, with broad floor plates'
        : h >= m ? 'treble-rich, mostly glass with balconies' : 'mid-focused, with tall masonry and ribbon windows');
    const nb = state.buildingsCount || 0;
    ui.stats.textContent = city
      ? `City, ${nb} building${nb === 1 ? '' : 's'} on ${state.districts} block${state.districts === 1 ? '' : 's'}`
      : `${MODE_LABEL[state.mode]}, ${n} layers, ${Math.round(size.y / FH)} storeys at the top`;
    renderer.domElement.setAttribute('aria-label',
      `${MODE_LABEL[state.mode]} built from ${state.sourceLabel || 'sound'}: ` +
      `${city ? `${nb} buildings on ${state.districts} blocks, ` : ''}${n} layers, ${dominant}. ` +
      `Average energy: bass ${Math.round(b * 100)}%, mids ${Math.round(m * 100)}%, highs ${Math.round(h * 100)}%.`);
  }

  // Light up the layer that is currently sounding.
  function highlightFrame(i) {
    if (i === state.currentFrame) return;
    const pal = PALETTES[state.palette];
    const accent = _c2.set(pal.accent);
    const restore = (r) => {
      if (!r) return;
      boxes.instanceColor.array.set(boxes.userData.base.subarray(r[0] * 3, r[1] * 3), r[0] * 3);
      roofs.instanceColor.array.set(roofs.userData.base.subarray(r[2] * 3, r[3] * 3), r[2] * 3);
    };
    restore(state.ranges[state.currentFrame]);
    const r = state.ranges[i];
    if (r) {
      const tint = (arr, base, a, b) => {
        for (let k = a * 3; k < b * 3; k += 3) {
          arr[k] = lerp(base[k], accent.r, 0.65);
          arr[k + 1] = lerp(base[k + 1], accent.g, 0.65);
          arr[k + 2] = lerp(base[k + 2], accent.b, 0.65);
        }
      };
      tint(boxes.instanceColor.array, boxes.userData.base, r[0], r[1]);
      tint(roofs.instanceColor.array, roofs.userData.base, r[2], r[3]);
    }
    boxes.instanceColor.needsUpdate = true;
    roofs.instanceColor.needsUpdate = true;
    state.currentFrame = i;
    const a = state.anchors[i];
    ring.visible = !!a;
    if (a) {
      ring.position.set(a.pos[0], a.pos[1] + 0.02, a.pos[2]);
      ring.scale.setScalar(a.radius);
    }
    ui.timeline.setAttribute('aria-valuenow', String(i + 1));
    ui.timeline.setAttribute('aria-valuetext', `Layer ${i + 1} of ${state.frames.length}`);
  }

  function frameAtTime(t) {
    const f = state.frames;
    if (!f.length) return -1;
    let lo = 0, hi = f.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (f[mid].t <= t) lo = mid; else hi = mid - 1;
    }
    return lo;
  }

  /* =========================================================
   * 6. 2D METERS: live spectrum + section drawing
   * ========================================================= */

  const sctx = ui.spectrum.getContext('2d');
  const tctx = ui.timeline.getContext('2d');
  const GROUP_COLOURS = ['#111111', '#F2481B', '#1F4FE0'];
  const liveBins = new Float32Array(FFT_SIZE / 2);

  const NOTE_NAMES = ['C', 'C#', 'D', 'D#', 'E', 'F', 'F#', 'G', 'G#', 'A', 'A#', 'B'];
  const noteName = (hz) => { const m = Math.round(69 + 12 * Math.log2(hz / 440)); return NOTE_NAMES[((m % 12) + 12) % 12] + (Math.floor(m / 12) - 1); };

  function drawSpectrum() {
    const c = ui.spectrum, w = c.width, h = c.height;
    sctx.clearRect(0, 0, w, h);
    const live = state.recording || state.playing;
    if (live && analyser) {
      analyser.getFloatFrequencyData(liveBins);
      const bars = 48, sr = audioCtx.sampleRate;
      const bw = w / bars;
      for (let k = 0; k < bars; k++) {
        const f0 = 30 * Math.pow(16000 / 30, k / bars), f1 = 30 * Math.pow(16000 / 30, (k + 1) / bars);
        const a = Math.max(1, Math.floor(f0 / (sr / FFT_SIZE))), b = Math.max(a, Math.ceil(f1 / (sr / FFT_SIZE)));
        let m = -140;
        for (let i = a; i <= b && i < liveBins.length; i++) m = Math.max(m, liveBins[i]);
        const v = clamp((m + 95) / 70);
        const g = f0 < 250 ? 0 : f0 < 2500 ? 1 : 2;
        sctx.fillStyle = GROUP_COLOURS[g];
        sctx.fillRect(k * bw + 1, h - v * (h - 4), bw - 2, v * (h - 4));
      }
      ui.spectrumLabel.textContent = state.recording ? 'Live microphone spectrum, 30 Hz–16 kHz' : 'Playback spectrum, 30 Hz–16 kHz';
    } else if (state.frames.length) {
      const i = Math.max(0, state.currentFrame);
      const f = state.frames[i];
      const bw = w / 8;
      for (let b = 0; b < 8; b++) {
        const v = f.bands[b];
        sctx.fillStyle = GROUP_COLOURS[BAND_GROUP[b]];
        sctx.fillRect(b * bw + 2, h - v * (h - 4), bw - 4, v * (h - 4));
      }
      ui.spectrumLabel.textContent = f.pitch
        ? `Moment ${i + 1}: note ${noteName(f.pitch)} (${Math.round(f.pitch)} Hz), bands low to high`
        : `Moment ${i + 1}: no clear note, bands low to high`;
    } else {
      ui.spectrumLabel.textContent = 'Spectrum';
    }
  }

  // The timeline shows the whole sound; the part not yet heard (not built) is faded.
  const timelineFrames = () => (state.allFrames.length ? state.allFrames : state.frames);

  function drawTimeline() {
    const c = ui.timeline, w = c.width, h = c.height;
    if (!tctx || !w) return;
    tctx.clearRect(0, 0, w, h);
    const f = timelineFrames(), n = f.length, built = state.frames.length;
    ui.timeline.setAttribute('aria-valuemax', String(Math.max(1, n)));
    if (!n) {
      tctx.strokeStyle = '#B9C0CB';
      tctx.setLineDash([4, 4]);
      tctx.beginPath(); tctx.moveTo(0, h - 1); tctx.lineTo(w, h - 1); tctx.stroke();
      tctx.setLineDash([]);
      return;
    }
    const pal = PALETTES[state.palette];
    const roles = [pal.bass, pal.mid2, pal.high];
    const cw = w / n, rh = h / 8;
    for (let i = 0; i < n; i++) {
      const fade = i < built ? 1 : 0.22;
      for (let b = 0; b < 8; b++) {
        tctx.globalAlpha = (0.08 + f[i].bands[b] * 0.92) * fade;
        tctx.fillStyle = BAND_GROUP[b] === 1 ? '#7C8597' : roles[BAND_GROUP[b]];
        tctx.fillRect(i * cw, h - (b + 1) * rh, Math.ceil(cw), rh - 0.5);
      }
    }
    // Loudness as a skyline
    tctx.globalAlpha = 1;
    tctx.strokeStyle = '#1C2230';
    tctx.lineWidth = Math.max(1, w / 900);
    tctx.beginPath();
    for (let i = 0; i < n; i++) {
      const y = h - f[i].level * h * 0.98;
      if (i === 0) tctx.moveTo(0, y);
      tctx.lineTo(i * cw, y); tctx.lineTo((i + 1) * cw, y);
    }
    tctx.stroke();
    // Melody: one dot per pitched moment, high notes higher up
    tctx.fillStyle = '#F2481B';
    const dot = Math.max(2, Math.min(5, cw * 0.8));
    for (let i = 0; i < n; i++) {
      if (!f[i].pitch) continue;
      tctx.globalAlpha = i < built ? 1 : 0.3;
      tctx.fillRect(i * cw + cw / 2 - dot / 2, h - f[i].tone * (h - 6) - 3 - dot / 2, dot, dot);
    }
    tctx.globalAlpha = 1;
    if (built < n) { // the build front
      tctx.fillStyle = '#111111';
      tctx.fillRect(built * cw - 1, 0, 2, h);
    }
    if (state.currentFrame >= 0) {
      tctx.fillStyle = pal.accent === '#FFE15A' ? '#2A3BD6' : pal.accent;
      tctx.fillRect(state.currentFrame * cw, 0, Math.max(2, cw), h);
    }
  }

  function timelinePick(clientX) {
    const r = ui.timeline.getBoundingClientRect();
    const u = clamp((clientX - r.left) / r.width);
    const list = timelineFrames(), n = list.length;
    if (!n) return;
    const i = Math.min(n - 1, Math.floor(u * n));
    if (i < state.frames.length) highlightFrame(i);
    if (state.buffer) seekTo(list[i].t);
    drawTimeline();
  }

  /* =========================================================
   * 7. EXPORT: PNG poster + GLB model
   * ========================================================= */

  function exportPng() {
    if (!state.frames.length) return;
    const prevRatio = renderer.getPixelRatio();
    renderer.setPixelRatio(Math.max(2, prevRatio));
    const r = ui.viewport.getBoundingClientRect();
    renderer.setSize(r.width, r.height, false);
    const savedFrame = state.currentFrame;
    highlightFrame(-1); // clean render: no playhead tint
    ring.visible = false;
    renderer.render(scene, camera);
    const gl = renderer.domElement;
    const W = gl.width, H = gl.height;
    const strip = Math.round(H * 0.16);
    const out = document.createElement('canvas');
    out.width = W; out.height = H + strip;
    const o = out.getContext('2d');
    o.drawImage(gl, 0, 0);
    // Caption band with the section drawing
    o.fillStyle = '#FFE422';
    o.fillRect(0, H, W, strip);
    o.fillStyle = '#111111';
    o.fillRect(0, H, W, Math.max(2, W / 800));
    const pad = Math.round(strip * 0.18);
    const titleSize = Math.round(strip * 0.3);
    o.font = `900 ${titleSize}px Archivo, "Helvetica Neue", Arial, sans-serif`;
    o.fillText('Sonic Architecture', pad, H + pad + titleSize * 0.85);
    o.font = `500 ${Math.round(titleSize * 0.45)}px Archivo, "Helvetica Neue", Arial, sans-serif`;
    o.fillStyle = '#E23A12';
    const meta = `${MODE_LABEL[state.mode]} built from ${state.sourceLabel || 'sound'} / ${state.frames.length} layers`;
    o.fillText(meta, pad, H + pad + titleSize * 1.6);
    const tlX = Math.round(W * 0.45), tlW = W - tlX - pad;
    const saved = state.currentFrame;
    state.currentFrame = -1;
    drawTimeline();
    o.drawImage(ui.timeline, tlX, H + pad, tlW, strip - pad * 2);
    state.currentFrame = saved;
    drawTimeline();

    renderer.setPixelRatio(prevRatio);
    resize();
    if (savedFrame >= 0) highlightFrame(savedFrame);
    out.toBlob((blob) => {
      download(blob, `sonic-architecture-${state.mode}-${Date.now()}.png`);
      setStatus('Image saved.');
    }, 'image/png');
  }

  // Bake instanced meshes into plain vertex-coloured meshes so any 3D tool can open the GLB.
  function bakeInstanced(mesh) {
    const geo = mesh.geometry.index ? mesh.geometry.toNonIndexed() : mesh.geometry.clone();
    const pos = geo.attributes.position, nor = geo.attributes.normal;
    const vc = pos.count, n = mesh.count;
    const P = new Float32Array(vc * n * 3), N = new Float32Array(vc * n * 3), C = new Float32Array(vc * n * 3);
    const m = new T.Matrix4(), nm = new T.Matrix3(), v = new T.Vector3();
    const base = mesh.userData.base;
    for (let i = 0; i < n; i++) {
      mesh.getMatrixAt(i, m);
      nm.getNormalMatrix(m);
      for (let k = 0; k < vc; k++) {
        const o = (i * vc + k) * 3;
        v.fromBufferAttribute(pos, k).applyMatrix4(m);
        P[o] = v.x; P[o + 1] = v.y; P[o + 2] = v.z;
        v.fromBufferAttribute(nor, k).applyMatrix3(nm).normalize();
        N[o] = v.x; N[o + 1] = v.y; N[o + 2] = v.z;
        C[o] = base[i * 3]; C[o + 1] = base[i * 3 + 1]; C[o + 2] = base[i * 3 + 2];
      }
    }
    const g = new T.BufferGeometry();
    g.setAttribute('position', new T.BufferAttribute(P, 3));
    g.setAttribute('normal', new T.BufferAttribute(N, 3));
    g.setAttribute('color', new T.BufferAttribute(C, 3));
    const mat = mesh.material.clone();
    mat.vertexColors = true;
    mat.color.set('#ffffff');
    const out = new T.Mesh(g, mat);
    out.name = mesh.name;
    return out;
  }

  function exportGlb() {
    if (!state.frames.length) return;
    setStatus('Preparing 3D model…', { sticky: true });
    setTimeout(() => {
      const group = new T.Group();
      group.name = `sonic_architecture_${state.mode}`;
      INSTANCED.forEach((m) => { if (m.count && m !== bulbs && m !== pools) group.add(bakeInstanced(m)); });
      // City surfaces (plazas, walls, lawns, roads) are exported as they are.
      landscape.children.forEach((m, k) => {
        const c = new T.Mesh(m.geometry.clone(), m.material.clone());
        c.name = `landscape_${k}`;
        group.add(c);
      });
      new T.GLTFExporter().parse(group, (glb) => {
        download(new Blob([glb], { type: 'model/gltf-binary' }), `sonic-architecture-${state.mode}-${Date.now()}.glb`);
        setStatus('3D model saved. Open it in Blender, a 3D viewer, or an AR app.');
        group.children.forEach((c) => { c.geometry.dispose(); c.material.dispose(); });
      }, () => setStatus('Could not create the 3D model.', { error: true }), { binary: true });
    }, 30);
  }

  function download(blob, name) {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 2000);
  }

  /* =========================================================
   * 8. UI WIRING
   * ========================================================= */

  function updateButtons() {
    ui.btnPlay.disabled = !state.buffer || state.recording;
    ui.btnDemo.disabled = state.recording;
    ui.btnSpeed.disabled = state.recording;
    ui.micSelect.disabled = state.recording;
    ui.btnRestart.disabled = state.recording || (!state.allFrames.length && !state.frames.length);
    // Invite a press when a sound is loaded but nothing has been built yet
    ui.btnPlay.classList.toggle('is-ready', !!state.buffer && !state.playing && !state.frames.length);
  }

  function resetCamera() {
    fitGoal = null;
    userCam = false;
    camera.position.set(18, 14, 22);
    controls.target.set(0, 2, 0);
    if (camMode === 'follow') setFollowHome();
  }

  // Back to start: rewind, clear the city, and let it grow again from the first note.
  function restart() {
    if (state.recording) return;
    stopPlayback();
    state.playOffset = 0;
    state.playedUntil = -1;
    state.frames = [];
    state.currentFrame = -1;
    highlightFrame(-1);
    resetCamera();
    rebuild();
    setStatus(state.buffer ? 'Back at the start. Press play to build it again.' : 'Back at the start.');
  }
  ui.btnRestart.addEventListener('click', restart);

  ui.btnRecord.addEventListener('click', () => (state.recording ? stopRecording() : startRecording()));

  ui.fileInput.addEventListener('change', (e) => {
    loadFile(e.target.files[0]);
    e.target.value = '';
  });

  ui.btnDemo.addEventListener('click', async () => {
    stopPlayback();
    setStatus('Synthesising the demo sound…', { sticky: true });
    try {
      ensureAudio();
      const buffer = await makeDemo();
      await useBuffer(buffer, 'Demo sound (synthesised)');
    } catch (err) {
      setStatus(`The demo could not be generated: ${err.message || err}`, { error: true });
    }
  });

  ui.btnPlay.addEventListener('click', () => {
    if (state.playing) stopPlayback(); else { startPlayback(); setStatus(''); }
    updateButtons();
  });
  ui.btnSpeed.addEventListener('click', cycleSpeed);
  ui.btnPng.addEventListener('click', exportPng);
  ui.btnGlb.addEventListener('click', exportGlb);

  document.querySelectorAll('input[name="mode"]').forEach((r) => r.addEventListener('change', () => {
    state.mode = r.value;
    rebuild({ fit: true });
  }));
  ui.btnShuffle.addEventListener('click', () => {
    variation++;
    rebuild({ fit: true });
    setStatus(state.frames.length
      ? `Variation ${variation + 1}: same sound, new layout.`
      : `Variation ${variation + 1} will be used for the next build.`);
  });

  document.querySelectorAll('input[name="palette"]').forEach((r) => r.addEventListener('change', () => {
    state.palette = r.value;
    applyPalette();
    rebuild();
  }));

  let layerTimer = null;
  Object.entries(ui.sliders).forEach(([key, [input, out]]) => {
    const show = () => { out.textContent = key === 'layers' ? input.value : Number(input.value).toFixed(1); };
    show();
    input.addEventListener('input', () => {
      state.params[key] = Number(input.value);
      show();
      if (key === 'layers') {
        clearTimeout(layerTimer);
        layerTimer = setTimeout(() => { if (state.buffer && !state.recording) reanalyse(); }, 250);
      } else if (state.frames.length) {
        rebuild();
      }
    });
  });

  const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)');
  /* Camera: drag to orbit (default), follow the mouse, or spin slowly. */
  let camMode = 'drag';
  const pointer = { x: 0, y: 0, inside: false };
  const followHome = new T.Spherical();
  const _sph = new T.Spherical();
  function setFollowHome() {
    _toCam.subVectors(camera.position, controls.target);
    followHome.setFromVector3(_toCam);
  }
  function setCamMode(mode) {
    camMode = mode;
    controls.autoRotate = mode === 'spin';
    controls.enableRotate = mode !== 'follow';
    if (mode === 'follow') setFollowHome();
  }
  document.querySelectorAll('input[name="cam"]').forEach((r) => r.addEventListener('change', () => setCamMode(r.value)));
  ui.viewport.addEventListener('pointermove', (e) => {
    const r = ui.viewport.getBoundingClientRect();
    pointer.x = clamp(((e.clientX - r.left) / r.width) * 2 - 1, -1, 1);
    pointer.y = clamp(((e.clientY - r.top) / r.height) * 2 - 1, -1, 1);
    pointer.inside = true;
  });
  ui.viewport.addEventListener('pointerleave', () => { pointer.inside = false; });
  // Follow mode: the view swings toward the cursor, up to ±70° around and ±15° up/down.
  function followMouse() {
    if (camMode !== 'follow' || (fitGoal && fitGoal.dir)) return; // only pause while re-orienting to a new form
    _toCam.subVectors(camera.position, controls.target);
    _sph.setFromVector3(_toCam);
    const tx = pointer.inside ? pointer.x : 0, ty = pointer.inside ? pointer.y : 0;
    const theta = followHome.theta - tx * 1.2;
    const phi = clamp(followHome.phi + ty * 0.26, 0.15, Math.PI * 0.48);
    _sph.theta += (theta - _sph.theta) * 0.08;
    _sph.phi += (phi - _sph.phi) * 0.08;
    _toCam.setFromSpherical(_sph);
    camera.position.copy(controls.target).add(_toCam);
  }

  // Timeline: click/drag to jump, arrow keys to step
  let dragging = false;
  ui.timeline.addEventListener('pointerdown', (e) => { dragging = true; ui.timeline.setPointerCapture(e.pointerId); timelinePick(e.clientX); });
  ui.timeline.addEventListener('pointermove', (e) => { if (dragging) timelinePick(e.clientX); });
  ui.timeline.addEventListener('pointerup', () => { dragging = false; });
  ui.timeline.addEventListener('keydown', (e) => {
    const list = timelineFrames(), n = list.length;
    if (!n) return;
    const step = e.shiftKey ? 10 : 1;
    let i = Math.max(0, state.currentFrame);
    if (e.key === 'ArrowRight' || e.key === 'ArrowUp') i = Math.min(n - 1, i + step);
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowDown') i = Math.max(0, i - step);
    else if (e.key === 'Home') i = 0;
    else if (e.key === 'End') i = n - 1;
    else return;
    e.preventDefault();
    if (i < state.frames.length) highlightFrame(i); else state.currentFrame = i;
    if (state.buffer) seekTo(list[i].t);
    drawTimeline();
  });

  // Space toggles playback when not typing in a control
  window.addEventListener('keydown', (e) => {
    if (e.code !== 'Space' || e.repeat) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (['input', 'button', 'select', 'textarea', 'label'].includes(tag) || e.target === ui.timeline) return;
    if (!state.buffer) return;
    e.preventDefault();
    state.playing ? stopPlayback() : startPlayback();
  });

  // Drag & drop
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; document.body.classList.add('is-dragging'); });
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; document.body.classList.remove('is-dragging'); } });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('drop', (e) => {
    e.preventDefault();
    dragDepth = 0;
    document.body.classList.remove('is-dragging');
    const file = e.dataTransfer && e.dataTransfer.files[0];
    if (file) loadFile(file);
  });

  /* =========================================================
   * 9. RENDER LOOP
   * ========================================================= */

  const _toCam = new T.Vector3();
  let lastTimelineFrame = -2;

  function tick() {
    requestAnimationFrame(tick);

    // Ease camera toward the framing goal (snap-ish on rebuild, gentle while growing live)
    if (fitGoal) {
      const k = fitGoal.snap ? 0.12 : 0.05;
      controls.target.lerp(fitGoal.target, k);
      _toCam.subVectors(camera.position, controls.target);
      const d = _toCam.length();
      if (fitGoal.dir) _toCam.normalize().lerp(fitGoal.dir, k * 1.2).normalize().multiplyScalar(d);
      _toCam.setLength(lerp(d, fitGoal.distance, k));
      camera.position.copy(controls.target).add(_toCam);
      const aligned = !fitGoal.dir || _toCam.clone().normalize().dot(fitGoal.dir) > 0.9995;
      if (aligned && Math.abs(d - fitGoal.distance) < 0.05 && controls.target.distanceTo(fitGoal.target) < 0.05) {
        fitGoal = null;
        if (camMode === 'follow') setFollowHome();
      }
    }
    followMouse();
    controls.update();

    if (state.recording) {
      const i = state.frames.length - 1;
      if (i >= 0) highlightFrame(i);
      ui.time.textContent = fmtTime(audioCtx.currentTime - liveStart);
    } else if (state.buffer) {
      const t = currentPlayTime();
      if (growPending && performance.now() - lastGrowBuild > 90) {
        growPending = false; lastGrowBuild = performance.now(); rebuild({ live: true });
      }
      if (state.playing) {
        revealUpTo(t);                 // the city grows only while the sound plays
        highlightFrame(frameAtTime(t));
      }
      ui.time.textContent = `${fmtTime(t)} / ${fmtTime(state.buffer.duration)}`;
    }
    if (state.currentFrame !== lastTimelineFrame) { drawTimeline(); lastTimelineFrame = state.currentFrame; }
    ring.material.opacity = 0.65 + 0.3 * Math.sin(performance.now() / 180);

    if (moon.visible) placeMoon();
    drawSpectrum();
    renderer.render(scene, camera);
  }

  // Keep the moon in the upper-left of the sky, whatever the camera does.
  const _fw = new T.Vector3(), _rt = new T.Vector3();
  function placeMoon() {
    camera.getWorldDirection(_fw);
    _fw.y = 0; _fw.normalize();
    _rt.crossVectors(_fw, camera.up).normalize();
    const vFov = (camera.fov * Math.PI) / 180;
    const pitch = Math.atan2(-(controls.target.y - camera.position.y), Math.hypot(controls.target.x - camera.position.x, controls.target.z - camera.position.z));
    const elev = Math.max(0.12, vFov * 0.3 - pitch); // just below the top edge of the view
    const dist = 300;
    moon.position.copy(camera.position)
      .addScaledVector(_fw, Math.cos(elev) * dist)
      .addScaledVector(_rt, -dist * 0.42 * Math.tan(((camera.fov * camera.aspect) * Math.PI) / 360))
      .setY(camera.position.y + Math.sin(elev) * dist);
  }

  applyPalette();
  resize();
  updateButtons();
  tick();

  // Exposed for automated testing / curious visitors in the console.
  window.sonicArchitecture = { state, rebuild, makeDemo, useBuffer, ensureAudio, restart, revealUpTo, boxes, camera, controls };
})();

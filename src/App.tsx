import { useEffect, useRef, useState } from "react";
import AuthPanel from "./AuthPanel";
import SavePreset, { type DspConfig } from "./SavePreset";

type Wave = "sine" | "square" | "sawtooth" | "triangle";
type Source = "tone" | "mic";
type FilterKind = "none" | "lowpass" | "highpass" | "bandpass" | "notch";

const NOTE_NAMES = ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"];

// Nearest musical note (12-TET, A4 = 440 Hz) for a frequency, plus how far off in cents.
function noteFromFreq(hz: number): { name: string; cents: number } | null {
  if (hz <= 0) return null;
  const semitonesFromA4 = 12 * Math.log2(hz / 440);
  const rounded = Math.round(semitonesFromA4);
  const cents = Math.round((semitonesFromA4 - rounded) * 100);
  const midi = 69 + rounded;
  const name = NOTE_NAMES[((midi % 12) + 12) % 12] + (Math.floor(midi / 12) - 1);
  return { name, cents };
}

// dBFS from time-domain samples (already in [-1, 1]).
function rmsDb(timeData: Float32Array): number {
  let sum = 0;
  for (let i = 0; i < timeData.length; i++) sum += timeData[i] * timeData[i];
  const rms = Math.sqrt(sum / timeData.length);
  return rms > 0 ? Math.max(-60, 20 * Math.log10(rms)) : -60;
}
function peakDb(timeData: Float32Array): number {
  let peak = 0;
  for (let i = 0; i < timeData.length; i++) peak = Math.max(peak, Math.abs(timeData[i]));
  return peak > 0 ? Math.max(-60, 20 * Math.log10(peak)) : -60;
}

// Total harmonic distortion, estimated from the FFT bins: compares the fundamental's amplitude to
// its first few harmonics (2f, 3f, 4f, 5f). AnalyserNode gives magnitude in bytes (0-255) mapped
// linearly between minDecibels/maxDecibels, so we convert back to a linear amplitude before combining.
//
// A loud tone saturates several adjacent bins at the byte ceiling (255), so the bin used to *report*
// the pitch (deliberately the trailing edge of that plateau, to avoid ever reporting a harmonic as the
// pitch) is a bin or two off from the fundamental's true centre. That is fine for a pitch readout, but
// multiplying it by 2-5 for harmonic bins would compound the error and land off the real harmonic peaks
// entirely. So here we re-estimate the fundamental's centre with an amplitude-weighted centroid around
// the reported bin, and widen the harmonic search window with h so a larger multiple tolerates more error.
function estimateThd(freqData: Uint8Array, reportedBin: number, minDb: number, maxDb: number): number | null {
  if (reportedBin < 2) return null;
  const linearOf = (bin: number) => {
    const v = freqData[bin] ?? 0;
    const db = minDb + (v / 255) * (maxDb - minDb);
    return 10 ** (db / 20);
  };
  const localMax = (center: number, span: number) => {
    let best = Math.max(0, Math.min(freqData.length - 1, Math.round(center)));
    for (let d = -span; d <= span; d++) {
      const b = Math.round(center) + d;
      if (b >= 0 && b < freqData.length && freqData[b] > freqData[best]) best = b;
    }
    return best;
  };
  let wSum = 0, vSum = 0;
  for (let d = -3; d <= 3; d++) {
    const b = reportedBin + d;
    if (b < 0 || b >= freqData.length) continue;
    wSum += b * freqData[b];
    vSum += freqData[b];
  }
  const f0 = vSum > 0 ? wSum / vSum : reportedBin;
  const fundamentalBin = localMax(f0, 1);
  // The analyser's dB range is fixed (its ceiling is close to a full-scale tone), so a byte pinned at
  // 255 means the fundamental is clipped in the readout. Any ratio computed against a clipped value
  // would be meaningless, so it is more honest to report "not measurable" than a wrong number.
  if (freqData[fundamentalBin] >= 253) return null;
  const fundamental = linearOf(fundamentalBin);
  if (fundamental <= 0) return null;
  let harmonicPower = 0;
  let any = false;
  for (let h = 2; h <= 5; h++) {
    const center = f0 * h;
    if (center >= freqData.length - 1) break;
    const best = localMax(center, Math.ceil(h * 0.6) + 1);
    harmonicPower += linearOf(best) ** 2;
    any = true;
  }
  if (!any) return null;
  return Math.min(999, (Math.sqrt(harmonicPower) / fundamental) * 100);
}

// simple perceptual-ish colormap for the spectrogram: navy -> cyan -> yellow -> red
function specColor(v: number): string {
  const t = v / 255;
  let r = 0, g = 0, b = 0;
  if (t < 0.25) { const k = t / 0.25; b = Math.round(60 + 160 * k); }
  else if (t < 0.5) { const k = (t - 0.25) / 0.25; g = Math.round(255 * k); b = 220; }
  else if (t < 0.75) { const k = (t - 0.5) / 0.25; r = Math.round(255 * k); g = 255; b = Math.round(220 * (1 - k)); }
  else { const k = (t - 0.75) / 0.25; r = 255; g = Math.round(255 * (1 - k)); }
  return `rgb(${r},${g},${b})`;
}

// AnalyserNode defaults we rely on for converting the display analyser's byte-scaled magnitude back to dB.
const MIN_DB = -100;
const MAX_DB = -30;
// The dedicated THD analyser is given a full-scale ceiling instead, so it does not clip on loud tones.
const THD_MIN_DB = -100;
const THD_MAX_DB = 0;

type Nodes = {
  osc?: OscillatorNode;
  toneGain?: GainNode;
  noiseSrc?: AudioBufferSourceNode;
  noiseGain?: GainNode;
  mix: GainNode;
  filter: BiquadFilterNode;
  analyser: AnalyserNode;
  thdAnalyser: AnalyserNode;
  out?: GainNode;
  mic?: MediaStreamAudioSourceNode;
  stream?: MediaStream;
};

export default function App() {
  const [running, setRunning] = useState(false);
  const [source, setSource] = useState<Source>("tone");
  const [wave, setWave] = useState<Wave>("sine");
  const [freq, setFreq] = useState(440);
  const [tone, setTone] = useState(0.6);
  const [noise, setNoise] = useState(0);
  const [filter, setFilter] = useState<FilterKind>("none");
  const [cutoff, setCutoff] = useState(1000);
  const [q, setQ] = useState(1);
  const [peak, setPeak] = useState(0);
  const [error, setError] = useState("");
  const [levels, setLevels] = useState({ rms: -60, peak: -60 });
  const [thd, setThd] = useState<number | null>(null);
  const [frozen, setFrozen] = useState(false);
  const [measure, setMeasure] = useState<{ x: number; hz: number; db: number } | null>(null);

  const ctxRef = useRef<AudioContext | null>(null);
  const nRef = useRef<Nodes | null>(null);
  const rafRef = useRef<number>(0);
  const startingRef = useRef(false); // a start() call is in flight
  const cancelRef = useRef(false);   // stop() was requested while start() was still waiting
  const timeCanvas = useRef<HTMLCanvasElement>(null);
  const freqCanvas = useRef<HTMLCanvasElement>(null);
  const spectroCanvas = useRef<HTMLCanvasElement>(null);
  const frozenRef = useRef(false);
  const lastFreqData = useRef<Uint8Array | null>(null);
  const lastMaxHz = useRef(8000);

  // live-update continuous params without rebuilding the graph
  useEffect(() => {
    const n = nRef.current, ctx = ctxRef.current;
    if (!n || !ctx) return;
    if (n.osc) { n.osc.type = wave; n.osc.frequency.setTargetAtTime(freq, ctx.currentTime, 0.01); }
    if (n.toneGain) n.toneGain.gain.setTargetAtTime(source === "tone" ? tone : 0, ctx.currentTime, 0.01);
    if (n.noiseGain) n.noiseGain.gain.setTargetAtTime(source === "tone" ? noise : 0, ctx.currentTime, 0.01);
    n.filter.type = (filter === "none" ? "allpass" : filter) as BiquadFilterType;
    n.filter.frequency.setTargetAtTime(cutoff, ctx.currentTime, 0.01);
    n.filter.Q.setTargetAtTime(q, ctx.currentTime, 0.01);
  }, [wave, freq, tone, noise, filter, cutoff, q, source]);

  async function start() {
    // Ignore repeat clicks while a start is in flight or the graph is already running; a second graph would
    // leave the first oscillator playing with no way to stop it.
    if (startingRef.current || nRef.current) return;
    startingRef.current = true;
    cancelRef.current = false;
    setError("");
    try {
      const sc = spectroCanvas.current;
      if (sc) { const sctx = sc.getContext("2d")!; sctx.fillStyle = "#0a0e14"; sctx.fillRect(0, 0, sc.width, sc.height); }
      const ctx = ctxRef.current ?? new (window.AudioContext || (window as any).webkitAudioContext)();
      ctxRef.current = ctx;
      await ctx.resume();
      if (cancelRef.current) return;

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      // A second analyser, purely for the THD readout. It shares the same fft size and bin-to-Hz
      // mapping as the display analyser, but with the ceiling raised to full scale (0 dBFS) instead of
      // the default -30 dBFS, so a loud harmonic-rich tone (e.g. a square wave) does not clip its bins
      // before the harmonic-to-fundamental ratio can be measured.
      const thdAnalyser = ctx.createAnalyser();
      thdAnalyser.fftSize = analyser.fftSize;
      thdAnalyser.smoothingTimeConstant = analyser.smoothingTimeConstant;
      thdAnalyser.minDecibels = THD_MIN_DB;
      thdAnalyser.maxDecibels = THD_MAX_DB;
      const flt = ctx.createBiquadFilter();
      flt.type = (filter === "none" ? "allpass" : filter) as BiquadFilterType;
      flt.frequency.value = cutoff;
      flt.Q.value = q;
      const mix = ctx.createGain();
      mix.connect(flt);
      flt.connect(analyser);
      flt.connect(thdAnalyser);

      const n: Nodes = { mix, filter: flt, analyser, thdAnalyser };

      if (source === "tone") {
        const osc = ctx.createOscillator();
        osc.type = wave;
        osc.frequency.value = freq;
        const toneGain = ctx.createGain();
        toneGain.gain.value = tone;
        osc.connect(toneGain).connect(mix);

        // white-noise generator
        const buf = ctx.createBuffer(1, ctx.sampleRate * 2, ctx.sampleRate);
        const data = buf.getChannelData(0);
        for (let i = 0; i < data.length; i++) data[i] = Math.random() * 2 - 1;
        const noiseSrc = ctx.createBufferSource();
        noiseSrc.buffer = buf;
        noiseSrc.loop = true;
        const noiseGain = ctx.createGain();
        noiseGain.gain.value = noise;
        noiseSrc.connect(noiseGain).connect(mix);

        const out = ctx.createGain();
        out.gain.value = 0.12; // gentle monitoring volume
        analyser.connect(out).connect(ctx.destination);

        osc.start();
        noiseSrc.start();
        Object.assign(n, { osc, toneGain, noiseSrc, noiseGain, out });
      } else {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        if (cancelRef.current) { stream.getTracks().forEach((t) => t.stop()); return; }
        const mic = ctx.createMediaStreamSource(stream);
        mic.connect(mix);
        // NOTE: do not connect analyser -> destination in mic mode (feedback)
        Object.assign(n, { mic, stream });
      }

      nRef.current = n;
      setRunning(true);
      draw();
    } catch (e: any) {
      // Only a mic source can legitimately hit a permission error; never surface it in generator mode.
      if (source === "mic") setError(e?.message || "Microphone blocked. Allow mic access to use this mode.");
      else setError("Could not start audio — try clicking START again.");
      setRunning(false);
    } finally {
      startingRef.current = false;
    }
  }

  function stop() {
    cancelRef.current = true;
    cancelAnimationFrame(rafRef.current);
    const n = nRef.current;
    if (n) {
      try { n.osc?.stop(); } catch {}
      try { n.noiseSrc?.stop(); } catch {}
      n.stream?.getTracks().forEach((t) => t.stop());
      try { n.mix.disconnect(); n.filter.disconnect(); n.analyser.disconnect(); n.thdAnalyser.disconnect(); n.out?.disconnect(); } catch {}
    }
    nRef.current = null;
    setRunning(false);
    setLevels({ rms: -60, peak: -60 });
    setThd(null);
    setPeak(0);
  }

  function toggleFreeze() {
    setFrozen((f) => { frozenRef.current = !f; return !f; });
  }

  // Space toggles start/stop, unless the user is typing somewhere (e.g. renaming a preset).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const el = e.target as HTMLElement | null;
      const typing = el && (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (e.code === "Space" && !typing) {
        e.preventDefault();
        running ? stop() : start();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [running]);

  // Click (or drag) on the spectrum to read off the frequency and level at that point.
  function measureAt(clientX: number, clientY: number) {
    const fc = freqCanvas.current;
    const data = lastFreqData.current;
    if (!fc || !data) return;
    const rect = fc.getBoundingClientRect();
    const x = Math.max(0, Math.min(rect.width, clientX - rect.left));
    const bins = Math.floor((lastMaxHz.current / (ctxRef.current!.sampleRate / 2)) * data.length);
    const bin = Math.min(data.length - 1, Math.round((x / rect.width) * bins));
    const hz = Math.round((bin / data.length) * (ctxRef.current!.sampleRate / 2));
    const db = Math.round(MIN_DB + (data[bin] / 255) * (MAX_DB - MIN_DB));
    setMeasure({ x: (x / rect.width) * fc.width, hz, db });
    void clientY;
  }

  function exportSpectrumPng() {
    const fc = freqCanvas.current;
    if (!fc) return;
    const a = document.createElement("a");
    a.href = fc.toDataURL("image/png");
    a.download = `dsp-spectrum-${Date.now()}.png`;
    a.click();
  }

  function exportSpectrumCsv() {
    const data = lastFreqData.current;
    if (!data || !ctxRef.current) return;
    const nyquist = ctxRef.current.sampleRate / 2;
    let csv = "frequency_hz,magnitude_dbfs\n";
    for (let i = 0; i < data.length; i++) {
      const hz = Math.round((i / data.length) * nyquist);
      const db = Math.round(MIN_DB + (data[i] / 255) * (MAX_DB - MIN_DB));
      csv += `${hz},${db}\n`;
    }
    const blob = new Blob([csv], { type: "text/csv" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `dsp-spectrum-${Date.now()}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  }

  // restart the graph when the source type changes mid-run
  useEffect(() => {
    if (running) { stop(); start(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => () => stop(), []);

  function draw() {
    rafRef.current = requestAnimationFrame(draw);
    if (frozenRef.current) return; // keep the last frame on screen; audio keeps running underneath
    const n = nRef.current, ctx = ctxRef.current;
    if (!n || !ctx) return;
    const analyser = n.analyser;
    const N = analyser.fftSize;
    const timeData = new Float32Array(N);
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);
    setLevels({ rms: rmsDb(timeData), peak: peakDb(timeData) });
    const thdData = new Uint8Array(n.thdAnalyser.frequencyBinCount);
    n.thdAnalyser.getByteFrequencyData(thdData);

    // ---- oscilloscope (time domain) ----
    const tc = timeCanvas.current;
    if (tc) {
      const c = tc.getContext("2d")!;
      const W = tc.width, H = tc.height;
      c.fillStyle = "#0a0e14";
      c.fillRect(0, 0, W, H);
      c.strokeStyle = "rgba(120,140,170,0.12)";
      c.lineWidth = 1;
      for (let x = 0; x <= W; x += W / 10) { c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke(); }
      for (let y = 0; y <= H; y += H / 4) { c.beginPath(); c.moveTo(0, y); c.lineTo(W, y); c.stroke(); }
      c.strokeStyle = "#22d3ee";
      c.lineWidth = 2;
      c.beginPath();
      // Trigger on the first rising zero-crossing so a steady tone holds still instead of drifting.
      const span = Math.min(N / 2, 800);
      let trig = 0;
      for (let i = 1; i < N - span; i++) {
        if (timeData[i - 1] < 0 && timeData[i] >= 0) { trig = i; break; }
      }
      for (let i = 0; i < span; i++) {
        const x = (i / span) * W;
        const y = H / 2 - timeData[trig + i] * (H / 2) * 0.9;
        i === 0 ? c.moveTo(x, y) : c.lineTo(x, y);
      }
      c.stroke();
    }

    // ---- spectrum (frequency domain) ----
    const fc = freqCanvas.current;
    if (fc) {
      const c = fc.getContext("2d")!;
      const W = fc.width, H = fc.height;
      c.fillStyle = "#0a0e14";
      c.fillRect(0, 0, W, H);
      const nyquist = ctx.sampleRate / 2;
      // show up to 8 kHz for readability
      const maxHz = 8000;
      const bins = Math.floor((maxHz / nyquist) * freqData.length);
      // grid + freq labels
      c.fillStyle = "rgba(160,170,190,0.5)";
      c.font = "11px ui-monospace, monospace";
      for (let khz = 0; khz <= 8; khz += 1) {
        const x = (khz * 1000 / maxHz) * W;
        c.strokeStyle = "rgba(120,140,170,0.1)";
        c.beginPath(); c.moveTo(x, 0); c.lineTo(x, H); c.stroke();
        c.fillText(khz + "k", x + 2, H - 4);
      }
      // bars
      let peakBin = 0, peakVal = 0;
      for (let i = 0; i < bins; i++) {
        const v = freqData[i];
        if (v > peakVal) { peakVal = v; peakBin = i; }
        const x = (i / bins) * W;
        const h = (v / 255) * (H - 16);
        const hue = 190 - (v / 255) * 140; // cyan -> magenta at peaks
        c.fillStyle = `hsl(${hue} 90% 55%)`;
        c.fillRect(x, H - 16 - h, Math.max(1, W / bins), h);
      }
      // filter cutoff marker
      if (filter !== "none") {
        const fx = (cutoff / maxHz) * W;
        c.strokeStyle = "#f43f5e";
        c.setLineDash([4, 4]);
        c.beginPath(); c.moveTo(fx, 0); c.lineTo(fx, H); c.stroke();
        c.setLineDash([]);
        c.fillStyle = "#f43f5e";
        c.fillText(`fc ${cutoff}Hz`, fx + 3, 12);
      }
      // Report the fundamental: the lowest strong local peak, within ~12 dB of the tallest (byte scale is 70 dB
      // over 0-255). Then refine with parabolic interpolation, since one FFT bin is about 21 Hz wide.
      let detected = 0;
      if (peakVal > 40) {
        const floor = peakVal - 44;
        let pick = peakBin;
        for (let i = 2; i < bins - 1; i++) {
          if (freqData[i] >= floor && freqData[i] >= freqData[i - 1] && freqData[i] > freqData[i + 1]) { pick = i; break; }
        }
        const a = freqData[pick - 1] ?? 0, b = freqData[pick], c = freqData[pick + 1] ?? 0;
        const denom = a - 2 * b + c;
        const shift = denom !== 0 ? Math.max(-0.5, Math.min(0.5, (0.5 * (a - c)) / denom)) : 0;
        detected = Math.round(((pick + shift) / freqData.length) * nyquist);
        setThd(estimateThd(thdData, pick, THD_MIN_DB, THD_MAX_DB));
      } else {
        setThd(null);
      }
      setPeak(detected);
      lastFreqData.current = freqData;
      lastMaxHz.current = maxHz;

      // ---- spectrogram (scrolling time-vs-frequency waterfall) ----
      const sc = spectroCanvas.current;
      if (sc) {
        const sctx = sc.getContext("2d")!;
        const SW = sc.width, SH = sc.height;
        // shift everything one pixel left, then paint a fresh column at the right edge
        const img = sctx.getImageData(1, 0, SW - 1, SH);
        sctx.putImageData(img, 0, 0);
        for (let y = 0; y < SH; y++) {
          // top of the canvas = high frequency, bottom = low (matches the spectrum view above)
          const bin = Math.floor((1 - y / SH) * bins);
          sctx.fillStyle = specColor(freqData[bin] || 0);
          sctx.fillRect(SW - 1, y, 1, 1);
        }
      }
    }
  }

  return (
    <div className="app">
      <header>
        <div className="mark">Σ<span>ƒ</span></div>
        <div>
          <h1>DSP SIGNAL LAB</h1>
          <p>Real-time Fourier analysis &amp; digital filtering — Web Audio · FFT 2048 · BiquadFilter</p>
        </div>
        <div className="badges">
          <AuthPanel />
          <div className="badge-links">
            <a className="labbench-badge" href="https://labbench-hub.vercel.app/" target="_blank" rel="noopener noreferrer">⚡ LabBench</a>
            <a className="src-link" href="https://dhananjay-kumar-seth.vercel.app/" target="_blank" rel="noopener noreferrer">ECE Portfolio · Dhananjay Seth</a>
          </div>
        </div>
      </header>

      <div className="savebar">
        <SavePreset
          config={{ source, wave, freq, tone, noise, filter, cutoff, q }}
          onLoad={(c: DspConfig) => {
            setSource(c.source); setWave(c.wave); setFreq(c.freq); setTone(c.tone);
            setNoise(c.noise); setFilter(c.filter); setCutoff(c.cutoff); setQ(c.q);
          }}
        />
      </div>

      <div className="scopes">
        <div className="scope">
          <div className="scope-head"><span>◉ TIME DOMAIN</span><small>oscilloscope</small></div>
          <canvas ref={timeCanvas} width={900} height={220} />
          <div className="meters">
            <Meter label="RMS" db={levels.rms} />
            <Meter label="PEAK" db={levels.peak} />
          </div>
        </div>
        <div className="scope">
          <div className="scope-head">
            <span>▲ FREQUENCY DOMAIN</span>
            <small>
              {peak > 0 ? (
                <>
                  fundamental ≈ {peak} Hz
                  {(() => { const n = noteFromFreq(peak); return n ? ` · ${n.name} (${n.cents >= 0 ? "+" : ""}${n.cents}¢)` : ""; })()}
                  {thd !== null ? ` · THD ≈ ${thd < 0.1 ? "<0.1" : thd.toFixed(1)}%` : ""}
                </>
              ) : "FFT magnitude spectrum"}
            </small>
          </div>
          <div
            className="scope-canvas-wrap"
            onMouseMove={(e) => measureAt(e.clientX, e.clientY)}
            onMouseLeave={() => setMeasure(null)}
          >
            <canvas ref={freqCanvas} width={900} height={220} />
            {measure && (
              <div className="measure-line" style={{ left: `${(measure.x / 900) * 100}%` }}>
                <span className="measure-tag">{measure.hz} Hz · {measure.db} dBFS</span>
              </div>
            )}
          </div>
        </div>
        <div className="scope wide">
          <div className="scope-head">
            <span>▦ SPECTROGRAM</span>
            <small>time (scrolling right→left) vs frequency 0–8kHz, color = magnitude</small>
          </div>
          <canvas ref={spectroCanvas} width={900} height={160} />
        </div>
      </div>

      <div className="panel">
        <div className="run">
          {!running ? (
            <button className="go" onClick={start}>▶ START</button>
          ) : (
            <button className="stop" onClick={stop}>■ STOP</button>
          )}
          {running && (
            <button className={"freeze" + (frozen ? " on" : "")} onClick={toggleFreeze} title="Pause the display without stopping the audio">
              {frozen ? "▶ Resume" : "❄ Freeze"}
            </button>
          )}
          <div className="seg">
            <button className={source === "tone" ? "on" : ""} onClick={() => setSource("tone")}>Signal Generator</button>
            <button className={source === "mic" ? "on" : ""} onClick={() => setSource("mic")}>🎤 Microphone</button>
          </div>
          <div className="export-group">
            <button className="ghost-btn" disabled={!running} onClick={exportSpectrumPng} title="Save the current spectrum as an image">⬇ PNG</button>
            <button className="ghost-btn" disabled={!running} onClick={exportSpectrumCsv} title="Save the current spectrum bins as a CSV">⬇ CSV</button>
          </div>
          {error && <span className="err">{error}</span>}
          <span className="kbd-hint">space to start/stop</span>
        </div>

        <div className="controls">
          <fieldset disabled={source === "mic"}>
            <legend>Source Signal</legend>
            <div className="waves">
              {(["sine", "square", "sawtooth", "triangle"] as Wave[]).map((w) => (
                <button key={w} className={wave === w ? "on" : ""} onClick={() => setWave(w)}>{w}</button>
              ))}
            </div>
            <Slider label="Frequency" v={freq} min={20} max={4000} step={1} unit="Hz" on={setFreq} />
            <Slider label="Amplitude" v={tone} min={0} max={1} step={0.01} on={setTone} />
            <Slider label="+ Noise (AWGN)" v={noise} min={0} max={0.6} step={0.01} on={setNoise} />
          </fieldset>

          <fieldset>
            <legend>Digital Filter</legend>
            <div className="waves">
              {(["none", "lowpass", "highpass", "bandpass", "notch"] as FilterKind[]).map((f) => (
                <button key={f} className={filter === f ? "on" : ""} onClick={() => setFilter(f)}>{f}</button>
              ))}
            </div>
            <Slider label="Cutoff / Center" v={cutoff} min={40} max={8000} step={10} unit="Hz" on={setCutoff} disabled={filter === "none"} />
            <Slider label="Q / Resonance" v={q} min={0.1} max={20} step={0.1} on={setQ} disabled={filter === "none" || filter === "lowpass" || filter === "highpass"} />
          </fieldset>
        </div>

        <p className="hint">
          Tip: pick a <b>square</b> wave and watch the odd-harmonic spikes in the spectrum, and the THD readout climb.
          Add noise, then sweep a <b>lowpass</b> cutoff down to watch the high frequencies get attenuated in real time.
          Switch to <b>Microphone</b> and whistle — the peak tracker finds your pitch and the nearest musical note.
          Hover the spectrum to read off any frequency, or hit <b>Freeze</b> to pause it and export a PNG or CSV.
        </p>
      </div>

      <footer>Built with the Web Audio API — no libraries. AnalyserNode performs a real 2048-point FFT every frame.</footer>
    </div>
  );
}

function Meter({ label, db }: { label: string; db: number }) {
  const pct = Math.max(0, Math.min(100, ((db + 60) / 60) * 100));
  const danger = db > -3;
  return (
    <div className="meter-row">
      <span className="meter-label">{label}</span>
      <div className="meter-track"><div className={"meter-fill" + (danger ? " hot" : "")} style={{ width: `${pct}%` }} /></div>
      <span className="meter-val">{db <= -60 ? "-∞" : db.toFixed(1)} dB</span>
    </div>
  );
}

function Slider({ label, v, min, max, step, unit, on, disabled }: {
  label: string; v: number; min: number; max: number; step: number; unit?: string;
  on: (n: number) => void; disabled?: boolean;
}) {
  return (
    <label className={"slider" + (disabled ? " off" : "")}>
      <span className="s-label">{label}</span>
      <input type="range" min={min} max={max} step={step} value={v} disabled={disabled}
        onChange={(e) => on(parseFloat(e.target.value))} />
      <span className="s-val">{v}{unit ? " " + unit : ""}</span>
    </label>
  );
}

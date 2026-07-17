import { useEffect, useRef, useState } from "react";
import AuthPanel from "./AuthPanel";
import SavePreset, { type DspConfig } from "./SavePreset";

type Wave = "sine" | "square" | "sawtooth" | "triangle";
type Source = "tone" | "mic";
type FilterKind = "none" | "lowpass" | "highpass" | "bandpass" | "notch";

type Nodes = {
  osc?: OscillatorNode;
  toneGain?: GainNode;
  noiseSrc?: AudioBufferSourceNode;
  noiseGain?: GainNode;
  mix: GainNode;
  filter: BiquadFilterNode;
  analyser: AnalyserNode;
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

  const ctxRef = useRef<AudioContext | null>(null);
  const nRef = useRef<Nodes | null>(null);
  const rafRef = useRef<number>(0);
  const timeCanvas = useRef<HTMLCanvasElement>(null);
  const freqCanvas = useRef<HTMLCanvasElement>(null);

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
    setError("");
    try {
      const ctx = ctxRef.current ?? new (window.AudioContext || (window as any).webkitAudioContext)();
      ctxRef.current = ctx;
      await ctx.resume();

      const analyser = ctx.createAnalyser();
      analyser.fftSize = 2048;
      analyser.smoothingTimeConstant = 0.75;
      const flt = ctx.createBiquadFilter();
      flt.type = (filter === "none" ? "allpass" : filter) as BiquadFilterType;
      flt.frequency.value = cutoff;
      flt.Q.value = q;
      const mix = ctx.createGain();
      mix.connect(flt);
      flt.connect(analyser);

      const n: Nodes = { mix, filter: flt, analyser };

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
    }
  }

  function stop() {
    cancelAnimationFrame(rafRef.current);
    const n = nRef.current;
    if (n) {
      try { n.osc?.stop(); } catch {}
      try { n.noiseSrc?.stop(); } catch {}
      n.stream?.getTracks().forEach((t) => t.stop());
      try { n.mix.disconnect(); n.filter.disconnect(); n.analyser.disconnect(); n.out?.disconnect(); } catch {}
    }
    nRef.current = null;
    setRunning(false);
  }

  // restart the graph when the source type changes mid-run
  useEffect(() => {
    if (running) { stop(); start(); }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [source]);

  useEffect(() => () => stop(), []);

  function draw() {
    const n = nRef.current, ctx = ctxRef.current;
    if (!n || !ctx) return;
    const analyser = n.analyser;
    const N = analyser.fftSize;
    const timeData = new Float32Array(N);
    const freqData = new Uint8Array(analyser.frequencyBinCount);
    analyser.getFloatTimeDomainData(timeData);
    analyser.getByteFrequencyData(freqData);

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
      const span = Math.min(N, 800);
      for (let i = 0; i < span; i++) {
        const x = (i / span) * W;
        const y = H / 2 - timeData[i] * (H / 2) * 0.9;
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
      const detected = peakVal > 40 ? Math.round((peakBin / freqData.length) * nyquist) : 0;
      setPeak(detected);
    }

    rafRef.current = requestAnimationFrame(draw);
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
        </div>
        <div className="scope">
          <div className="scope-head">
            <span>▲ FREQUENCY DOMAIN</span>
            <small>{peak > 0 ? `peak ≈ ${peak} Hz` : "FFT magnitude spectrum"}</small>
          </div>
          <canvas ref={freqCanvas} width={900} height={220} />
        </div>
      </div>

      <div className="panel">
        <div className="run">
          {!running ? (
            <button className="go" onClick={start}>▶ START</button>
          ) : (
            <button className="stop" onClick={stop}>■ STOP</button>
          )}
          <div className="seg">
            <button className={source === "tone" ? "on" : ""} onClick={() => setSource("tone")}>Signal Generator</button>
            <button className={source === "mic" ? "on" : ""} onClick={() => setSource("mic")}>🎤 Microphone</button>
          </div>
          {error && <span className="err">{error}</span>}
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
          Tip: pick a <b>square</b> wave and watch the odd-harmonic spikes in the spectrum. Add noise, then sweep a
          <b> lowpass</b> cutoff down to watch the high frequencies get attenuated in real time. Switch to
          <b> Microphone</b> and whistle — the peak tracker finds your pitch.
        </p>
      </div>

      <footer>Built with the Web Audio API — no libraries. AnalyserNode performs a real 2048-point FFT every frame.</footer>
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

# DSP Signal Lab

Real-time digital signal processing in the browser — a **2048-point FFT** spectrum analyzer with a
waveform generator, injectable AWGN noise, and live digital filters.

Part of the [LabBench](https://labbench-hub.vercel.app/) suite of interactive engineering tools.

**Live demo:** https://dsp-signal-lab.vercel.app/

## Features
- Time-domain **oscilloscope** + frequency-domain **spectrum** (real FFT via the Web Audio `AnalyserNode`)
- Signal generator: sine / square / sawtooth / triangle, adjustable frequency & amplitude
- Injectable white noise (AWGN) and a live **peak-frequency tracker**
- Digital filters: lowpass / highpass / bandpass / notch (BiquadFilter) with cutoff + Q
- Live **microphone mode** — whistle and watch it find your pitch

## LabBench Pro
Sign in to save and reload your signal-shaping presets (source, waveform, frequency, filter, cutoff, Q) —
part of the same optional ₹29/mo LabBench Pro subscription as the rest of the suite. Upgrade from
[Logic Circuit Simulator](https://logic-circuit-sim.vercel.app/), which hosts the checkout for all 7 tools.

## Tech
React + TypeScript + Vite. No runtime libraries — all signal processing via the native Web Audio API.
Auth/save-load via Supabase (Postgres + RLS).

## Run locally
```sh
npm install
npm run dev
```

_Built by Dhananjay Kumar Seth — ECE portfolio._

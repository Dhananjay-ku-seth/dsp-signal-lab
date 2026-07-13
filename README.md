# DSP Signal Lab

Real-time digital signal processing in the browser — a **2048-point FFT** spectrum analyzer with a
waveform generator, injectable AWGN noise, and live digital filters.

**Live demo:** _add your Vercel URL here_

## Features
- Time-domain **oscilloscope** + frequency-domain **spectrum** (real FFT via the Web Audio `AnalyserNode`)
- Signal generator: sine / square / sawtooth / triangle, adjustable frequency & amplitude
- Injectable white noise (AWGN) and a live **peak-frequency tracker**
- Digital filters: lowpass / highpass / bandpass / notch (BiquadFilter) with cutoff + Q
- Live **microphone mode** — whistle and watch it find your pitch

## Tech
React + TypeScript + Vite. No runtime libraries — all signal processing via the native Web Audio API.

## Run locally
```sh
npm install
npm run dev
```

_Built by Dhananjay Kumar Seth — ECE portfolio._

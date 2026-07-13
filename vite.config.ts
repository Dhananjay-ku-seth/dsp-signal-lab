import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// DSP Signal Lab — real-time FFT + filters (portfolio demo)
export default defineConfig({
  server: { host: "::", port: 5181 },
  plugins: [react()],
});

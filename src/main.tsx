import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import "./index.css";

// NOTE: StrictMode intentionally double-invokes effects in dev, which double-builds
// the imperative Web Audio graph and can trip a phantom getUserMedia call. Audio/canvas
// apps with imperative setup are a well-known exception where it's omitted.
ReactDOM.createRoot(document.getElementById("root")!).render(<App />);

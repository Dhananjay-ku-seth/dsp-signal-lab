import { useState } from "react";
import { supabase } from "./supabaseClient";
import { useAuth } from "./useAuth";

export default function AuthPanel() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<"in" | "up">("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    // NOTE: must call supabase.auth.signUp(...)/.signInWithPassword(...) directly — extracting
    // either as a bare function reference loses the `this` binding GoTrueClient relies on
    // internally and the call fails before ever reaching the network.
    const { error } = mode === "up"
      ? await supabase.auth.signUp({ email, password })
      : await supabase.auth.signInWithPassword({ email, password });
    setBusy(false);
    if (error) {
      setMsg(error.message);
    } else if (mode === "up") {
      setMsg("Check your email to confirm your account, then sign in.");
    } else {
      setOpen(false);
      setEmail("");
      setPassword("");
    }
  }

  async function signOut() {
    await supabase.auth.signOut();
  }

  if (loading) return null;

  if (user) {
    return (
      <div className="auth-chip">
        <span className="auth-email">{user.email}</span>
        <button className="auth-btn" onClick={signOut}>Sign out</button>
      </div>
    );
  }

  return (
    <div className="auth-wrap">
      <button className="auth-btn" onClick={() => setOpen((o) => !o)}>
        {open ? "Close" : "Sign in / Sign up"}
      </button>
      {open && (
        <form className="auth-panel" onSubmit={submit}>
          <div className="auth-tabs">
            <button type="button" className={mode === "in" ? "on" : ""} onClick={() => setMode("in")}>Sign in</button>
            <button type="button" className={mode === "up" ? "on" : ""} onClick={() => setMode("up")}>Sign up</button>
          </div>
          <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <input type="password" placeholder="Password (min 6 chars)" value={password} onChange={(e) => setPassword(e.target.value)} minLength={6} required />
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "..." : mode === "up" ? "Create account" : "Sign in"}
          </button>
          {msg && <p className="auth-msg">{msg}</p>}
        </form>
      )}
    </div>
  );
}

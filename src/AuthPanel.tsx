import { useEffect, useState } from "react";
import { supabase } from "./supabaseClient";
import { useAuth } from "./useAuth";

type Mode = "in" | "up" | "forgot" | "reset";

export default function AuthPanel() {
  const { user, loading } = useAuth();
  const [open, setOpen] = useState(false);
  const [mode, setMode] = useState<Mode>("in");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // The link in a password-reset email signs the user in with a recovery session and fires this event.
  // Show the "choose a new password" form instead of the normal signed-in chip.
  useEffect(() => {
    const { data } = supabase.auth.onAuthStateChange((event) => {
      if (event === "PASSWORD_RECOVERY") {
        setMode("reset");
        setOpen(true);
        setMsg("Choose a new password.");
      }
    });
    return () => data.subscription.unsubscribe();
  }, []);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    // NOTE: must call supabase.auth.signUp(...)/.signInWithPassword(...) directly — extracting
    // either as a bare function reference loses the `this` binding GoTrueClient relies on
    // internally and the call fails before ever reaching the network.
    if (mode === "forgot") {
      const { error } = await supabase.auth.resetPasswordForEmail(email, { redirectTo: window.location.origin });
      setBusy(false);
      setMsg(error ? error.message : "If that email has an account, a reset link is on its way.");
      return;
    }
    if (mode === "reset") {
      const { error } = await supabase.auth.updateUser({ password });
      setBusy(false);
      if (error) {
        setMsg(error.message);
      } else {
        setMode("in");
        setOpen(false);
        setPassword("");
        setMsg(null);
      }
      return;
    }
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

  if (user && mode !== "reset") {
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
          {(mode === "in" || mode === "up") && (
            <div className="auth-tabs">
              <button type="button" className={mode === "in" ? "on" : ""} onClick={() => { setMode("in"); setMsg(null); }}>Sign in</button>
              <button type="button" className={mode === "up" ? "on" : ""} onClick={() => { setMode("up"); setMsg(null); }}>Sign up</button>
            </div>
          )}
          {mode !== "reset" && (
            <input type="email" placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} required />
          )}
          {mode !== "forgot" && (
            <input
              type="password"
              placeholder={mode === "reset" ? "New password (min 6 chars)" : "Password (min 6 chars)"}
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          )}
          <button type="submit" className="auth-submit" disabled={busy}>
            {busy ? "..." : mode === "up" ? "Create account" : mode === "forgot" ? "Send reset link" : mode === "reset" ? "Save new password" : "Sign in"}
          </button>
          {mode === "in" && (
            <button type="button" className="auth-link" onClick={() => { setMode("forgot"); setMsg(null); }}>Forgot password?</button>
          )}
          {mode === "forgot" && (
            <button type="button" className="auth-link" onClick={() => { setMode("in"); setMsg(null); }}>Back to sign in</button>
          )}
          {msg && <p className="auth-msg">{msg}</p>}
        </form>
      )}
    </div>
  );
}

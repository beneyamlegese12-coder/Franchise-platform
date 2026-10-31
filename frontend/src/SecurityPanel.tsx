import { useState } from "react";
import type { FormEvent } from "react";
import { api, errText } from "./api";

export type Me = {
  id: number; role: string; username: string; name: string;
  totp_enabled: boolean; must_change_password: boolean; needs_2fa_setup: boolean;
};

export function ChangePassword({ forced, onDone }: { forced?: boolean; onDone: () => void }) {
  const [f, setF] = useState({ cur: "", next: "", again: "" });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setMsg(""); setOk("");
    if (f.next !== f.again) { setMsg("The two new passwords do not match"); return; }
    setBusy(true);
    try {
      await api.post("/auth/change-password", { current_password: f.cur, new_password: f.next });
      setOk("Password changed.");
      setF({ cur: "", next: "", again: "" });
      onDone();
    } catch (err) {
      setMsg(errText(err));
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit}>
      <h2>{forced ? "Choose a new password" : "Change password"}</h2>
      {forced && <p className="note">Your password was set by someone else. Choose your own before you continue.</p>}
      <p className="note">At least 10 characters, with an uppercase letter, a lowercase letter and a number.</p>
      <label htmlFor="cp1">Current password</label>
      <input id="cp1" type="password" value={f.cur} onChange={(e) => setF({ ...f, cur: e.target.value })} />
      <label htmlFor="cp2">New password</label>
      <input id="cp2" type="password" value={f.next} onChange={(e) => setF({ ...f, next: e.target.value })} />
      <label htmlFor="cp3">New password again</label>
      <input id="cp3" type="password" value={f.again} onChange={(e) => setF({ ...f, again: e.target.value })} />
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g">{ok}</p>}
      <button className="btn" disabled={busy || !f.cur || !f.next || !f.again}>{busy ? "Saving..." : "Change password"}</button>
    </form>
  );
}

export function TwoFactor({ me, forced, onDone }: { me: Me; forced?: boolean; onDone: () => void }) {
  const [setup, setSetup] = useState<{ secret: string; qr: string } | null>(null);
  const [code, setCode] = useState("");
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState(false);

  async function start() {
    setMsg("");
    try { setSetup((await api.post("/auth/2fa/setup")).data); } catch (e) { setMsg(errText(e)); }
  }
  async function enable(e: FormEvent) {
    e.preventDefault(); setMsg(""); setBusy(true);
    try { await api.post("/auth/2fa/enable", { code }); setSetup(null); setCode(""); onDone(); }
    catch (err) { setMsg(errText(err)); } finally { setBusy(false); }
  }
  async function disable(e: FormEvent) {
    e.preventDefault(); setMsg(""); setBusy(true);
    try { await api.post("/auth/2fa/disable", { password: pw, code }); setCode(""); setPw(""); onDone(); }
    catch (err) { setMsg(errText(err)); } finally { setBusy(false); }
  }

  if (me.totp_enabled) {
    return (
      <form onSubmit={disable}>
        <h2>Two-factor authentication</h2>
        <p className="g">On. You need a code from your authenticator app each time you sign in.</p>
        <p className="note top">To turn it off, enter your password and a fresh code.</p>
        <label htmlFor="d1">Password</label>
        <input id="d1" type="password" value={pw} onChange={(e) => setPw(e.target.value)} />
        <label htmlFor="d2">Code from your app</label>
        <input id="d2" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
        {msg && <p className="err">{msg}</p>}
        <button className="btn ghost" disabled={busy || !pw || code.length !== 6}>Turn off</button>
      </form>
    );
  }

  return (
    <div>
      <h2>{forced ? "Set up two-factor authentication" : "Two-factor authentication"}</h2>
      {forced && <p className="note">Your role needs two-factor authentication before you can continue.</p>}
      {!setup ? (
        <>
          <p className="note">Off. Use an authenticator app such as Google Authenticator, Microsoft Authenticator or Authy.</p>
          {msg && <p className="err">{msg}</p>}
          <button className="btn top" onClick={start}>Set up</button>
        </>
      ) : (
        <form onSubmit={enable}>
          <p className="note">1. Scan this with your authenticator app.</p>
          <img src={setup.qr} alt="QR code for your authenticator app" width={200} height={200} style={{ background: "#fff", padding: 8, borderRadius: 8, margin: "8px 0" }} />
          <p className="note">Cannot scan? Enter this key by hand:</p>
          <p style={{ fontFamily: "ui-monospace,Consolas,monospace", wordBreak: "break-all" }}>{setup.secret}</p>
          <p className="note top">2. Enter the 6-digit code the app shows.</p>
          <label htmlFor="e1">Code</label>
          <input id="e1" inputMode="numeric" maxLength={6} value={code} onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} autoFocus />
          {msg && <p className="err">{msg}</p>}
          <button className="btn" disabled={busy || code.length !== 6}>{busy ? "Checking..." : "Turn on"}</button>
        </form>
      )}
    </div>
  );
}

export default function SecurityPanel({ me, refresh }: { me: Me; refresh: () => void }) {
  return (
    <div className="wrap narrow">
      <h1>Security</h1>
      <p className="note">Signed in as {me.username}</p>
      <div className="card top"><ChangePassword onDone={refresh} /></div>
      <div className="card top"><TwoFactor me={me} onDone={refresh} /></div>
    </div>
  );
}
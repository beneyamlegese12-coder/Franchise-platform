import { useState } from "react";
import type { FormEvent } from "react";
import { api, errText } from "./api";
import type { User } from "./App";
import { Brand } from "./Brand";

export default function StaffLogin({ onDone }: { onDone: (u: User) => void }) {
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      const { data } = await api.post("/auth/login", { phone: username, password, code: needCode ? code : undefined });
      if (data.need_code) { setNeedCode(true); return; }
      localStorage.setItem("token", data.token);
      localStorage.setItem("user", JSON.stringify(data.user));
      onDone(data.user);
    } catch (err) {
      setError(errText(err));
      if (needCode) setCode("");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="st-page">
      <div className="st-pill">
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" aria-hidden="true"><path d="M12 3l8 3v6c0 5-3.5 8-8 9-4.5-1-8-4-8-9V6z" /></svg>
        MANAGEMENT PORTAL
      </div>
      <form className="st-card" onSubmit={submit}>
        <span className="st-tag">STAFF CONSOLE</span>
        <div className="st-head">
          <Brand />
          <h1>Management &amp; Hierarchy Portal</h1>
          <p>Admin, Super Agent &amp; Agent commission and player management</p>
        </div>
        <div className="st-strip">SECURE ADMIN / AGENT CREDENTIAL VALIDATOR</div>
        <div className="st-body">
          <label htmlFor="su">PHONE NUMBER</label>
          <input id="su" type="tel" inputMode="tel" autoComplete="tel" placeholder="e.g. 0912345678" value={username} disabled={needCode} onChange={(e) => setUsername(e.target.value)} autoFocus />
          <label htmlFor="sp">PASSWORD</label>
          <input id="sp" type="password" autoComplete="current-password" placeholder="Enter your password" value={password} disabled={needCode} onChange={(e) => setPassword(e.target.value)} />
          {needCode && (
            <>
              <label htmlFor="sc">AUTHENTICATOR CODE</label>
              <input id="sc" inputMode="numeric" maxLength={6} placeholder="6-digit code" value={code} autoFocus onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
            </>
          )}
          {error && <p className="err">{error}</p>}
          <button className="st-btn" disabled={busy || !username || !password || (needCode && code.length !== 6)}>
            {busy ? "CHECKING..." : needCode ? "VERIFY CODE" : "AUTHENTICATE SESSION"}
          </button>
        </div>
      </form>
    </div>
  );
}
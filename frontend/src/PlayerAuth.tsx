import { useEffect, useState } from "react";
import type { FormEvent } from "react";
import { api, errText } from "./api";

export function PlayerAuth({ start, onDone, onClose }: { start: "login" | "register"; onDone: () => void; onClose: () => void }) {
  const [mode, setMode] = useState(start);
  const [username, setUsername] = useState("");
  const [name, setName] = useState("");
  const [password, setPassword] = useState("");
  const [dob, setDob] = useState("");
  const [code, setCode] = useState("");
  const [needCode, setNeedCode] = useState(false);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);

  function save(data: { token: string; user: unknown }) {
    localStorage.setItem("token", data.token);
    localStorage.setItem("user", JSON.stringify(data.user));
    onDone();
  }

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError("");
    setBusy(true);
    try {
      if (mode === "login") {
        const { data } = await api.post("/auth/login", { phone: username.trim(), password, code: needCode ? code : undefined });
        if (data.need_code) { setNeedCode(true); return; }
        save(data);
      } else {
        const { data } = await api.post("/auth/register", { phone: username.trim(), display_name: name, password, date_of_birth: dob });
        save(data);
      }
    } catch (err) {
      setError(errText(err));
      if (needCode) setCode("");
    } finally {
      setBusy(false);
    }
  }

  const reg = mode === "register";
  const ok = username && password && (!reg || (name && dob)) && (!needCode || code.length === 6);
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label="Sign in or register" onClick={onClose}>
      <form className="card" onClick={(e) => e.stopPropagation()} onSubmit={submit}>
        <div className="pills" role="tablist">
          <button type="button" role="tab" aria-selected={!reg} className={"fpill" + (!reg ? " on" : "")} onClick={() => { setMode("login"); setError(""); }}>Sign in</button>
          <button type="button" role="tab" aria-selected={reg} className={"fpill" + (reg ? " on" : "")} onClick={() => { setMode("register"); setError(""); setNeedCode(false); }}>Create account</button>
        </div>
        <p className="note top">{reg ? "Create your account to start playing." : "Sign in to launch this game."}</p>
        {reg && (
          <>
            <label htmlFor="pn">Your name</label>
            <input id="pn" autoComplete="name" value={name} onChange={(e) => setName(e.target.value)} />
          </>
        )}
        <label htmlFor="pu">Phone number</label>
        <input id="pu" type="tel" inputMode="tel" autoComplete="tel" placeholder="0912345678" value={username} disabled={needCode} onChange={(e) => setUsername(e.target.value)} autoFocus />
        {reg && <p className="note">Your Ethiopian mobile number. You will use it to sign in.</p>}
        <label htmlFor="pp">Password</label>
        <input id="pp" type="password" autoComplete={reg ? "new-password" : "current-password"} value={password} disabled={needCode} onChange={(e) => setPassword(e.target.value)} />
        {reg && <p className="note">At least 10 characters, with upper case, lower case and a number.</p>}
        {reg && (
          <>
            <label htmlFor="pd">Date of birth</label>
            <input id="pd" type="date" autoComplete="bday" value={dob} onChange={(e) => setDob(e.target.value)} />
            <p className="note">You must be 18 or older. Your club agent may ask to check your ID.</p>
          </>
        )}
        {needCode && (
          <>
            <label htmlFor="pc">Code from your authenticator app</label>
            <input id="pc" inputMode="numeric" maxLength={6} value={code} autoFocus onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </>
        )}
        {error && <p className="err">{error}</p>}
        <button className="btn full" disabled={busy || !ok}>{busy ? "Please wait..." : reg ? "Create account" : needCode ? "Verify" : "Sign in"}</button>
        <button type="button" className="btn ghost full" onClick={onClose}>Cancel</button>
      </form>
    </div>
  );
}
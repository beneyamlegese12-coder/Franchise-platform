import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { api, errText } from "./api";
import Portal from "./SuperConsole";
import ClubPortal from "./ClubPortal";
import AdminPortal from "./AdminConsole";
import PlayerApp from "./PlayerApp";
import StaffLogin from "./StaffLogin";
import SecurityPanel, { ChangePassword, TwoFactor } from "./SecurityPanel";
import type { Me } from "./SecurityPanel";

export type User = { id: number; role: string; username: string; name: string };

function readUser(): User | null {
  try {
    return JSON.parse(localStorage.getItem("user") || "null");
  } catch {
    return null;
  }
}

function Login({ onDone }: { onDone: (u: User) => void }) {
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
    <div className="login">
      <form className="card" onSubmit={submit}>
        <div className="tag">FRANCHISE PORTAL</div>
        <h1>Sign in</h1>
        <label htmlFor="u">Phone number</label>
        <input id="u" type="tel" inputMode="tel" autoComplete="tel" placeholder="0912345678" value={username} disabled={needCode} onChange={(e) => setUsername(e.target.value)} autoFocus />
        <label htmlFor="p">Password</label>
        <input id="p" type="password" value={password} disabled={needCode} onChange={(e) => setPassword(e.target.value)} />
        {needCode && (
          <>
            <label htmlFor="c">Code from your authenticator app</label>
            <input id="c" inputMode="numeric" maxLength={6} value={code} autoFocus onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))} />
          </>
        )}
        {error && <p className="err">{error}</p>}
        <button className="btn" disabled={busy || !username || !password || (needCode && code.length !== 6)}>
          {busy ? "Signing in..." : needCode ? "Verify" : "Sign in"}
        </button>
      </form>
    </div>
  );
}

function Gate({ children, onLogout }: { children: ReactNode; onLogout: () => void }) {
  return (
    <div className="login">
      <div className="card" style={{ maxWidth: 460 }}>
        {children}
        <button className="btn ghost" onClick={onLogout}>Log out</button>
      </div>
    </div>
  );
}

const LoginSwitch = (p: { onDone: (u: User) => void }) => import.meta.env.MODE === "staff" ? <StaffLogin {...p} /> : <Login {...p} />;

export default function App({ onLoggedOut }: { onLoggedOut?: () => void }) {
  const [user, setUser] = useState<User | null>(readUser());
  const [me, setMe] = useState<Me | null>(null);
  const [meErr, setMeErr] = useState("");
  const [view, setView] = useState<"portal" | "security">("portal");

  const refresh = useCallback(() => {
    api.get("/auth/me").then((r) => { setMe(r.data); setMeErr(""); }).catch((e) => setMeErr(errText(e)));
  }, []);

  useEffect(() => {
    if (user && localStorage.getItem("token")) refresh();
    else setMe(null);
  }, [user, refresh]);

  const logout = () => {
    localStorage.removeItem("token");
    localStorage.removeItem("user");
    setMe(null);
    setMeErr("");
    setView("portal");
    setUser(null); onLoggedOut?.();
  };

  if (!user || !localStorage.getItem("token")) return <LoginSwitch onDone={(u) => { setView("portal"); setUser(u); }} />;
  if (meErr) return <Gate onLogout={logout}><p className="err">{meErr}</p></Gate>;
  if (!me) return <div className="login"><p className="note">Loading...</p></div>;
  if (me.must_change_password) return <Gate onLogout={logout}><ChangePassword forced onDone={refresh} /></Gate>;
  if (me.needs_2fa_setup) return <Gate onLogout={logout}><TwoFactor me={me} forced onDone={refresh} /></Gate>;

  const props = { user, onLogout: logout };
  const portal =
    user.role === "admin" ? <AdminPortal {...props} /> :
    user.role === "club" ? <ClubPortal {...props} /> :
    user.role === "player" ? <PlayerApp {...props} /> :
    <Portal {...props} />;

  return (
    <>
      <div className="secbar">
        <span className="note">{me.username}</span>
        <button className="btn ghost" onClick={() => setView(view === "security" ? "portal" : "security")}>
          {view === "security" ? "Back" : "Security"}
        </button>
      </div>
      {view === "security" ? <SecurityPanel me={me} refresh={refresh} /> : portal}
    </>
  );
}
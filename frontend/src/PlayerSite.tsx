import { useState } from "react";
import App from "./App";
import { GamesTab } from "./GamesLobby";
import { PlayerAuth } from "./PlayerAuth";
import { Brand } from "./Brand";

function hasPlayerSession() {
  try {
    const u = JSON.parse(localStorage.getItem("user") || "null");
    return !!localStorage.getItem("token") && u?.role === "player";
  } catch {
    return false;
  }
}

export default function PlayerSite() {
  const [authed, setAuthed] = useState(hasPlayerSession());
  const [modal, setModal] = useState<"login" | "register" | null>(null);

  if (authed) return <App onLoggedOut={() => setAuthed(false)} />;
  return (
    <div className="wrap">
      <div className="pubbar">
        <Brand small />
        <div className="pubbtns">
          <button className="btn ghost" onClick={() => setModal("login")}>Sign in</button>
          <button className="btn" onClick={() => setModal("register")}>Register</button>
        </div>
      </div>
      <GamesTab onNeedLogin={() => setModal("login")} />
      {modal && <PlayerAuth start={modal} onClose={() => setModal(null)} onDone={() => { setModal(null); setAuthed(true); }} />}
    </div>
  );
}
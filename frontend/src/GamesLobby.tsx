import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

type Game = { id: number; slug: string; title: string; category: string; provider: string; gateway: boolean; rtp_bps: number; volatility: string; theme: string };
type Round = { bet_minor: number; win_minor: number; balance_minor: number; result: string };

const CATS = ["All", "Slots", "Live Casino", "Sportsbook", "Crash Games", "Table Games"];
const VOL: Record<string, string> = { High: "r", Medium: "y", Low: "g" };
const badge = (g: Game) => g.provider.toUpperCase() + (g.gateway ? " SINGLE-API GATEWAY" : "");

function PlayModal({ game, demo, onClose }: { game: Game; demo: boolean; onClose: () => void }) {
  const qc = useQueryClient();
  const { data: ov } = useQuery<{ credit_balance_minor: number }>({ queryKey: ["pl-overview"], queryFn: async () => (await api.get("/player/overview")).data });
  const [stake, setStake] = useState("5");
  const [round, setRound] = useState<Round | null>(null);
  const [err, setErr] = useState("");
  const play = useMutation({
    mutationFn: async () => (await api.post("/games/" + game.id + "/demo-round", { amount_minor: Math.round(parseFloat(stake) * 100) })).data as Round,
    onSuccess: (r) => { setErr(""); setRound(r); ["pl-overview", "pl-ledger", "pl-limits"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => { setRound(null); setErr(errText(e)); },
  });
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const v = Math.round(parseFloat(stake) * 100);
  const bal = round ? round.balance_minor : ov?.credit_balance_minor;
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={game.title} onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className={"gtop mini t-" + game.theme}><span className="gbadge">{badge(game)}</span><h3>{game.title}</h3></div>
        {!demo ? (
          <p className="note top">A game provider is not connected yet, so this game cannot be played.</p>
        ) : (
          <>
            <p className="note top">Demo round. This is not a real provider game, but the bet and any win are recorded in your wallet like real ones.</p>
            <p className="lbl top">Your balance</p>
            <p className="big y">{bal === undefined ? "..." : money(bal)}</p>
            <form onSubmit={(e) => { e.preventDefault(); play.mutate(); }}>
              <label htmlFor="stake">Stake ($)</label>
              <input id="stake" type="number" inputMode="decimal" min="1" step="0.01" value={stake} onChange={(e) => { setRound(null); setStake(e.target.value); }} />
              <button className="btn full" disabled={!(v >= 100) || play.isPending}>{play.isPending ? "Playing..." : "Play one round"}</button>
            </form>
            {err && <p className="err">{err}</p>}
            {round && (
              <p className={"big " + (round.result === "win" ? "g" : "r")} style={{ marginTop: 12 }}>
                {round.result === "win" ? "You won " + money(round.win_minor) : "No win this time (-" + money(round.bet_minor) + ")"}
              </p>
            )}
          </>
        )}
        <button className="btn ghost full" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

export function GamesTab({ onNeedLogin }: { onNeedLogin?: () => void }) {
  const { data = [], isLoading, error } = useQuery<Game[]>({ queryKey: ["games"], queryFn: async () => (await api.get("/games")).data });
  const [cat, setCat] = useState("All");
  const [q, setQ] = useState("");
  const [prov, setProv] = useState("");
  const [open, setOpen] = useState<{ game: Game; demo: boolean } | null>(null);
  const [msg, setMsg] = useState("");
  const [busy, setBusy] = useState<number | null>(null);

  const providers = Array.from(new Set(data.map((g) => g.provider))).sort();
  const needle = q.trim().toLowerCase();
  const shown = data.filter((g) =>
    (cat === "All" || g.category === cat) &&
    (!prov || g.provider === prov) &&
    (!needle || (g.title + " " + g.category + " " + g.provider).toLowerCase().includes(needle))
  );

  async function launch(g: Game) {
    if (onNeedLogin && !localStorage.getItem("token")) { onNeedLogin(); return; }
    setMsg(""); setBusy(g.id);
    try {
      const { data: r } = await api.post("/games/" + g.id + "/launch");
      setOpen({ game: g, demo: r.demo });
    } catch (e) {
      setMsg(errText(e));
    } finally {
      setBusy(null);
    }
  }

  if (isLoading) return <p className="note">Loading...</p>;
  if (error) return <p className="err">Could not load the games.</p>;
  return (
    <>
      <div className="fbar">
        <div className="pills" role="tablist" aria-label="Game categories">
          {CATS.map((c) => (
            <button key={c} role="tab" aria-selected={c === cat} className={"fpill" + (c === cat ? " on" : "")} onClick={() => setCat(c)}>{c}</button>
          ))}
        </div>
        <div className="fright">
          <input aria-label="Search games" className="fsearch" placeholder="Search slots, sports..." value={q} onChange={(e) => setQ(e.target.value)} />
          <select aria-label="Provider" className="fsel" value={prov} onChange={(e) => setProv(e.target.value)}>
            <option value="">All Providers</option>
            {providers.map((p) => <option key={p} value={p}>{p}</option>)}
          </select>
        </div>
      </div>
      {msg && <p className="err">{msg}</p>}
      {shown.length === 0 ? <p className="note top">No games match your filters.</p> : (
        <div className="ggrid">
          {shown.map((g) => (
            <div className="gcard" key={g.id}>
              <div className={"gtop t-" + g.theme}><span className="gbadge">{badge(g)}</span><h3>{g.title}</h3></div>
              <div className="gbody">
                <div className="grow"><span className="gl">Category:</span><b>{g.category}</b></div>
                <div className="grow mono"><span className="gl">RTP Rating:</span><span className="g">{(g.rtp_bps / 100).toFixed(1)}% RTP</span></div>
                <div className="grow"><span className="gl">Volatility:</span><b className={VOL[g.volatility]}>{g.volatility}</b></div>
                <button className="gbtn" disabled={busy === g.id} onClick={() => launch(g)}>&#9654; {busy === g.id ? "CHECKING..." : "LAUNCH GAME"}</button>
              </div>
            </div>
          ))}
        </div>
      )}
      {open && <PlayModal game={open.game} demo={open.demo} onClose={() => setOpen(null)} />}
    </>
  );
}
import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";
import type { User } from "./App";
import { RatesTab, ChecksTab } from "./AdminPortal";
import { ReversalsTab, SettlementTab } from "./AdminMoney";
import { GamesTab as GamesStatsTab } from "./AdminGames";
import { ChannelsTab } from "./ClubQueue";
import { PointPool } from "./Points";
import { MoveCards } from "./Network";

type Op = { id: number; kind: string; memo: string | null; created_at: string; amount_minor: number; sender: string | null; receiver: string | null };
type Dash = {
  turnover_minor: number; wins_minor: number; ggr_minor: number; minted_minor: number;
  royalty: { betting_minor: number; deposit_minor: number; withdrawal_minor: number };
  fee_range: { lo_bps: number; hi_bps: number };
  network: { super_agents: number; club_agents: number; players: number };
  pending_requests: number; pending_point_asks: number;
  verticals: { category: string; bets: number; turnover_minor: number; ggr_minor: number }[];
  timeline: { day: string; ggr_minor: number }[];
  supers: { id: number; name: string; phone: string | null; dep_bps: number; wd_bps: number; balance_minor: number }[];
  ledger: Op[];
  api: { games_url: string; wallet_url: string };
};
type CashRow = { id: number; type: string; amount_minor: number; channel: string | null; created_at: string; player: string; player_id: number; club: string | null; status: string; reference: string | null; phone: string | null; account: string | null };
type Prov = { id: number; code: string; name: string; category: string; api_endpoint: string; fee_bps: number; status: string; latency_ms: number | null; last_ping_at: string | null; games: number };
type DirRow = { id: number; role: string; username: string; phone: string | null; name: string; status: string; parent: string | null; balance_minor: number | null; dep_bps: number | null; dep_cap_bps: number | null; wd_bps: number | null; wd_cap_bps: number | null; cbe_account: string | null };

const when = (s: string) => new Date(s).toLocaleString();
const kindLabel = (k: string) => k.replace(/_/g, " ").toUpperCase();
const pct = (b: number | null) => (b === null ? "-" : b / 100 + "%");
const ROLE: Record<string, string> = { super: "SUPER AGENT", club: "AGENT", player: "PLAYER" };
const TypePill = ({ t }: { t: string }) => <span className={"tpill " + (t === "deposit" ? "tdep" : "twd")}>{t.toUpperCase()}</span>;

function useDash() {
  return useQuery<Dash>({ queryKey: ["adm-dash"], queryFn: async () => (await api.get("/admin/dashboard")).data, refetchInterval: 10000 });
}

function Spark({ points }: { points: number[] }) {
  if (points.length < 2) return <p className="note">Not enough betting data yet.</p>;
  const w = 460, h = 110;
  const min = Math.min(0, ...points), max = Math.max(0, ...points);
  const span = max - min || 1;
  const x = (i: number) => (i / (points.length - 1)) * w;
  const y = (v: number) => h - ((v - min) / span) * (h - 12) - 6;
  const line = points.map((v, i) => (i ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1)).join(" ");
  const zero = y(0);
  return (
    <svg viewBox={"0 0 " + w + " " + h} width="100%" height="110" role="img" aria-label="Daily GGR for the last 14 days">
      <line x1="0" x2={w} y1={zero} y2={zero} stroke="currentColor" strokeDasharray="4 4" opacity=".3" />
      <path d={line + " L" + w + " " + zero + " L0 " + zero + " Z"} fill="rgba(22,184,148,.15)" />
      <path d={line} fill="none" stroke="#16b894" strokeWidth="2" />
    </svg>
  );
}

function SecretBox() {
  const [secret, setSecret] = useState<string | null>(null);
  const [ask, setAsk] = useState(false);
  const [pw, setPw] = useState("");
  const [err, setErr] = useState("");
  const reveal = useMutation({
    mutationFn: async () => (await api.post("/admin/aggregator-secret", { password: pw })).data as { secret: string },
    onSuccess: (d) => { setSecret(d.secret); setAsk(false); setPw(""); setErr(""); setTimeout(() => setSecret(null), 30000); },
    onError: (e) => setErr(errText(e)),
  });
  return (
    <>
      <div className="secretrow">
        <input readOnly aria-label="Single API secret token" value={secret ?? "................................"} />
        <button type="button" className="btn ghost" onClick={() => { setErr(""); setAsk(!ask); }}>{secret ? "Visible for 30s" : "Reveal"}</button>
      </div>
      {ask && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); reveal.mutate(); }}>
          <div><label htmlFor="sk-pw">Confirm your password to reveal it</label><input id="sk-pw" type="password" autoComplete="current-password" value={pw} onChange={(e) => setPw(e.target.value)} autoFocus /></div>
          <button className="btn" disabled={!pw || reveal.isPending}>Confirm</button>
        </form>
      )}
      {err && <p className="err">{err}</p>}
    </>
  );
}

function OverviewTab() {
  const { data: d, isLoading, error } = useDash();
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !d) return <p className="err">Could not load the overview.</p>;
  const max = Math.max(1, ...d.verticals.map((v) => v.turnover_minor));
  const total = d.royalty.betting_minor + d.royalty.deposit_minor - d.royalty.withdrawal_minor;
  return (
    <>
      <div className="grid">
        <div className="card"><p className="lbl">System volume (bet)</p><p className="big">{money(d.turnover_minor)}</p><p className="note">Total betting turnover processed by game providers.</p></div>
        <div className="card"><p className="lbl">Total player GGR</p><p className={"big " + (d.ggr_minor >= 0 ? "g" : "r")}>{money(d.ggr_minor)}</p><p className="note">Bets minus payouts. Positive means platform profit.</p></div>
        <div className="card"><p className="lbl">Provider royalties ({d.fee_range.lo_bps / 100}-{d.fee_range.hi_bps / 100}%)</p><p className="big b">{money(total)}</p>
          <p className="note">Betting GGR royalties: {money(d.royalty.betting_minor)}<br />Cash deposit commissions (admin): +{money(d.royalty.deposit_minor)}<br />Cash withdrawal commissions (admin): -{money(d.royalty.withdrawal_minor)}</p>
          <p className="note">Report only. No money moves from this figure.</p></div>
        <div className="card"><p className="lbl">Network size</p><p className="big">{d.network.super_agents} <span className="note">super</span> &bull; {d.network.club_agents} <span className="note">agents</span> &bull; {d.network.players} <span className="note">players</span></p><p className="note">Points issued so far: {money(d.minted_minor)}.</p></div>
      </div>
      <div className="two2" style={{ marginTop: 20 }}>
        <div className="card">
          <h2>Aggregator node</h2>
          <label>Aggregator endpoint URL</label>
          <input readOnly value={d.api.games_url} />
          <label>Single API secret token</label>
          <SecretBox />
          <label>Secure transfer webhook</label>
          <input readOnly value={d.api.wallet_url} />
          <div className="kv"><span>Unified wallet system</span><span className="tpill tdep">SEAMLESS WALLET</span></div>
          <div className="kv"><span>Provider royalty range</span><b>{d.fee_range.lo_bps / 100}% - {d.fee_range.hi_bps / 100}%</b></div>
        </div>
        <div className="card">
          <div className="rqtop"><h2>Unified GGR by vertical</h2><span className="note">Live from settled bets</span></div>
          <div className="vgrid">
            <div>
              {d.verticals.map((v) => (
                <div key={v.category} className="vrow">
                  <div className="rqtop"><b>{v.category}</b><span className="note">{v.bets} bets . {money(v.turnover_minor)}</span></div>
                  <div className="vbar"><div style={{ width: (v.turnover_minor / max) * 100 + "%" }} /></div>
                </div>
              ))}
            </div>
            <div className="rqag">
              <p className="lbl">Net operator earnings GGR</p>
              <p className={"big " + (d.ggr_minor >= 0 ? "g" : "r")}>{money(d.ggr_minor)}</p>
              <Spark points={d.timeline.map((t) => t.ggr_minor)} />
              <p className="note">Daily GGR, last 14 days</p>
            </div>
          </div>
        </div>
      </div>
      <div className="two2 even" style={{ marginTop: 20 }}>
        <div className="card">
          <div className="rqtop"><h2>Super agent franchise network ({d.supers.length})</h2><span className="note">Direct downlines</span></div>
          <div className="tw"><table>
            <thead><tr><th>Super agent</th><th>Deposit comm.</th><th>Withdrawal comm.</th><th className="n">Available points</th></tr></thead>
            <tbody>{d.supers.map((s) => (
              <tr key={s.id}><td>{s.name}<div className="note">{s.phone ?? ""}</div></td><td className="g">{pct(s.dep_bps)}</td><td className="y">{pct(s.wd_bps)}</td><td className="n">{money(s.balance_minor)}</td></tr>
            ))}</tbody>
          </table></div>
        </div>
        <div className="card">
          <div className="rqtop"><h2>Latest ledger operations</h2><span className="note">Newest first</span></div>
          {d.ledger.length === 0 ? <p className="note">No operations yet.</p> : d.ledger.map((o) => (
            <div className="rqrow" key={o.id}>
              <div className="rqtop"><span className="tpill kind">{kindLabel(o.kind)}</span><span className="note">{when(o.created_at)}</span></div>
              <p><b>{o.sender ?? "System"}</b> to <b>{o.receiver ?? "System"}</b> <span className="b" style={{ float: "right" }}>{money(o.amount_minor)}</span></p>
              {o.memo && <p className="note">{o.memo}</p>}
            </div>
          ))}
        </div>
      </div>
    </>
  );
}

function TransactionsTab() {
  const { data = [], isLoading } = useQuery<Op[]>({ queryKey: ["adm-ops"], queryFn: async () => (await api.get("/admin/ledger-ops?limit=150")).data, refetchInterval: 15000 });
  return (
    <div className="card">
      <div className="rqtop"><h2>Seamless wallet ledger operations</h2><span className="note">Every balanced ledger entry, newest first</span></div>
      {isLoading ? <p className="note">Loading...</p> : (
        <div className="tw"><table>
          <thead><tr><th>Transaction ID</th><th>Sender</th><th>Receiver</th><th>Operation</th><th>Notes</th><th className="n">Amount</th><th>Time</th></tr></thead>
          <tbody>{data.map((o) => (
            <tr key={o.id}>
              <td className="note">tx-{o.id}</td><td>{o.sender ?? "System"}</td><td>{o.receiver ?? "System"}</td>
              <td><span className="tpill kind">{kindLabel(o.kind)}</span></td><td className="note">{o.memo ?? ""}</td>
              <td className="n b">{money(o.amount_minor)}</td><td>{when(o.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function CashierTab() {
  const { data = [], isLoading } = useQuery<CashRow[]>({ queryKey: ["adm-cash"], queryFn: async () => (await api.get("/admin/cashier-log?limit=200")).data, refetchInterval: 8000 });
  return (
    <div className="card">
      <div className="rqtop"><h2>Global cashier audit logs</h2><span className="note">Every player deposit and withdrawal</span></div>
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No requests yet.</p> : (
        <div className="tw"><table>
          <thead><tr><th>Player</th><th>Type</th><th>Processing agent club</th><th className="n">Amount</th><th>Method</th><th>Status</th><th>Reference / details</th><th>Time</th></tr></thead>
          <tbody>{data.map((r) => (
            <tr key={r.id}>
              <td>{r.player}<div className="note">ID: {r.player_id}</div></td><td><TypePill t={r.type} /></td><td>{r.club ?? ""}</td>
              <td className="n b">{money(r.amount_minor)}</td><td>{r.channel ?? "-"}</td>
              <td><span className={"spill s-" + r.status.toLowerCase()}>{r.status}</span></td>
              <td>
                <div className={r.reference ? "" : "note"}>{r.reference ?? (r.type === "deposit" ? "(Awaiting transfer reference)" : "-")}</div>
                {r.phone && <div className="note">Phone: {r.phone}</div>}
                {r.account && <div className="note">{r.channel}: {r.account}</div>}
              </td>
              <td>{when(r.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function ProviderCard({ p }: { p: Prov }) {
  const qc = useQueryClient();
  const [edit, setEdit] = useState(false);
  const [ep, setEp] = useState(p.api_endpoint);
  const [fee, setFee] = useState(String(p.fee_bps / 100));
  const [msg, setMsg] = useState("");
  const refresh = () => qc.invalidateQueries();
  const ping = useMutation({ mutationFn: async () => (await api.post("/admin/providers/" + p.id + "/ping")).data, onSuccess: () => { setMsg(""); refresh(); }, onError: (e) => setMsg(errText(e)) });
  const toggle = useMutation({ mutationFn: async () => (await api.post("/admin/providers/" + p.id + "/status", { status: p.status === "active" ? "disabled" : "active" })).data, onSuccess: () => { setMsg(""); refresh(); }, onError: (e) => setMsg(errText(e)) });
  const save = useMutation({
    mutationFn: async () => (await api.put("/admin/providers/" + p.id, { api_endpoint: ep, fee_bps: Math.round(parseFloat(fee) * 100) })).data,
    onSuccess: () => { setMsg(""); setEdit(false); refresh(); }, onError: (e) => setMsg(errText(e)),
  });
  const on = p.status === "active";
  return (
    <div className="card">
      <div className="rqtop">
        <div><h2 style={{ margin: 0 }}>{p.name}</h2><p className="note">{p.category.toUpperCase()} . {p.games} games</p></div>
        <span className={"spill " + (on ? "s-completed" : "s-rejected")}>{on ? "active" : "disabled"}</span>
      </div>
      <div className="rqag">
        <div className="kv"><span>API endpoint</span><span style={{ overflow: "hidden", textOverflow: "ellipsis", maxWidth: "60%" }}>{p.api_endpoint}</span></div>
        <div className="kv"><span>Provider fee</span><b>{p.fee_bps / 100}% royalty</b></div>
        <div className="kv"><span>Latency link</span><b className={p.latency_ms === null ? "note" : p.latency_ms < 100 ? "g" : "y"}>{p.last_ping_at === null ? "not tested" : p.latency_ms === null ? "unreachable" : p.latency_ms + " ms"}</b></div>
      </div>
      {edit && (
        <form className="inline" onSubmit={(e) => { e.preventDefault(); save.mutate(); }}>
          <div><label>API endpoint (https)</label><input value={ep} onChange={(e) => setEp(e.target.value)} /></div>
          <div><label>Fee (%)</label><input type="number" min="0" max="50" step="0.01" value={fee} onChange={(e) => setFee(e.target.value)} /></div>
          <button className="btn" disabled={save.isPending}>Save</button>
        </form>
      )}
      <div className="two">
        <button className="btn ghost" disabled={ping.isPending} onClick={() => ping.mutate()}>{ping.isPending ? "Pinging..." : "Ping latency"}</button>
        <button className="btn ghost" onClick={() => setEdit(!edit)}>{edit ? "Close" : "Edit"}</button>
      </div>
      <button className={"btn full " + (on ? "danger" : "")} disabled={toggle.isPending} onClick={() => { if (on && !window.confirm("Disable " + p.name + "? Its games disappear from the player lobby straight away.")) return; toggle.mutate(); }}>{on ? "Disable" : "Enable"}</button>
      {msg && <p className="err">{msg}</p>}
    </div>
  );
}

function ProvidersTab() {
  const { data = [], isLoading } = useQuery<Prov[]>({ queryKey: ["adm-prov"], queryFn: async () => (await api.get("/admin/providers")).data });
  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="rqtop"><h2>Aggregated providers single-API gateway router</h2><span className="tpill tdep">SINGLE INTEGRATION ACTIVE</span></div>
        <p className="note">Fees and addresses shown are placeholders until your provider contracts are in place. Disabling a provider hides its games from players.</p>
      </div>
      {isLoading ? <p className="note">Loading...</p> : <div className="net3">{data.map((p) => <ProviderCard key={p.id} p={p} />)}</div>}
    </>
  );
}

function ProvisionSuper() {
  const qc = useQueryClient();
  const [f, setF] = useState({ display_name: "", phone: "", password: "", cbe: "", dep: 500, wd: 500, initial: "" });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const initial = Math.round(parseFloat(f.initial || "0") * 100);
  const create = useMutation({
    mutationFn: async () => (await api.post("/admin/provision-super", {
      phone: f.phone, display_name: f.display_name, password: f.password, cbe_account: f.cbe || undefined,
      deposit_rate_bps: f.dep, withdrawal_rate_bps: f.wd, initial_points_minor: initial > 0 ? initial : undefined,
    })).data,
    onSuccess: () => { setMsg(""); setOk("Super agent " + f.display_name + " created."); setF({ display_name: "", phone: "", password: "", cbe: "", dep: 500, wd: 500, initial: "" }); qc.invalidateQueries(); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const set = (k: string, v: string | number) => { setOk(""); setF({ ...f, [k]: v }); };
  return (
    <div className="card">
      <h2>Provision super agent</h2>
      <form className="top" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label htmlFor="ps-n">Display name (agency / group)</label>
        <input id="ps-n" placeholder="e.g. Vortex Elite Distribution" value={f.display_name} onChange={(e) => set("display_name", e.target.value)} />
        <label htmlFor="ps-p">Phone number</label>
        <input id="ps-p" type="tel" inputMode="tel" placeholder="e.g. 0912345678" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
        <label htmlFor="ps-w">Password (10+ characters, upper, lower, number)</label>
        <input id="ps-w" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
        <label htmlFor="ps-c">CBE account number</label>
        <input id="ps-c" placeholder="e.g. 1000123456789" value={f.cbe} onChange={(e) => set("cbe", e.target.value)} />
        <label htmlFor="ps-d">Deposit commission rate: <b className="g">{f.dep / 100}%</b></label>
        <input id="ps-d" type="range" min={0} max={2000} step={25} value={f.dep} onChange={(e) => set("dep", Number(e.target.value))} />
        <label htmlFor="ps-r">Withdrawal commission rate: <b className="y">{f.wd / 100}%</b></label>
        <input id="ps-r" type="range" min={0} max={2000} step={25} value={f.wd} onChange={(e) => set("wd", Number(e.target.value))} />
        <label htmlFor="ps-i">Initial points allocation ($)</label>
        <input id="ps-i" type="number" inputMode="decimal" min="0" step="0.01" value={f.initial} onChange={(e) => set("initial", e.target.value)} />
        <p className="note">Points are created immediately in the ledger and recorded in the audit log.</p>
        <button className="btn full" disabled={create.isPending || !f.display_name || !f.phone || f.password.length < 10}>{create.isPending ? "Creating..." : "Create and fund super agent"}</button>
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g top">{ok}</p>}
    </div>
  );
}

function ManageModal({ u, onClose }: { u: DirRow; onClose: () => void }) {
  const qc = useQueryClient();
  const [dep, setDep] = useState(String((u.dep_bps ?? 0) / 100));
  const [wd, setWd] = useState(String((u.wd_bps ?? 0) / 100));
  const [pw, setPw] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", h);
    return () => window.removeEventListener("keydown", h);
  }, [onClose]);
  const done = (m: string) => { setMsg(""); setOk(m); qc.invalidateQueries(); };
  const fail = (e: unknown) => { setOk(""); setMsg(errText(e)); };
  const rates = useMutation({
    mutationFn: async () => {
      const pairs: [string, string, number | null][] = [["deposit", dep, u.dep_cap_bps], ["withdrawal", wd, u.wd_cap_bps]];
      for (const [ev, v, cap] of pairs) {
        const bps = Math.round(parseFloat(v) * 100);
        await api.put("/admin/rates", { user_id: u.id, event_type: ev, rate_bps: bps, cap_bps: Math.max(bps, cap ?? 0) });
      }
    },
    onSuccess: () => done("Rates saved. They apply to new transactions only."), onError: fail,
  });
  const status = useMutation({
    mutationFn: async () => (await api.post("/admin/users/" + u.id + "/status", { status: u.status === "active" ? "frozen" : "active" })).data,
    onSuccess: () => done(u.status === "active" ? "Account frozen." : "Account unfrozen."), onError: fail,
  });
  const reset = useMutation({
    mutationFn: async () => (await api.post("/admin/users/" + u.id + "/reset-password", { new_password: pw })).data,
    onSuccess: () => { setPw(""); done("Password reset. They must change it at next sign-in."); }, onError: fail,
  });
  return (
    <div className="modal" role="dialog" aria-modal="true" aria-label={"Manage " + u.name} onClick={onClose}>
      <div className="card" onClick={(e) => e.stopPropagation()}>
        <div className="rqtop"><h2 style={{ margin: 0 }}>{u.name}</h2><span className="tpill kind">{ROLE[u.role] ?? u.role}</span></div>
        <p className="note">{u.phone ?? "no phone"} . ID {u.id}{u.parent ? " . under " + u.parent : ""}</p>
        {u.role !== "player" && (
          <form className="top" onSubmit={(e) => { e.preventDefault(); rates.mutate(); }}>
            <label htmlFor="mm-d">Deposit commission (%)</label>
            <input id="mm-d" type="number" min="0" max="20" step="0.01" value={dep} onChange={(e) => setDep(e.target.value)} />
            <label htmlFor="mm-w">Withdrawal commission (%)</label>
            <input id="mm-w" type="number" min="0" max="20" step="0.01" value={wd} onChange={(e) => setWd(e.target.value)} />
            <button className="btn full" disabled={rates.isPending || isNaN(parseFloat(dep)) || isNaN(parseFloat(wd))}>Save rates</button>
          </form>
        )}
        <form className="top" onSubmit={(e) => { e.preventDefault(); if (window.confirm("Reset the password for " + u.name + "?")) reset.mutate(); }}>
          <label htmlFor="mm-p">New password (10+ characters, upper, lower, number)</label>
          <input id="mm-p" type="password" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <button className="btn ghost full" disabled={pw.length < 10 || reset.isPending}>Reset password</button>
        </form>
        <button className={"btn full " + (u.status === "active" ? "danger" : "")} disabled={status.isPending} onClick={() => status.mutate()}>{u.status === "active" ? "Freeze account" : "Unfreeze account"}</button>
        {msg && <p className="err">{msg}</p>}
        {ok && <p className="g top">{ok}</p>}
        <button className="btn ghost full" onClick={onClose}>Close</button>
      </div>
    </div>
  );
}

function Directory() {
  const { data = [], isLoading } = useQuery<DirRow[]>({ queryKey: ["adm-dir"], queryFn: async () => (await api.get("/admin/directory")).data });
  const [q, setQ] = useState("");
  const [role, setRole] = useState("");
  const [open, setOpen] = useState<DirRow | null>(null);
  const needle = q.trim().toLowerCase();
  const shown = data.filter((u) => (!role || u.role === role) && (!needle || (u.name + " " + (u.phone ?? "") + " " + u.id + " " + u.username).toLowerCase().includes(needle))).slice(0, 200);
  return (
    <div className="card" style={{ marginTop: 20 }}>
      <div className="rqtop"><div><h2 style={{ margin: 0 }}>Network account directory</h2><p className="note">Manage rates, status, phone contacts and CBE accounts.</p></div><span className="tpill twd">ADMIN REGISTRY</span></div>
      <div className="fbar" style={{ marginTop: 12 }}>
        <input aria-label="Search the directory" className="fsearch" placeholder="Search by name, phone or ID..." value={q} onChange={(e) => setQ(e.target.value)} />
        <select aria-label="Filter by role" className="fsel" value={role} onChange={(e) => setRole(e.target.value)}>
          <option value="">All roles</option><option value="super">Super agents</option><option value="club">Agents</option><option value="player">Players</option>
        </select>
      </div>
      {isLoading ? <p className="note">Loading...</p> : (
        <div className="tw"><table>
          <thead><tr><th>User details</th><th>Role</th><th>Phone number</th><th>CBE account</th><th>Dep % / With %</th><th className="n">Balance</th><th>Status</th><th></th></tr></thead>
          <tbody>{shown.map((u) => (
            <tr key={u.id}>
              <td>{u.name}<div className="note">{u.username}</div></td>
              <td><span className="tpill kind">{ROLE[u.role] ?? u.role}</span></td>
              <td>{u.phone ?? "-"}</td><td>{u.cbe_account ?? "-"}</td>
              <td>{u.role === "player" ? "-" : "D: " + pct(u.dep_bps) + " / W: " + pct(u.wd_bps)}</td>
              <td className="n b">{u.balance_minor === null ? "-" : money(u.balance_minor)}</td>
              <td><span className={"spill " + (u.status === "active" ? "s-completed" : "s-rejected")}>{u.status}</span></td>
              <td className="acts"><button className="btn ghost" onClick={() => setOpen(u)}>Edit / Manage</button></td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
      {data.length > 200 && <p className="note">Showing the first 200 matches. Search to narrow down.</p>}
      {open && <ManageModal u={open} onClose={() => setOpen(null)} />}
    </div>
  );
}

function AgentsTab() {
  return (
    <>
      <MoveCards who="super agent" lead={<ProvisionSuper />} />
      <Directory />
    </>
  );
}

const MAIN = ["Overview", "Providers", "Agents", "Transactions", "Requests", "Point Requests"] as const;
const MORE = ["Rates", "Reversals", "Settlement", "Games", "Payment Accounts", "Audit and checks"] as const;

export default function AdminConsole({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<string>("Overview");
  const { data: d } = useDash();
  const badge = (t: string) => (t === "Requests" ? d?.pending_requests : t === "Point Requests" ? d?.pending_point_asks : 0) || 0;
  const btn = (t: string, sub?: boolean) => (
    <button key={t} role="tab" className={sub ? "subtab" : ""} aria-selected={t === tab} onClick={() => setTab(t)}>
      {t}{badge(t) > 0 && <span className="badge">{badge(t)}</span>}
    </button>
  );
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="tag">ADMIN MASTER CONTROL SUITE</div>
          <h1>Global Platform Ledger &amp; Gateway API</h1>
          <p className="note">Configure unified slot &amp; sportsbook aggregations, inspect override commission distributions, and dispatch network point payloads. Signed in as {user.name}.</p>
        </div>
        <div className="head-right">
          <nav role="tablist" className="adminnav">
            {MAIN.map((t) => btn(t))}
            <span className="navbreak" />
            {MORE.map((t) => btn(t, true))}
          </nav>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main>
        {tab === "Overview" && <OverviewTab />}
        {tab === "Providers" && <ProvidersTab />}
        {tab === "Agents" && <AgentsTab />}
        {tab === "Transactions" && <TransactionsTab />}
        {tab === "Requests" && <CashierTab />}
        {tab === "Point Requests" && <PointPool who="super agents" />}
        {tab === "Rates" && <RatesTab />}
        {tab === "Reversals" && <ReversalsTab />}
        {tab === "Settlement" && <SettlementTab />}
        {tab === "Games" && <GamesStatsTab />}
        {tab === "Payment Accounts" && <ChannelsTab path="/my/channels" />}
        {tab === "Audit and checks" && <ChecksTab />}
      </main>
      <footer className="pagefoot">Mika Games Platform Console . Single-API Game Router &amp; Multi-tier Network Active . Built for Ethiopian Market Compliance.</footer>
    </div>
  );
}
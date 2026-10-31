import { useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";
import type { User } from "./App";
import { QueueTab, ChannelsTab } from "./ClubQueue";
import { PointRequestForm } from "./Points";
import { KycTab } from "./ClubKyc";

const TABS = ["Overview", "Players", "Verification", "Requests", "Payment Accounts", "Point Requests", "Ledger"] as const;
type Tab = (typeof TABS)[number];

function useGet<T>(key: string, url: string) {
  return useQuery<T>({ queryKey: [key], queryFn: async () => (await api.get(url)).data });
}
const when = (s: string) => new Date(s).toLocaleString();
const REFRESH = ["club-overview", "club-players", "club-points", "club-credit", "club-ledger"];

function Status({ s }: { s: string }) {
  const cls = s === "approved" || s === "active" ? "ok" : s === "pending" ? "wait" : "no";
  return <span className={"pill " + cls}>{s}</span>;
}

type Ov = { credit_balance_minor: number; commission_balance_minor: number; players: number; pending_requests: number; turnover_minor: number };

function OverviewTab() {
  const { data: o, isLoading, error } = useGet<Ov>("club-overview", "/club/overview");
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !o) return <p className="err">Could not load the overview.</p>;
  return (
    <div className="grid">
      <div className="card"><p className="lbl">Credit balance</p><p className="big y">{money(o.credit_balance_minor)}</p><p className="note">Credits you can give to players.</p></div>
      <div className="card"><p className="lbl">Commission earned</p><p className="big g">{money(o.commission_balance_minor)}</p><p className="note">Waiting for daily settlement, then added to your credits.</p></div>
      <div className="card"><p className="lbl">Players&rsquo; turnover (bets)</p><p className="big b">{money(o.turnover_minor)}</p><p className="note">Total settled bets by your players.</p></div>
      <div className="card"><p className="lbl">Players</p><p className="big">{o.players}</p><p className="note">{o.pending_requests} request{o.pending_requests === 1 ? "" : "s"} waiting for you.</p></div>
    </div>
  );
}

type Pl = { id: number; name: string; username: string; status: string; credit_balance_minor: number; created_at: string };

function PlayersTab() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useGet<Pl[]>("club-players", "/players");
  const [f, setF] = useState({ username: "", display_name: "", password: "" });
  const [msg, setMsg] = useState("");
  const done = () => REFRESH.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));

  const create = useMutation({
    mutationFn: async () => (await api.post("/players", f)).data,
    onSuccess: () => { setMsg(""); setF({ username: "", display_name: "", password: "" }); done(); },
    onError: (e) => setMsg(errText(e)),
  });
  const setStatus = useMutation({
    mutationFn: async (v: { id: number; status: string }) => (await api.post("/players/" + v.id + "/status", { status: v.status })).data,
    onSuccess: done,
    onError: (e) => setMsg(errText(e)),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };

  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Add a player</h2>
        <form onSubmit={submit} className="inline">
          <div><label htmlFor="pn">Name</label><input id="pn" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></div>
          <div><label htmlFor="pu">Username</label><input id="pu" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} /></div>
          <div><label htmlFor="pp">Password (8+ characters)</label><input id="pp" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <button className="btn" disabled={create.isPending || !f.username || !f.display_name || f.password.length < 8}>Add player</button>
        </form>
        {msg && <p className="err">{msg}</p>}
      </div>
      <div className="card">
        <h2>Your players</h2>
        {isLoading ? <p className="note">Loading...</p> : (
          <div className="tw"><table>
            <thead><tr><th>Player</th><th>Username</th><th>Status</th><th className="n">Credit balance</th><th></th></tr></thead>
            <tbody>{data.map((p) => (
              <tr key={p.id}>
                <td>{p.name}</td><td>{p.username}</td><td><Status s={p.status} /></td>
                <td className="n">{money(p.credit_balance_minor)}</td>
                <td className="acts">
                  <button className="btn ghost" disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: p.id, status: p.status === "active" ? "frozen" : "active" })}>
                    {p.status === "active" ? "Freeze" : "Unfreeze"}
                  </button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

type Pr = { id: number; player: string; type: string; amount_minor: number; status: string; created_at: string };

function PointsTab() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useGet<Pr[]>("club-points", "/point-requests");
  const [msg, setMsg] = useState("");
  const act = useMutation({
    mutationFn: async (v: { id: number; kind: "approve" | "reject" }) => (await api.post("/point-requests/" + v.id + "/" + v.kind)).data,
    onSuccess: () => { setMsg(""); REFRESH.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => setMsg(errText(e)),
  });
  return (
    <div className="card">
      <h2>Player point requests</h2>
      <p className="note">Check you have received the cash before you approve a deposit.</p>
      {msg && <p className="err">{msg}</p>}
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note top">No requests yet.</p> : (
        <div className="tw"><table>
          <thead><tr><th>Player</th><th>Type</th><th>Requested</th><th className="n">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>{data.map((q) => (
            <tr key={q.id}>
              <td>{q.player}</td><td>{q.type}</td><td>{when(q.created_at)}</td>
              <td className="n">{money(q.amount_minor)}</td><td><Status s={q.status} /></td>
              <td className="acts">{q.status === "pending" && q.type === "deposit" && (<>
                <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ id: q.id, kind: "approve" })}>Approve</button>
                <button className="btn ghost" disabled={act.isPending} onClick={() => act.mutate({ id: q.id, kind: "reject" })}>Reject</button>
              </>)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

type Cr = { id: number; amount_minor: number; status: string; note: string | null; created_at: string };

function CreditTab() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useGet<Cr[]>("club-credit", "/credit-requests");
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState("");
  const send = useMutation({
    mutationFn: async () => (await api.post("/credit-requests", { amount_minor: Math.round(parseFloat(amount) * 100) })).data,
    onSuccess: () => { setMsg(""); setAmount(""); qc.invalidateQueries({ queryKey: ["club-credit"] }); },
    onError: (e) => setMsg(errText(e)),
  });
  const valid = parseFloat(amount) > 0;
  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Request credits from your super agent</h2>
        <form className="inline" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
          <div><label htmlFor="ca">Amount ($)</label><input id="ca" type="number" min="1" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
          <button className="btn" disabled={!valid || send.isPending}>Send request</button>
        </form>
        {msg && <p className="err">{msg}</p>}
      </div>
      <div className="card">
        <h2>Your requests</h2>
        {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No requests yet.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Requested</th><th className="n">Amount</th><th>Status</th></tr></thead>
            <tbody>{data.map((q) => (<tr key={q.id}><td>{when(q.created_at)}</td><td className="n">{money(q.amount_minor)}</td><td><Status s={q.status} /></td></tr>))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

type Lg = { id: number; kind: string; memo: string | null; created_at: string; account_type: string; amount_minor: number; balance_after_minor: number };

function LedgerTab() {
  const { data = [], isLoading } = useGet<Lg[]>("club-ledger", "/ledger");
  return (
    <div className="card">
      <h2>Ledger</h2>
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No transactions yet.</p> : (
        <div className="tw"><table>
          <thead><tr><th>Time</th><th>Type</th><th>Account</th><th>Detail</th><th className="n">Amount</th><th className="n">Balance after</th></tr></thead>
          <tbody>{data.map((l, i) => (
            <tr key={l.id + "-" + i}>
              <td>{when(l.created_at)}</td><td>{l.kind}</td><td>{l.account_type}</td><td>{l.memo}</td>
              <td className={"n " + (l.amount_minor < 0 ? "r" : "g")}>{l.amount_minor > 0 ? "+" : ""}{money(l.amount_minor)}</td>
              <td className="n">{money(l.balance_after_minor)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

export default function ClubPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("Overview");
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="tag">CLUB AGENT PORTAL</div>
          <h1>{user.name}</h1>
          <p className="note">Players, deposits and credits for your club.</p>
        </div>
        <div className="head-right">
          <nav role="tablist">
            {TABS.map((t) => (<button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>{t}</button>))}
          </nav>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main>
        {tab === "Overview" && <OverviewTab />}
        {tab === "Players" && <PlayersTab />}
        {tab === "Verification" && <KycTab />}
        {tab === "Requests" && <QueueTab />}
        {tab === "Payment Accounts" && <ChannelsTab />}
        {tab === "Point Requests" && <PointRequestForm to="Super Agent" />}
        {tab === "Ledger" && <LedgerTab />}
      </main>
    </div>
  );
}
export { PointsTab as LegacyPointsTab };

export { CreditTab as LegacyCreditTab };

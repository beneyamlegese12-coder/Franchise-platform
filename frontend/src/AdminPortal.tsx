import { useState } from "react";
import type { FormEvent } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";
import type { User } from "./App";
import { PointPool } from "./Points";
import { ChannelsTab } from "./ClubQueue";
import { ReversalsTab, SettlementTab } from "./AdminMoney";
import { GamesTab } from "./AdminGames";

const TABS = ["Overview", "Users", "Mint credits", "Rates", "Reversals", "Settlement", "Games", "Agents", "Point Requests", "Payment Accounts", "Checks and audit"] as const;
type Tab = (typeof TABS)[number];
const KEYS = ["admin-overview", "admin-users", "admin-rates", "admin-audit", "admin-reconcile"];

function useGet<T>(key: string, url: string) {
  return useQuery<T>({ queryKey: [key], queryFn: async () => (await api.get(url)).data });
}
const when = (s: string) => new Date(s).toLocaleString();
const pct = (bps: number) => bps / 100 + "%";
const toBps = (s: string) => Math.round(parseFloat(s) * 100);

function Status({ s }: { s: string }) {
  const cls = s === "active" || s === "approved" ? "ok" : s === "pending" ? "wait" : "no";
  return <span className={"pill " + cls}>{s}</span>;
}

type Ov = {
  minted_minor: number; in_circulation_minor: number; held_minor: number; commission_paid_minor: number;
  super_agents: number; club_agents: number; players: number; pending_requests: number;
};

function OverviewTab() {
  const { data: o, isLoading, error } = useGet<Ov>("admin-overview", "/admin/overview");
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !o) return <p className="err">Could not load the overview.</p>;
  return (
    <div className="grid">
      <div className="card"><p className="lbl">Credits minted</p><p className="big y">{money(o.minted_minor)}</p><p className="note">All credits ever created.</p></div>
      <div className="card"><p className="lbl">Credits in circulation</p><p className="big b">{money(o.in_circulation_minor)}</p><p className="note">Held in withdrawals: {money(o.held_minor)}</p></div>
      <div className="card"><p className="lbl">Commissions paid out</p><p className="big g">{money(o.commission_paid_minor)}</p><p className="note">Total earned by all levels, admin share included.</p></div>
      <div className="card"><p className="lbl">Network</p><p className="big">{o.super_agents} <span className="note">super</span> &bull; {o.club_agents} <span className="note">clubs</span></p><p className="note">{o.players} players, {o.pending_requests} request{o.pending_requests === 1 ? "" : "s"} pending.</p></div>
    </div>
  );
}

type Row = {
  id: number; role: string; username: string; name: string; status: string; parent: string | null;
  credit_balance_minor: number | null; commission_balance_minor: number | null;
};

function UsersTab() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useGet<Row[]>("admin-users", "/admin/users");
  const empty = { role: "super", parent_id: "", display_name: "", username: "", password: "", dep: "2", wd: "0.5" };
  const [f, setF] = useState(empty);
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const done = () => KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const supers = data.filter((u) => u.role === "super");

  const create = useMutation({
    mutationFn: async () => (await api.post("/admin/users", {
      role: f.role,
      parent_id: f.role === "club" && f.parent_id ? Number(f.parent_id) : undefined,
      phone: f.username, display_name: f.display_name, password: f.password,
      deposit_rate_bps: toBps(f.dep), withdrawal_rate_bps: toBps(f.wd),
    })).data,
    onSuccess: () => { setMsg(""); setOk("Created " + f.display_name + "."); setF(empty); done(); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const setStatus = useMutation({
    mutationFn: async (v: { id: number; status: string }) => (await api.post("/admin/users/" + v.id + "/status", { status: v.status })).data,
    onSuccess: done,
    onError: (e) => setMsg(errText(e)),
  });
  const submit = (e: FormEvent) => { e.preventDefault(); create.mutate(); };
  const valid = f.display_name && f.username && f.password.length >= 8 && (f.role === "super" || f.parent_id) && !isNaN(parseFloat(f.dep)) && !isNaN(parseFloat(f.wd));

  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Create an agent</h2>
        <form onSubmit={submit} className="inline">
          <div><label htmlFor="r">Type</label>
            <select id="r" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value, dep: e.target.value === "club" ? "5" : "2", wd: e.target.value === "club" ? "1" : "0.5" })}>
              <option value="super">Super agent</option><option value="club">Club agent</option>
            </select></div>
          {f.role === "club" && (
            <div><label htmlFor="sp">Under super agent</label>
              <select id="sp" value={f.parent_id} onChange={(e) => setF({ ...f, parent_id: e.target.value })}>
                <option value="">Choose...</option>
                {supers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
              </select></div>
          )}
          <div><label htmlFor="n">Name</label><input id="n" value={f.display_name} onChange={(e) => setF({ ...f, display_name: e.target.value })} /></div>
          <div><label htmlFor="un">Phone number</label><input id="un" value={f.username} onChange={(e) => setF({ ...f, username: e.target.value.toLowerCase() })} /></div>
          <div><label htmlFor="pw">Password (8+ characters)</label><input id="pw" type="password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} /></div>
          <div><label htmlFor="dp">Deposit rate (%)</label><input id="dp" type="number" min="0" step="0.01" value={f.dep} onChange={(e) => setF({ ...f, dep: e.target.value })} /></div>
          <div><label htmlFor="wr">Withdrawal rate (%)</label><input id="wr" type="number" min="0" step="0.01" value={f.wd} onChange={(e) => setF({ ...f, wd: e.target.value })} /></div>
          <button className="btn" disabled={!valid || create.isPending}>Create</button>
        </form>
        {msg && <p className="err">{msg}</p>}
        {ok && <p className="g">{ok}</p>}
      </div>
      <div className="card">
        <h2>All agents and players</h2>
        {isLoading ? <p className="note">Loading...</p> : (
          <div className="tw"><table>
            <thead><tr><th>Name</th><th>Type</th><th>Under</th><th>Status</th><th className="n">Credits</th><th className="n">Commission</th><th></th></tr></thead>
            <tbody>{data.map((u) => (
              <tr key={u.id}>
                <td>{u.name}<div className="note">{u.username}</div></td><td>{u.role}</td><td>{u.parent ?? "-"}</td><td><Status s={u.status} /></td>
                <td className="n">{u.credit_balance_minor === null ? "-" : money(u.credit_balance_minor)}</td>
                <td className="n">{u.commission_balance_minor === null ? "-" : money(u.commission_balance_minor)}</td>
                <td className="acts">
                  <button className="btn ghost" disabled={setStatus.isPending}
                    onClick={() => setStatus.mutate({ id: u.id, status: u.status === "active" ? "frozen" : "active" })}>
                    {u.status === "active" ? "Freeze" : "Unfreeze"}
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

function MintTab() {
  const qc = useQueryClient();
  const { data = [] } = useGet<Row[]>("admin-users", "/admin/users");
  const supers = data.filter((u) => u.role === "super");
  const [to, setTo] = useState("");
  const [amount, setAmount] = useState("");
  const [reason, setReason] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const mint = useMutation({
    mutationFn: async () => (await api.post("/admin/mint", { user_id: Number(to), amount_minor: Math.round(parseFloat(amount) * 100), reason })).data,
    onSuccess: (d) => {
      setMsg(""); setOk("Minted " + money(d.amount_minor) + ". Ledger transaction #" + d.transaction_id + ".");
      setAmount(""); setReason(""); KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const valid = to && parseFloat(amount) > 0 && reason.trim().length >= 3;
  return (
    <div className="card">
      <h2>Mint credits to a super agent</h2>
      <p className="note">This creates new credits. Every mint is recorded in the ledger and the audit log with your reason.</p>
      <form className="inline top" onSubmit={(e) => { e.preventDefault(); mint.mutate(); }}>
        <div><label htmlFor="mt">Super agent</label>
          <select id="mt" value={to} onChange={(e) => setTo(e.target.value)}>
            <option value="">Choose...</option>
            {supers.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select></div>
        <div><label htmlFor="ma">Amount ($)</label><input id="ma" type="number" min="0.01" step="0.01" value={amount} onChange={(e) => setAmount(e.target.value)} /></div>
        <div><label htmlFor="mr">Reason</label><input id="mr" value={reason} onChange={(e) => setReason(e.target.value)} /></div>
        <button className="btn" disabled={!valid || mint.isPending}>Mint credits</button>
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g">{ok}</p>}
    </div>
  );
}

type Rate = { user_id: number; name: string; role: string; event_type: string; rate_bps: number; cap_bps: number };

function RateRow({ r }: { r: Rate }) {
  const qc = useQueryClient();
  const [rate, setRate] = useState(String(r.rate_bps / 100));
  const [cap, setCap] = useState(String(r.cap_bps / 100));
  const [msg, setMsg] = useState("");
  const save = useMutation({
    mutationFn: async () => (await api.put("/admin/rates", { user_id: r.user_id, event_type: r.event_type, rate_bps: toBps(rate), cap_bps: toBps(cap) })).data,
    onSuccess: () => { setMsg("Saved"); ["admin-rates", "admin-audit"].forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => setMsg(errText(e)),
  });
  const changed = toBps(rate) !== r.rate_bps || toBps(cap) !== r.cap_bps;
  return (
    <tr>
      <td>{r.name}</td><td>{r.role}</td><td>{r.event_type}</td>
      <td><input aria-label="Rate %" type="number" min="0" step="0.01" value={rate} onChange={(e) => { setMsg(""); setRate(e.target.value); }} style={{ width: 90 }} /></td>
      <td><input aria-label="Cap %" type="number" min="0" step="0.01" value={cap} onChange={(e) => { setMsg(""); setCap(e.target.value); }} style={{ width: 90 }} /></td>
      <td className="acts">
        <span className={msg === "Saved" ? "g" : "r"}>{msg}</span>
        <button className="btn" disabled={!changed || save.isPending || isNaN(toBps(rate)) || isNaN(toBps(cap))} onClick={() => save.mutate()}>Save</button>
      </td>
    </tr>
  );
}

export function RatesTab() {
  const { data = [], isLoading } = useGet<Rate[]>("admin-rates", "/admin/rates");
  return (
    <div className="card">
      <h2>Commission rates and caps</h2>
      <p className="note">Rates apply to new transactions only. Past commissions keep the rate they were paid at.</p>
      {isLoading ? <p className="note top">Loading...</p> : (
        <div className="tw top"><table>
          <thead><tr><th>Agent</th><th>Type</th><th>Event</th><th>Rate (%)</th><th>Cap (%)</th><th></th></tr></thead>
          <tbody>{data.map((r) => <RateRow key={r.user_id + "-" + r.event_type + "-" + r.rate_bps + "-" + r.cap_bps} r={r} />)}</tbody>
        </table></div>
      )}
    </div>
  );
}

type Rec = {
  ok: boolean; entries_checked: number; ledger_total_minor: number; unbalanced_transactions: number;
  mismatched_accounts: { id: number; username: string; type: string; balance_minor: number; ledger_minor: number }[]; checked_at: string;
};
type Log = { id: number; action: string; entity: string; entity_id: number | null; detail: unknown; created_at: string; actor: string | null };

export function ChecksTab() {
  const rec = useQuery<Rec>({ queryKey: ["admin-reconcile"], queryFn: async () => (await api.get("/admin/reconcile")).data });
  const { data: logs = [], isLoading } = useGet<Log[]>("admin-audit", "/admin/audit");
  const r = rec.data;
  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Ledger check</h2>
        {rec.isLoading || !r ? <p className="note">Checking...</p> : (
          <>
            <p className={"big " + (r.ok ? "g" : "r")}>{r.ok ? "Books balance" : "Problem found"}</p>
            <p className="note">{r.entries_checked} ledger entries checked. Total of all entries: {money(r.ledger_total_minor)} (should be $0.00). Unbalanced transactions: {r.unbalanced_transactions}. Accounts whose balance differs from their entries: {r.mismatched_accounts.length}.</p>
            {r.mismatched_accounts.map((m) => (
              <p key={m.id} className="err">{m.username} ({m.type}): stored {money(m.balance_minor)}, ledger says {money(m.ledger_minor)}</p>
            ))}
          </>
        )}
        <button className="btn ghost top" onClick={() => rec.refetch()} disabled={rec.isFetching}>{rec.isFetching ? "Checking..." : "Run check again"}</button>
      </div>
      <div className="card">
        <h2>Audit log</h2>
        {isLoading ? <p className="note">Loading...</p> : logs.length === 0 ? <p className="note">Nothing recorded yet.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Time</th><th>Who</th><th>Action</th><th>Detail</th></tr></thead>
            <tbody>{logs.map((l) => (
              <tr key={l.id}>
                <td>{when(l.created_at)}</td><td>{l.actor ?? "system"}</td>
                <td>{l.action}{l.entity_id ? " #" + l.entity_id : ""}</td>
                <td className="note">{l.detail ? JSON.stringify(l.detail) : ""}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export default function AdminPortal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("Overview");
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="tag">PLATFORM ADMIN</div>
          <h1>{user.name}</h1>
          <p className="note">Agents, credits, rates and audit for the whole platform.</p>
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
        {tab === "Users" && <UsersTab />}
        {tab === "Mint credits" && <MintTab />}
        {tab === "Rates" && <RatesTab />}
        {tab === "Reversals" && <ReversalsTab />}
        {tab === "Settlement" && <SettlementTab />}
        {tab === "Games" && <GamesTab />}
        {tab === "Agents" && <MoveCards who="super agent" />}
        {tab === "Payment Accounts" && <ChannelsTab path="/my/channels" />}
        {tab === "Checks and audit" && <ChecksTab />}
      </main>
    </div>
  );
}
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";
import type { User } from "./App";
import { PointPool, PointRequestForm } from "./Points";
import { MoveCards } from "./Network";
import { ChannelsTab } from "./ClubQueue";

type Club = { id: number; name: string; username: string; phone: string | null; status: string; balance_minor: number; dep_bps: number | null; wd_bps: number | null; cbe_account: string | null };
type Dash = {
  balance_minor: number; upstream: string;
  rates: { dep_bps: number; wd_bps: number; dep_cap_bps: number; wd_cap_bps: number };
  commission: { deposit_minor: number; withdrawal_minor: number };
  turnover_minor: number;
  counts: { clubs: number; clubs_active: number; players: number; players_active: number };
  clubs: Club[]; pending_requests: number; pending_point_asks: number;
};
type Req = { id: number; type: string; amount_minor: number; channel: string | null; created_at: string; player: string; player_id: number; club: string | null; status: string; reference: string | null; phone: string | null; account: string | null };
type Op = { id: number; kind: string; memo: string | null; created_at: string; amount_minor: number; sender: string | null; receiver: string | null; my_commission_minor: number };

const when = (s: string) => new Date(s).toLocaleString();
const kindLabel = (k: string) => k.replace(/_/g, " ").toUpperCase();
const pct = (b: number | null) => (b === null ? "-" : b / 100 + "%");
const TypePill = ({ t }: { t: string }) => <span className={"tpill " + (t === "deposit" ? "tdep" : "twd")}>{t.toUpperCase()}</span>;

function useDash() {
  return useQuery<Dash>({ queryKey: ["sup-dash"], queryFn: async () => (await api.get("/super/dashboard")).data, refetchInterval: 10000 });
}

function Overview() {
  const { data: d, isLoading, error } = useDash();
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !d) return <p className="err">Could not load the overview.</p>;
  return (
    <>
      <div className="grid">
        <div className="card"><p className="lbl">Franchise points balance</p><p className="big">{money(d.balance_minor)}</p><p className="note">Available point pool. Use it to fund your downstream agent clubs.</p></div>
        <div className="card"><p className="lbl">Commission earned</p><p className="big g">{money(d.commission.deposit_minor + d.commission.withdrawal_minor)}</p>
          <p className="note">Deposit commissions: +{money(d.commission.deposit_minor)}<br />Withdrawal commissions: +{money(d.commission.withdrawal_minor)}</p></div>
        <div className="card"><p className="lbl">Network turnover (bet)</p><p className="big b">{money(d.turnover_minor)}</p><p className="note">Total betting volume of all players in your downstream clubs.</p></div>
        <div className="card"><p className="lbl">Active agents and players</p><p className="big">{d.counts.clubs_active} <span className="note">club agents</span> &bull; {d.counts.players_active} <span className="note">active players</span></p><p className="note">Size of the gaming distribution node you manage ({d.counts.players} players in total).</p></div>
      </div>
      <div className="two2" style={{ marginTop: 20 }}>
        <div className="card">
          <h2>Franchise commission settings</h2>
          <div className="rqag">
            <p className="lbl">Your base cash rates</p>
            <div className="kv"><span>Deposit commission</span><b className="g">{pct(d.rates.dep_bps)}</b></div>
            <div className="kv"><span>Withdrawal commission</span><b className="y">{pct(d.rates.wd_bps)}</b></div>
            <p className="note">Set by the platform admin. Contact them to change it.</p>
          </div>
          <div className="rqag">
            <p className="lbl">How commission works</p>
            <p className="note">Every level earns its own fixed share of each cash deposit and withdrawal in your network: the club agent that handled it, you, and the platform. A club agent&apos;s rate can never be set above yours, and every share is posted to the ledger when the transaction is approved.</p>
          </div>
        </div>
        <div className="card">
          <div className="rqtop"><div><h2 style={{ margin: 0 }}>Club agents performance directory</h2><p className="note">Your sub-agents&apos; rates, phones, status and CBE accounts.</p></div><span className="note">Realtime network auditing</span></div>
          {d.clubs.length === 0 ? <p className="note top">No club agents yet. Register one in the Agents tab.</p> : (
            <div className="tw"><table>
              <thead><tr><th>Agent club</th><th>Phone number</th><th>CBE account</th><th>Deposit rate</th><th>Withdrawal rate</th><th className="n">Balance</th><th>Status</th></tr></thead>
              <tbody>{d.clubs.map((c) => (
                <tr key={c.id}>
                  <td>{c.name}<div className="note">{c.username}</div></td><td>{c.phone ?? "-"}</td><td>{c.cbe_account ?? "-"}</td>
                  <td className="g">{pct(c.dep_bps)}</td><td className="y">{pct(c.wd_bps)}</td><td className="n b">{money(c.balance_minor)}</td>
                  <td><span className={"spill " + (c.status === "active" ? "s-completed" : "s-rejected")}>{c.status}</span></td>
                </tr>
              ))}</tbody>
            </table></div>
          )}
        </div>
      </div>
    </>
  );
}

function RegisterClubFull() {
  const qc = useQueryClient();
  const { data: d } = useDash();
  const maxDep = d?.rates.dep_bps ?? 0, maxWd = d?.rates.wd_bps ?? 0;
  const [f, setF] = useState({ display_name: "", phone: "", password: "", cbe: "", dep: 0, wd: 0, initial: "" });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const initial = Math.round(parseFloat(f.initial || "0") * 100);
  const set = (k: string, v: string | number) => { setOk(""); setF({ ...f, [k]: v }); };
  const create = useMutation({
    mutationFn: async () => (await api.post("/network/clubs", {
      phone: f.phone, display_name: f.display_name, password: f.password, cbe_account: f.cbe || undefined,
      deposit_rate_bps: Math.min(f.dep, maxDep), withdrawal_rate_bps: Math.min(f.wd, maxWd), initial_points_minor: initial > 0 ? initial : undefined,
    })).data,
    onSuccess: () => { setMsg(""); setOk("Club agent " + f.display_name + " created."); setF({ display_name: "", phone: "", password: "", cbe: "", dep: 0, wd: 0, initial: "" }); qc.invalidateQueries(); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  return (
    <div className="card">
      <h2>Register local club agent</h2>
      <form className="top" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label htmlFor="rc-n">Display name (club name)</label>
        <input id="rc-n" placeholder="e.g. Titan VIP Slot Club" value={f.display_name} onChange={(e) => set("display_name", e.target.value)} />
        <label htmlFor="rc-p">Phone number</label>
        <input id="rc-p" type="tel" inputMode="tel" placeholder="e.g. 0912345678" value={f.phone} onChange={(e) => set("phone", e.target.value)} />
        <label htmlFor="rc-w">Password (10+ characters, upper, lower, number)</label>
        <input id="rc-w" type="password" autoComplete="new-password" value={f.password} onChange={(e) => set("password", e.target.value)} />
        <label htmlFor="rc-c">CBE account number</label>
        <input id="rc-c" placeholder="e.g. 1000123456789" value={f.cbe} onChange={(e) => set("cbe", e.target.value)} />
        <label htmlFor="rc-d">Deposit commission rate: <b className="g">{Math.min(f.dep, maxDep) / 100}%</b></label>
        <input id="rc-d" type="range" min={0} max={maxDep} step={25} value={Math.min(f.dep, maxDep)} disabled={maxDep === 0} onChange={(e) => set("dep", Number(e.target.value))} />
        <p className="note">0% min . Max {maxDep / 100}% (your own rate)</p>
        <label htmlFor="rc-r">Withdrawal commission rate: <b className="y">{Math.min(f.wd, maxWd) / 100}%</b></label>
        <input id="rc-r" type="range" min={0} max={maxWd} step={25} value={Math.min(f.wd, maxWd)} disabled={maxWd === 0} onChange={(e) => set("wd", Number(e.target.value))} />
        <p className="note">0% min . Max {maxWd / 100}% (your own rate)</p>
        <label htmlFor="rc-i">Initial points top-up ($)</label>
        <input id="rc-i" type="number" inputMode="decimal" min="0" step="0.01" value={f.initial} onChange={(e) => set("initial", e.target.value)} />
        <p className="note">Points are deducted immediately from your available {money(d?.balance_minor ?? 0)}.</p>
        <button className="btn full" disabled={create.isPending || !f.phone || !f.display_name || f.password.length < 10}>{create.isPending ? "Creating..." : "Create and seed agent club"}</button>
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g top">{ok}</p>}
    </div>
  );
}

function Ledgers() {
  const { data = [], isLoading } = useQuery<Op[]>({ queryKey: ["sup-ledger"], queryFn: async () => (await api.get("/super/ledger?limit=150")).data, refetchInterval: 15000 });
  return (
    <div className="card">
      <h2>Your franchise ledger transactions</h2>
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No transactions yet.</p> : (
        <div className="tw"><table>
          <thead><tr><th>ID</th><th>Sender</th><th>Receiver</th><th>Operation</th><th>Notes</th><th className="n">Value payload</th><th>Time</th></tr></thead>
          <tbody>{data.map((o) => (
            <tr key={o.id}>
              <td className="note">tx-{o.id}</td><td>{o.sender ?? "System"}</td><td>{o.receiver ?? "System"}</td>
              <td><span className="tpill kind">{kindLabel(o.kind)}</span></td>
              <td><span className="note">{o.memo ?? ""}</span>{o.my_commission_minor > 0 && <div className="g">Your commission: {money(o.my_commission_minor)}</div>}</td>
              <td className="n b">{money(o.amount_minor)}</td><td>{when(o.created_at)}</td>
            </tr>
          ))}</tbody>
        </table></div>
      )}
    </div>
  );
}

function ReqTable({ rows, empty }: { rows: Req[]; empty: string }) {
  if (rows.length === 0) return <p className="note top">{empty}</p>;
  return (
    <div className="tw"><table>
      <thead><tr><th>Player</th><th>Type</th><th>Target agent club</th><th className="n">Amount</th><th>Method</th><th>Status</th><th>Details</th><th>Time</th></tr></thead>
      <tbody>{rows.map((r) => (
        <tr key={r.id}>
          <td>{r.player}<div className="note">ID: {r.player_id}</div></td><td><TypePill t={r.type} /></td><td>{r.club ?? ""}</td>
          <td className="n b">{money(r.amount_minor)}</td><td>{r.channel ?? "-"}</td>
          <td><span className={"spill s-" + r.status.toLowerCase()}>{r.status}</span></td>
          <td>
            <div className={r.reference ? "" : "note"}>{r.reference ?? (r.type === "deposit" ? "(Awaiting transfer reference)" : "-")}</div>
            {r.phone && <div className="note">Phone: {r.phone}</div>}{r.account && <div className="note">{r.channel}: {r.account}</div>}
          </td>
          <td>{when(r.created_at)}</td>
        </tr>
      ))}</tbody>
    </table></div>
  );
}

function Downline() {
  const { data = [], isLoading } = useQuery<Req[]>({ queryKey: ["sup-down"], queryFn: async () => (await api.get("/super/downline-requests")).data, refetchInterval: 8000 });
  const open = data.filter((r) => r.status === "PENDING" || r.status === "CLAIMED");
  const done = data.filter((r) => !(r.status === "PENDING" || r.status === "CLAIMED"));
  return (
    <div className="card">
      <div className="rqtop"><div><h2 style={{ margin: 0 }}>Downstream cashier pipeline audit</h2><p className="note">Supervise pending and completed player cashier requests across all of your agent clubs.</p></div><span className="note">Audit trail</span></div>
      {isLoading ? <p className="note">Loading...</p> : (
        <>
          <h3 className="y top">Pending downline requests</h3>
          <ReqTable rows={open} empty="No pending downline requests currently logged." />
          <h3 className="top">Completed downline requests history</h3>
          <ReqTable rows={done} empty="Nothing completed yet." />
        </>
      )}
    </div>
  );
}

function PointsTab() {
  return (
    <>
      <PointPool who="sub-agents" />
      <div style={{ marginTop: 20 }}><PointRequestForm to="Admin" /></div>
    </>
  );
}

const TABS = ["Overview", "Agents", "Ledgers", "Requests", "Point Requests", "Payment Accounts"] as const;

export default function SuperConsole({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<string>("Overview");
  const { data: d } = useDash();
  const badge = (t: string) => (t === "Requests" ? d?.pending_requests : t === "Point Requests" ? d?.pending_point_asks : 0) || 0;
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="tag">SUPER AGENT FRANCHISE PORTAL</div>
          <h1>{user.name}</h1>
          <p className="note">Downstream agent network: <b className="y">{d?.counts.clubs ?? 0} sub-agents</b> . Upstream node: {d?.upstream ?? "Admin"}</p>
        </div>
        <div className="head-right">
          <nav role="tablist">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>{t}{badge(t) > 0 && <span className="badge">{badge(t)}</span>}</button>
            ))}
          </nav>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main>
        {tab === "Overview" && <Overview />}
        {tab === "Agents" && <MoveCards who="sub-agent" lead={<RegisterClubFull />} />}
        {tab === "Ledgers" && <Ledgers />}
        {tab === "Requests" && <Downline />}
        {tab === "Point Requests" && <PointsTab />}
        {tab === "Payment Accounts" && <ChannelsTab path="/my/channels" />}
      </main>
      <footer className="pagefoot">Mika Games Platform Console . Single-API Game Router &amp; Multi-tier Network Active . Built for Ethiopian Market Compliance.</footer>
    </div>
  );
}
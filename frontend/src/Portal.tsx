import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";
import type { User } from "./App";
import { PointRequestForm, PointPool } from "./Points";
import { ChannelsTab } from "./ClubQueue";

const TABS = ["Overview", "Agents", "Ledgers", "Requests", "Point Requests", "Payment Accounts"] as const;
type Tab = (typeof TABS)[number];

function useGet<T>(key: string, url: string) {
  return useQuery<T>({ queryKey: [key], queryFn: async () => (await api.get(url)).data });
}

const when = (s: string) => new Date(s).toLocaleString();

function Status({ s }: { s: string }) {
  const cls = s === "approved" || s === "active" ? "ok" : s === "pending" ? "wait" : "no";
  return <span className={"pill " + cls}>{s}</span>;
}

type Overview = {
  credit_balance_minor: number;
  deposit_overrides_minor: number;
  withdraw_overrides_minor: number;
  override_commissions_minor: number;
  network_turnover_minor: number;
  club_agents: number;
  active_players: number;
};

function OverviewTab() {
  const { data: o, isLoading, error } = useGet<Overview>("overview", "/overview");
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !o) return <p className="err">Could not load the overview.</p>;
  return (
    <div className="grid">
      <div className="card">
        <p className="lbl">Franchise credit balance</p>
        <p className="big y">{money(o.credit_balance_minor)}</p>
        <p className="note">Credits available to fund your club agents.</p>
      </div>
      <div className="card">
        <p className="lbl">Override commissions</p>
        <p className="big g">{money(o.override_commissions_minor)}</p>
        <div className="row"><span>Deposit overrides</span><span className="g">+{money(o.deposit_overrides_minor)}</span></div>
        <div className="row"><span>Withdraw overrides</span><span className="r">{money(o.withdraw_overrides_minor)}</span></div>
        <p className="note top">Your slice of deposits and withdrawals in your network.</p>
      </div>
      <div className="card">
        <p className="lbl">Network turnover (bets)</p>
        <p className="big b">{money(o.network_turnover_minor)}</p>
        <p className="note">Total settled bets by players under your clubs.</p>
      </div>
      <div className="card">
        <p className="lbl">Active agents and players</p>
        <p className="big">{o.club_agents} <span className="note">clubs</span> &bull; {o.active_players} <span className="note">active</span></p>
        <p className="note">Size of your downstream network.</p>
      </div>
    </div>
  );
}

type Agent = { id: number; name: string; status: string; deposit_rate_bps: number | null; players: number; credit_balance_minor: number };

function AgentsTab() {
  const { data = [], isLoading } = useGet<Agent[]>("agents", "/agents");
  return (
    <div className="card">
      <h2>Club agents</h2>
      {isLoading ? <p className="note">Loading...</p> : (
        <div className="tw">
          <table>
            <thead><tr><th>Agent</th><th>Status</th><th className="n">Deposit rate</th><th className="n">Players</th><th className="n">Credit balance</th></tr></thead>
            <tbody>
              {data.map((a) => (
                <tr key={a.id}>
                  <td>{a.name}</td>
                  <td><Status s={a.status} /></td>
                  <td className="n">{a.deposit_rate_bps === null ? "-" : a.deposit_rate_bps / 100 + "%"}</td>
                  <td className="n">{a.players}</td>
                  <td className="n">{money(a.credit_balance_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type LedgerRow = { id: number; kind: string; memo: string | null; created_at: string; account_type: string; amount_minor: number; balance_after_minor: number };

function LedgersTab() {
  const { data = [], isLoading } = useGet<LedgerRow[]>("ledger", "/ledger");
  return (
    <div className="card">
      <h2>Ledger</h2>
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No transactions yet.</p> : (
        <div className="tw">
          <table>
            <thead><tr><th>Time</th><th>Type</th><th>Account</th><th>Detail</th><th className="n">Amount</th><th className="n">Balance after</th></tr></thead>
            <tbody>
              {data.map((l, i) => (
                <tr key={l.id + "-" + i}>
                  <td>{when(l.created_at)}</td>
                  <td>{l.kind}</td>
                  <td>{l.account_type}</td>
                  <td>{l.memo}</td>
                  <td className={"n " + (l.amount_minor < 0 ? "r" : "g")}>{l.amount_minor > 0 ? "+" : ""}{money(l.amount_minor)}</td>
                  <td className="n">{money(l.balance_after_minor)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type CreditReq = { id: number; requester: string; amount_minor: number; status: string; note: string | null; created_at: string };

function RequestsTab() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useGet<CreditReq[]>("credit", "/credit-requests");
  const [msg, setMsg] = useState("");
  const act = useMutation({
    mutationFn: async (v: { id: number; kind: "approve" | "reject" }) =>
      (await api.post("/credit-requests/" + v.id + "/" + v.kind)).data,
    onSuccess: () => {
      setMsg("");
      ["credit", "overview", "agents", "ledger"].forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => setMsg(errText(e)),
  });
  return (
    <div className="card">
      <h2>Credit requests from club agents</h2>
      {msg && <p className="err">{msg}</p>}
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No requests yet.</p> : (
        <div className="tw">
          <table>
            <thead><tr><th>Agent</th><th>Requested</th><th className="n">Amount</th><th>Status</th><th></th></tr></thead>
            <tbody>
              {data.map((q) => (
                <tr key={q.id}>
                  <td>{q.requester}</td>
                  <td>{when(q.created_at)}</td>
                  <td className="n">{money(q.amount_minor)}</td>
                  <td><Status s={q.status} /></td>
                  <td className="acts">
                    {q.status === "pending" && (
                      <>
                        <button className="btn" disabled={act.isPending} onClick={() => act.mutate({ id: q.id, kind: "approve" })}>Approve</button>
                        <button className="btn ghost" disabled={act.isPending} onClick={() => act.mutate({ id: q.id, kind: "reject" })}>Reject</button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

type PointReq = { id: number; player: string; club: string; type: string; amount_minor: number; status: string; created_at: string };

function PointsTab() {
  const { data = [], isLoading } = useGet<PointReq[]>("points", "/point-requests");
  return (
    <div className="card">
      <h2>Player point requests</h2>
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No point requests yet.</p> : (
        <div className="tw">
          <table>
            <thead><tr><th>Player</th><th>Club</th><th>Type</th><th>Requested</th><th className="n">Amount</th><th>Status</th></tr></thead>
            <tbody>
              {data.map((p) => (
                <tr key={p.id}>
                  <td>{p.player}</td><td>{p.club}</td><td>{p.type}</td><td>{when(p.created_at)}</td>
                  <td className="n">{money(p.amount_minor)}</td>
                  <td><Status s={p.status} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      <p className="note top">Club agents approve these. You can view them but not approve.</p>
    </div>
  );
}

export default function Portal({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("Overview");
  return (
    <div className="wrap">
      <header>
        <div>
          <div className="tag">SUPER AGENT FRANCHISE PORTAL</div>
          <h1>{user.name}</h1>
          <p className="note">Upstream node: Nexus Global Admin</p>
        </div>
        <div className="head-right">
          <nav role="tablist">
            {TABS.map((t) => (
              <button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>{t}</button>
            ))}
          </nav>
          <button className="btn ghost" onClick={onLogout}>Log out</button>
        </div>
      </header>
      <main>
        {tab === "Overview" && <OverviewTab />}
        {tab === "Agents" && <><MoveCards who="sub-agent" withRegister /><AgentsTab /></>}
        {tab === "Ledgers" && <LedgersTab />}
        {tab === "Requests" && <PointRequestForm to="Admin" />}
        {tab === "Point Requests" && <PointPool who="sub-agents" />}
        {tab === "Payment Accounts" && <ChannelsTab path="/my/channels" />}
      </main>
    </div>
  );
}
export { RequestsTab as LegacyRequestsTab, PointsTab as LegacyPointsTab };

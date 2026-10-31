import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";
import type { User } from "./App";
import { CashierForm } from "./Cashier";
import { GamesTab } from "./GamesLobby";
import { LimitsTab } from "./PlayerLimits";

const TABS = ["Wallet", "Games", "Deposit", "Withdraw", "History", "Limits"] as const;
type Tab = (typeof TABS)[number];
const KEYS = ["pl-overview", "pl-requests", "pl-ledger"];

function useGet<T>(key: string, url: string) {
  return useQuery<T>({ queryKey: [key], queryFn: async () => (await api.get(url)).data, refetchInterval: 15000 });
}
const when = (s: string) => new Date(s).toLocaleString();
const toMinor = (s: string) => Math.round(parseFloat(s) * 100);

function Status({ s }: { s: string }) {
  const cls = s === "approved" ? "ok" : s === "pending" ? "wait" : "no";
  return <span className={"pill " + cls}>{s}</span>;
}

type Ov = { name: string; club: string; status: string; credit_balance_minor: number; held_minor: number; pending_requests: number };

function WalletTab({ go }: { go: (t: Tab) => void }) {
  const { data: o, isLoading, error } = useGet<Ov>("pl-overview", "/player/overview");
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !o) return <p className="err">Could not load your wallet.</p>;
  return (
    <>
      {o.status !== "active" && <p className="err">Your account is {o.status}. Please contact your club agent.</p>}
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="lbl">Available balance</p>
        <p className="big y">{money(o.credit_balance_minor)}</p>
        {o.held_minor > 0 && <p className="note">{money(o.held_minor)} is on hold for a withdrawal.</p>}
        <p className="note top">Your club: {o.club}</p>
        {o.pending_requests > 0 && <p className="note">{o.pending_requests} request{o.pending_requests === 1 ? "" : "s"} waiting for your club agent.</p>}
      </div>
      <div className="two">
        <button className="btn" onClick={() => go("Deposit")}>Deposit</button>
        <button className="btn ghost" onClick={() => go("Withdraw")}>Withdraw</button>
      </div>
    </>
  );
}

function AmountForm({ title, help, button, path, max, done }: {
  title: string; help: string; button: string; path: string; max?: number; done: string;
}) {
  const qc = useQueryClient();
  const [amount, setAmount] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const send = useMutation({
    mutationFn: async () => (await api.post(path, { amount_minor: toMinor(amount) })).data,
    onSuccess: () => { setMsg(""); setOk(done); setAmount(""); KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const v = toMinor(amount);
  const tooMuch = max !== undefined && v > max;
  return (
    <div className="card">
      <h2>{title}</h2>
      <p className="note">{help}</p>
      <form className="top" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
        <label htmlFor="amt">Amount ($)</label>
        <input id="amt" type="number" inputMode="decimal" min="0.01" step="0.01" value={amount}
          onChange={(e) => { setOk(""); setAmount(e.target.value); }} />
        {tooMuch && <p className="err">That is more than your available balance.</p>}
        <button className="btn full" disabled={!(v > 0) || tooMuch || send.isPending}>{send.isPending ? "Sending..." : button}</button>
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g top">{ok}</p>}
    </div>
  );
}

type Pr = { id: number; type: string; amount_minor: number; status: string; created_at: string };
type Lg = { id: number; kind: string; memo: string | null; created_at: string; account_type: string; amount_minor: number; balance_after_minor: number };

function HistoryTab() {
  const reqs = useGet<Pr[]>("pl-requests", "/point-requests");
  const led = useGet<Lg[]>("pl-ledger", "/ledger");
  const moves = (led.data ?? []).filter((l) => l.account_type === "credit");
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <h2>Your requests</h2>
        {reqs.isLoading ? <p className="note">Loading...</p> : (reqs.data ?? []).length === 0 ? <p className="note">No requests yet.</p> : (
          <div className="tw"><table style={{ minWidth: 360 }}>
            <thead><tr><th>When</th><th>Type</th><th className="n">Amount</th><th>Status</th></tr></thead>
            <tbody>{(reqs.data ?? []).map((p) => (
              <tr key={p.id}><td>{when(p.created_at)}</td><td>{p.type}</td><td className="n">{money(p.amount_minor)}</td><td><Status s={p.status} /></td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="card">
        <h2>Balance movements</h2>
        {led.isLoading ? <p className="note">Loading...</p> : moves.length === 0 ? <p className="note">Nothing yet.</p> : (
          <div className="tw"><table style={{ minWidth: 360 }}>
            <thead><tr><th>When</th><th>What</th><th className="n">Amount</th><th className="n">Balance</th></tr></thead>
            <tbody>{moves.map((l, i) => (
              <tr key={l.id + "-" + i}>
                <td>{when(l.created_at)}</td><td>{l.kind.replace(/_/g, " ")}</td>
                <td className={"n " + (l.amount_minor < 0 ? "r" : "g")}>{l.amount_minor > 0 ? "+" : ""}{money(l.amount_minor)}</td>
                <td className="n">{money(l.balance_after_minor)}</td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export default function PlayerApp({ user, onLogout }: { user: User; onLogout: () => void }) {
  const [tab, setTab] = useState<Tab>("Wallet");
  const { data: o } = useGet<Ov>("pl-overview", "/player/overview");
  return (
    <div className={"wrap" + (tab === "Games" ? "" : " narrow")}>
      <header>
        <div>
          <div className="tag">PLAYER</div>
          <h1>{user.name}</h1>
        </div>
        <button className="btn ghost" onClick={onLogout}>Log out</button>
      </header>
      <nav role="tablist" style={{ marginBottom: 20 }}>
        {TABS.map((t) => (<button key={t} role="tab" aria-selected={t === tab} onClick={() => setTab(t)}>{t}</button>))}
      </nav>
      <main>
        {tab === "Wallet" && <WalletTab go={setTab} />}
        {tab === "Games" && <GamesTab />}
        {tab === "Deposit" && <CashierForm kind="deposit" />}
        {false && (
          <AmountForm title="Deposit" button="Send deposit request" path="/point-requests"
            help="Give the cash to your club agent, then send this request. Your balance is updated when your agent confirms they received it."
            done="Request sent. Your club agent will confirm it shortly." />
        )}
        {tab === "Withdraw" && <CashierForm kind="withdraw" max={o?.credit_balance_minor} />}
        {false && (
          <AmountForm title="Withdraw" button="Request withdrawal" path="/withdrawals" max={o?.credit_balance_minor}
            help={"Available to withdraw: " + money(o?.credit_balance_minor ?? 0) + ". The amount is put on hold now. Your club agent pays you the cash and confirms."}
            done="Withdrawal requested. The amount is on hold until your club agent pays you." />
        )}
        {tab === "History" && <HistoryTab />}
        {tab === "Limits" && <LimitsTab />}
      </main>
    </div>
  );
}
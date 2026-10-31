import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

const KEYS = ["admin-points", "admin-unsettled", "admin-runs", "admin-overview", "admin-users", "admin-reconcile", "admin-audit"];

function useGet<T>(key: string, url: string) {
  return useQuery<T>({ queryKey: [key], queryFn: async () => (await api.get(url)).data });
}
const when = (s: string) => new Date(s).toLocaleString();

type Pr = { id: number; player: string; club: string; type: string; amount_minor: number; status: string; created_at: string };

function ReverseRow({ p, onDone, onError }: { p: Pr; onDone: (m: string) => void; onError: (m: string) => void }) {
  const qc = useQueryClient();
  const [reason, setReason] = useState("");
  const rev = useMutation({
    mutationFn: async () => (await api.post("/admin/reversals", { point_request_id: p.id, reason })).data,
    onSuccess: (d) => {
      onDone("Reversed " + p.type + " #" + d.id + " (" + money(d.amount_minor) + ") and clawed back " + d.commissions_reversed + " commission entries.");
      KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => onError(errText(e)),
  });
  return (
    <tr>
      <td>#{p.id}</td><td>{p.player}</td><td>{p.club}</td><td>{p.type}</td><td>{when(p.created_at)}</td>
      <td className="n">{money(p.amount_minor)}</td>
      <td><span className={"pill " + (p.status === "approved" ? "ok" : "no")}>{p.status}</span></td>
      <td className="acts">
        {p.status === "approved" && (<>
          <input aria-label="Reason" placeholder="Reason" value={reason} onChange={(e) => setReason(e.target.value)} style={{ width: 170 }} />
          <button className="btn ghost" disabled={reason.trim().length < 3 || rev.isPending}
            onClick={() => { if (window.confirm("Reverse " + p.type + " #" + p.id + " for " + money(p.amount_minor) + "? This claws back all commissions on it.")) rev.mutate(); }}>
            Reverse
          </button>
        </>)}
      </td>
    </tr>
  );
}

export function ReversalsTab() {
  const { data = [], isLoading } = useGet<Pr[]>("admin-points", "/point-requests");
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");
  const rows = data.filter((p) => p.status === "approved" || p.status === "reversed");
  return (
    <div className="card">
      <h2>Reverse a deposit or withdrawal</h2>
      <p className="note">Moves the credits back, claws back every commission paid on it, and records your reason. It is blocked if the money has already been spent.</p>
      {err && <p className="err">{err}</p>}
      {ok && <p className="g">{ok}</p>}
      {isLoading ? <p className="note top">Loading...</p> : rows.length === 0 ? <p className="note top">No approved requests yet.</p> : (
        <div className="tw top"><table>
          <thead><tr><th>ID</th><th>Player</th><th>Club</th><th>Type</th><th>Requested</th><th className="n">Amount</th><th>Status</th><th></th></tr></thead>
          <tbody>{rows.map((p) => <ReverseRow key={p.id + p.status} p={p} onDone={(m) => { setErr(""); setOk(m); }} onError={(m) => { setOk(""); setErr(m); }} />)}</tbody>
        </table></div>
      )}
    </div>
  );
}

type Un = { id: number; name: string; role: string; accrued_minor: number };
type Run = { id: number; run_date: string; trigger: string; total_minor: number; users_count: number; created_at: string };

export function SettlementTab() {
  const qc = useQueryClient();
  const un = useGet<Un[]>("admin-unsettled", "/admin/unsettled");
  const runs = useGet<Run[]>("admin-runs", "/admin/settlements");
  const [ok, setOk] = useState("");
  const [err, setErr] = useState("");
  const settle = useMutation({
    mutationFn: async () => (await api.post("/admin/settle")).data,
    onSuccess: (d) => {
      setErr(""); setOk(d ? "Settled " + money(d.total_minor) + " to " + d.users + " agents (run #" + d.runId + ")." : "Nothing to do.");
      KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
    },
    onError: (e) => { setOk(""); setErr(errText(e)); },
  });
  const list = un.data ?? [];
  const total = list.reduce((a, x) => a + x.accrued_minor, 0);
  return (
    <>
      <div className="card" style={{ marginBottom: 20 }}>
        <h2>Unsettled commission</h2>
        <p className="note">Commission earned but not yet paid into agents&rsquo; credit balances.</p>
        {un.isLoading ? <p className="note top">Loading...</p> : list.length === 0 ? <p className="note top">Nothing waiting. Everything is settled.</p> : (
          <div className="tw top"><table>
            <thead><tr><th>Agent</th><th>Type</th><th className="n">Accrued</th></tr></thead>
            <tbody>{list.map((x) => <tr key={x.id}><td>{x.name}</td><td>{x.role}</td><td className="n g">{money(x.accrued_minor)}</td></tr>)}
              <tr><td><b>Total</b></td><td></td><td className="n"><b>{money(total)}</b></td></tr></tbody>
          </table></div>
        )}
        <button className="btn top" disabled={settle.isPending || list.length === 0}
          onClick={() => { if (window.confirm("Pay " + money(total) + " of commission into agents\u2019 credit balances now?")) settle.mutate(); }}>
          {settle.isPending ? "Settling..." : "Run settlement now"}
        </button>
        {err && <p className="err">{err}</p>}
        {ok && <p className="g">{ok}</p>}
      </div>
      <div className="card">
        <h2>Settlement history</h2>
        {runs.isLoading ? <p className="note">Loading...</p> : (runs.data ?? []).length === 0 ? <p className="note">No settlement runs yet.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Run</th><th>Date</th><th>How</th><th>Ran at</th><th className="n">Agents</th><th className="n">Total</th></tr></thead>
            <tbody>{(runs.data ?? []).map((r) => (
              <tr key={r.id}><td>#{r.id}</td><td>{r.run_date}</td><td>{r.trigger}</td><td>{when(r.created_at)}</td><td className="n">{r.users_count}</td><td className="n">{money(r.total_minor)}</td></tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
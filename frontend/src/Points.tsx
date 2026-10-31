import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

type Chan = { channel: string; phone: string; account_no: string | null };
type Ask = {
  id: number; type: string; amount_minor: number; reference: string | null; note: string | null; created_at: string;
  status: string; can_cancel: boolean; claimer: { name: string; channels: Chan[] } | null;
};
type PoolRow = { id: number; type: string; amount_minor: number; note: string | null; created_at: string; requester: string; requester_id: number };
type Claim = {
  id: number; type: string; amount_minor: number; reference: string | null; note: string | null; claim_expires_at: string;
  requester: string; requester_id: number; requester_balance_minor: number | null; channels: Chan[];
};

const when = (s: string) => new Date(s).toLocaleString();
const left = (iso: string) => {
  const s = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
};
const TypePill = ({ t }: { t: string }) => <span className={"tpill " + (t === "deposit" ? "tdep" : "twd")}>{t.toUpperCase()}</span>;
const Lines = ({ list }: { list: Chan[] }) => (
  <>{list.length === 0 ? <div className="note">No payment accounts saved</div> : list.map((c) => (
    <div key={c.channel}>{c.channel}: {c.account_no ? c.account_no + " / " : ""}{c.phone}</div>
  ))}</>
);

// Agent asks a super agent, or a super agent asks an admin
export function PointRequestForm({ to }: { to: string }) {
  const qc = useQueryClient();
  const [type, setType] = useState<"deposit" | "withdrawal">("deposit");
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const [ref, setRef] = useState<Record<number, string>>({});
  const asks = useQuery<Ask[]>({ queryKey: ["pa-mine"], queryFn: async () => (await api.get("/points/asks/mine")).data, refetchInterval: 5000 });
  const done = () => qc.invalidateQueries();
  const create = useMutation({
    mutationFn: async () => (await api.post("/points/asks", { type, amount_minor: Math.round(parseFloat(amount) * 100), note: note || undefined })).data,
    onSuccess: () => { setMsg(""); setOk("Request sent. The first available " + to.toLowerCase() + " will claim it."); setAmount(""); setNote(""); done(); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const sendRef = useMutation({
    mutationFn: async (id: number) => (await api.post("/points/asks/" + id + "/reference", { reference: ref[id] ?? "" })).data,
    onSuccess: () => { setMsg(""); done(); }, onError: (e) => setMsg(errText(e)),
  });
  const cancel = useMutation({
    mutationFn: async (id: number) => (await api.post("/points/asks/" + id + "/cancel")).data,
    onSuccess: () => { setMsg(""); done(); }, onError: (e) => setMsg(errText(e)),
  });
  const v = Math.round(parseFloat(amount) * 100);
  return (
    <div className="pgrid">
      <div className="card">
        <h2>Request point transfer</h2>
        <p className="note">Submit a points top-up (deposit) or cash-out (withdrawal) request to your {to}.</p>
        <p className="lbl top">Operation type</p>
        <div className="two">
          <button type="button" className={"opt" + (type === "deposit" ? " on" : "")} onClick={() => setType("deposit")}>DEPOSIT (TOP UP)</button>
          <button type="button" className={"opt" + (type === "withdrawal" ? " on" : "")} onClick={() => setType("withdrawal")}>WITHDRAWAL</button>
        </div>
        <p className="note top">{type === "deposit"
          ? "When a " + to.toLowerCase() + " claims your request, their account details appear here. Send the money, then enter your transaction reference."
          : "When a " + to.toLowerCase() + " claims your request they pay you the cash using your saved payment accounts, then confirm."}</p>
        <form onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
          <label htmlFor="pa-amt">Amount ($)</label>
          <input id="pa-amt" type="number" inputMode="decimal" min="1" step="0.01" value={amount} onChange={(e) => { setOk(""); setAmount(e.target.value); }} />
          <label htmlFor="pa-note">Notes / reason</label>
          <input id="pa-note" maxLength={200} placeholder="e.g. Settle weekend player deposits" value={note} onChange={(e) => setNote(e.target.value)} />
          <button className="btn full" disabled={!(v >= 100) || create.isPending}>{create.isPending ? "Sending..." : "Submit request to " + to}</button>
        </form>
        {msg && <p className="err">{msg}</p>}
        {ok && <p className="g top">{ok}</p>}
      </div>
      <div className="card">
        <h2>Point request history</h2>
        <p className="note">Track point requests you sent.</p>
        {asks.isLoading ? <p className="note">Loading...</p> : (asks.data ?? []).length === 0 ? <p className="note top">No point requests found.</p> : (asks.data ?? []).map((a) => (
          <div className="rqrow" key={a.id}>
            <div className="rqtop">
              <span><TypePill t={a.type} /> <b className="b">{money(a.amount_minor)}</b> <span className="note">#{a.id}</span></span>
              <span className={"spill s-" + a.status.toLowerCase()}>{a.status}</span>
            </div>
            <p className="note">{when(a.created_at)}{a.note ? " . " + a.note : ""}</p>
            {a.status === "OPEN" && <p className="note">Waiting for a {to.toLowerCase()} to claim it.</p>}
            {a.claimer && (
              <div className="rqag">
                <b>{a.claimer.name}</b>
                <Lines list={a.claimer.channels} />
                {a.type === "deposit" && a.status === "CLAIMED" && <p className="note">Send {money(a.amount_minor)} to one of these accounts, then enter your reference below.</p>}
              </div>
            )}
            {a.reference && <p className="g">Ref: {a.reference}</p>}
            {a.type === "deposit" && a.status === "CLAIMED" && !a.reference && (
              <form className="inline" onSubmit={(e) => { e.preventDefault(); sendRef.mutate(a.id); }}>
                <div><label>Transaction reference</label><input placeholder="Enter bank transaction reference" value={ref[a.id] ?? ""} onChange={(e) => setRef({ ...ref, [a.id]: e.target.value })} /></div>
                <button className="btn" disabled={(ref[a.id] ?? "").trim().length < 4 || sendRef.isPending}>I sent it</button>
              </form>
            )}
            {a.can_cancel && <button className="btn ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(a.id)}>Cancel request</button>}
          </div>
        ))}
      </div>
    </div>
  );
}

// Super agent sees agents' requests, admin sees super agents' requests
export function PointPool({ who }: { who: string }) {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const pool = useQuery<{ my_balance_minor: number; unlimited: boolean; requests: PoolRow[] }>({ queryKey: ["pa-pool"], queryFn: async () => (await api.get("/points/pool")).data, refetchInterval: 5000 });
  const claims = useQuery<Claim[]>({ queryKey: ["pa-claims"], queryFn: async () => (await api.get("/points/claims")).data, refetchInterval: 5000 });
  const act = useMutation({
    mutationFn: async (v: { id: number; what: string }) => (await api.post("/points/asks/" + v.id + "/" + v.what)).data,
    onSuccess: () => { setMsg(""); qc.invalidateQueries(); },
    onError: (e) => { setMsg(errText(e)); qc.invalidateQueries(); },
  });
  const run = (id: number, what: string, confirm?: string) => { if (confirm && !window.confirm(confirm)) return; act.mutate({ id, what }); };
  return (
    <>
      {msg && <p className="err">{msg}</p>}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="rqtop"><h2>Requests from my {who}</h2><span className="note">First come, first served{pool.data && !pool.data.unlimited ? ". Your balance: " + money(pool.data.my_balance_minor) : ""}</span></div>
        {pool.isLoading ? <p className="note">Loading...</p> : (pool.data?.requests ?? []).length === 0 ? <p className="note top">No open requests right now.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Requester</th><th>Type</th><th className="n">Amount</th><th>Notes / reason</th><th>Submitted</th><th>Account details</th><th></th></tr></thead>
            <tbody>{pool.data!.requests.map((r) => (
              <tr key={r.id}>
                <td>{r.requester}<div className="note">ID: {r.requester_id}</div></td><td><TypePill t={r.type} /></td>
                <td className="n">{money(r.amount_minor)}</td><td>{r.note ?? "-"}</td><td>{when(r.created_at)}</td>
                <td className="note">Locked until you claim</td>
                <td className="acts"><button className="btn" disabled={act.isPending} onClick={() => run(r.id, "claim")}>Claim</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="card">
        <h2>My active claims</h2>
        <p className="note">Top-ups: confirm the money arrived and the reference matches, then approve. Withdrawals: pay them first, then approve.</p>
        {claims.isLoading ? <p className="note">Loading...</p> : (claims.data ?? []).length === 0 ? <p className="note top">You have no active claims.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Requester</th><th>Type</th><th className="n">Amount</th><th>Unlocked details</th><th>Reference / notes</th><th>Time left</th><th></th></tr></thead>
            <tbody>{claims.data!.map((r) => (
              <tr key={r.id}>
                <td>{r.requester}<div className="note">ID: {r.requester_id} . Bal: {money(r.requester_balance_minor ?? 0)}</div></td>
                <td><TypePill t={r.type} /></td><td className="n">{money(r.amount_minor)}</td>
                <td><Lines list={r.channels} /></td>
                <td>
                  {r.type === "deposit" && <div className={r.reference ? "g" : "note"}>{r.reference ? "Ref: " + r.reference : "(Awaiting transaction reference)"}</div>}
                  {r.note && <div>{r.note}</div>}
                </td>
                <td>{left(r.claim_expires_at)}</td>
                <td className="acts">
                  <button className="btn" disabled={act.isPending} onClick={() => run(r.id, "approve",
                    r.type === "deposit" ? "Confirm you received " + money(r.amount_minor) + " from " + r.requester + "?" : "Confirm you paid " + money(r.amount_minor) + " to " + r.requester + "?")}>Approve</button>
                  <button className="btn ghost" disabled={act.isPending} onClick={() => run(r.id, "reject", "Reject this request?")}>Reject</button>
                  <button className="btn ghost" disabled={act.isPending} onClick={() => run(r.id, "release")}>Release</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
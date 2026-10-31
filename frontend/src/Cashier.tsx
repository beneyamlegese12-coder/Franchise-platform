import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

type Req = {
  id: number; type: string; amount_minor: number; channel: string | null; your_phone: string | null; your_account: string | null;
  transfer_ref: string | null; created_at: string; status: string; can_cancel: boolean;
  agent: { name: string; phone: string | null; account_no: string | null } | null;
};
const KEYS = ["pl-req2", "pl-overview", "pl-requests", "pl-ledger"];
const toMinor = (s: string) => Math.round(parseFloat(s) * 100);

function RequestLog() {
  const qc = useQueryClient();
  const { data = [], isLoading } = useQuery<Req[]>({ queryKey: ["pl-req2"], queryFn: async () => (await api.get("/requests/mine")).data, refetchInterval: 5000 });
  const [ref, setRef] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState("");
  const done = () => KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const sendRef = useMutation({
    mutationFn: async (id: number) => (await api.post("/requests/" + id + "/reference", { reference: ref[id] ?? "" })).data,
    onSuccess: () => { setMsg(""); done(); }, onError: (e) => setMsg(errText(e)),
  });
  const cancel = useMutation({
    mutationFn: async (id: number) => (await api.post("/requests/" + id + "/cancel")).data,
    onSuccess: () => { setMsg(""); done(); }, onError: (e) => setMsg(errText(e)),
  });
  return (
    <div className="card" style={{ marginTop: 16 }}>
      <h2>Request log &amp; live status</h2>
      {msg && <p className="err">{msg}</p>}
      {isLoading ? <p className="note">Loading...</p> : data.length === 0 ? <p className="note">No requests yet.</p> : data.map((r) => (
        <div className="rqrow" key={r.id}>
          <div className="rqtop">
            <span><span className={"tpill " + (r.type === "deposit" ? "tdep" : "twd")}>{r.type.toUpperCase()}</span> <b className="b">{money(r.amount_minor)}</b> <span className="note">{r.channel}</span></span>
            <span className={"spill s-" + r.status.toLowerCase()}>{r.status}</span>
          </div>
          <p className="note">{new Date(r.created_at).toLocaleString()}</p>
          {r.status === "OPEN" && <p className="note">Waiting for an agent to claim it.</p>}
          {r.agent && (
            <div className="rqag">
              <b>{r.agent.name}</b>
              {r.agent.phone && <div>Phone: {r.agent.phone}</div>}
              {r.agent.account_no && <div>{r.channel}: {r.agent.account_no}</div>}
              {r.type === "deposit" && r.status === "CLAIMED" && <p className="note">Send {money(r.amount_minor)} to this account, then enter your transfer reference below.</p>}
              {r.type === "withdrawal" && r.status === "CLAIMED" && <p className="note">This agent will pay you {money(r.amount_minor)} to the details you gave.</p>}
            </div>
          )}
          {r.type === "withdrawal" && r.your_account && <p className="note">Your {r.channel}: {r.your_account}</p>}
          {r.transfer_ref && <p className="g">Reference sent: {r.transfer_ref}</p>}
          {r.type === "deposit" && r.status === "CLAIMED" && !r.transfer_ref && (
            <form className="inline" onSubmit={(e) => { e.preventDefault(); sendRef.mutate(r.id); }}>
              <div><label>Transfer reference</label><input value={ref[r.id] ?? ""} onChange={(e) => setRef({ ...ref, [r.id]: e.target.value })} /></div>
              <button className="btn" disabled={(ref[r.id] ?? "").trim().length < 4 || sendRef.isPending}>I sent it</button>
            </form>
          )}
          {r.can_cancel && <button className="btn ghost" disabled={cancel.isPending} onClick={() => cancel.mutate(r.id)}>Cancel request</button>}
        </div>
      ))}
    </div>
  );
}

export function CashierForm({ kind, max }: { kind: "deposit" | "withdraw"; max?: number }) {
  const qc = useQueryClient();
  const dep = kind === "deposit";
  const [f, setF] = useState({ amount: "", channel: "CBE", phone: "", account_no: "", note: "" });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const v = toMinor(f.amount);
  const tooMuch = !dep && max !== undefined && v > max;
  const needAcct = !dep && f.channel !== "Telebirr";
  const send = useMutation({
    mutationFn: async () => (await api.post(dep ? "/requests/deposit" : "/requests/withdraw", {
      amount_minor: v, channel: f.channel, phone: f.phone, note: f.note || undefined, ...(needAcct ? { account_no: f.account_no } : {}),
    })).data,
    onSuccess: () => { setMsg(""); setOk("Request sent. The first available agent will claim it."); setF({ ...f, amount: "", note: "" }); KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] })); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const set = (k: string, x: string) => { setOk(""); setF({ ...f, [k]: x }); };
  return (
    <>
      <div className="card">
        <h2>{dep ? "Deposit" : "Withdraw"}</h2>
        <p className="note">{dep
          ? "Your request goes to all agents. Once one claims it you will see their account here, send the money, then enter your transfer reference."
          : "Available to withdraw: " + money(max ?? 0) + ". The amount is held now. The agent who claims it pays you and confirms."}</p>
        <form className="top" onSubmit={(e) => { e.preventDefault(); send.mutate(); }}>
          <label htmlFor="ca">Amount ($)</label>
          <input id="ca" type="number" inputMode="decimal" min="1" step="0.01" value={f.amount} onChange={(e) => set("amount", e.target.value)} />
          {tooMuch && <p className="err">That is more than your available balance.</p>}
          <label htmlFor="cc">Payment channel</label>
          <select id="cc" value={f.channel} onChange={(e) => set("channel", e.target.value)}>
            <option>CBE</option><option>Telebirr</option><option>Bank</option>
          </select>
          <label htmlFor="cp">Your phone number</label>
          <input id="cp" inputMode="tel" placeholder="+251..." value={f.phone} onChange={(e) => set("phone", e.target.value)} />
          {needAcct && (<><label htmlFor="cn">Your {f.channel} account number (we pay you here)</label><input id="cn" value={f.account_no} onChange={(e) => set("account_no", e.target.value)} /></>)}
          <label htmlFor="cm">Note (optional)</label>
          <input id="cm" maxLength={200} value={f.note} onChange={(e) => set("note", e.target.value)} />
          <button className="btn full" disabled={!(v >= 100) || tooMuch || f.phone.trim().length < 7 || (needAcct && f.account_no.trim().length < 6) || send.isPending}>
            {send.isPending ? "Sending..." : dep ? "Send deposit request" : "Request withdrawal"}
          </button>
        </form>
        {msg && <p className="err">{msg}</p>}
        {ok && <p className="g top">{ok}</p>}
      </div>
      <RequestLog />
    </>
  );
}
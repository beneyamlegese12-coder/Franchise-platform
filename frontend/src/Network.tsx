import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

type Agent = { id: number; name: string; phone: string | null; status: string; balance_minor: number };

function AgentPicker({ agents, value, onChange, placeholder }: { agents: Agent[]; value: number | null; onChange: (id: number) => void; placeholder: string }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(false);
  const sel = agents.find((a) => a.id === value);
  const needle = q.trim().toLowerCase();
  const list = agents.filter((a) => !needle || (a.name + " " + (a.phone ?? "") + " " + a.id).toLowerCase().includes(needle)).slice(0, 8);
  return (
    <div className="pick">
      <input aria-label="Search agents" placeholder={sel ? sel.name + " (" + (sel.phone ?? "no phone") + ")" : placeholder}
        value={q} onFocus={() => setOpen(true)} onBlur={() => setTimeout(() => setOpen(false), 150)}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }} />
      {sel && !open && <p className="note">Selected: {sel.name} . balance {money(sel.balance_minor)}</p>}
      {open && (
        <div className="pickl" role="listbox">
          {list.length === 0 ? <p className="note">No match</p> : list.map((a) => (
            <button type="button" key={a.id} role="option" aria-selected={a.id === value} onMouseDown={(e) => e.preventDefault()}
              onClick={() => { onChange(a.id); setQ(""); setOpen(false); }}>
              <b>{a.name}</b> <span className="note">ID {a.id} . {a.phone ?? "no phone"} . {money(a.balance_minor)}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function MoveCard({ kind, who, agents }: { kind: "fund" | "clawback"; who: string; agents: Agent[] }) {
  const qc = useQueryClient();
  const [target, setTarget] = useState<number | null>(null);
  const [amount, setAmount] = useState("");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const v = Math.round(parseFloat(amount) * 100);
  const t = agents.find((a) => a.id === target);
  const fund = kind === "fund";
  const go = useMutation({
    mutationFn: async () => (await api.post("/network/" + kind, { user_id: target, amount_minor: v, note: note || undefined })).data,
    onSuccess: (d: { agent: string; amount_minor: number }) => {
      setMsg(""); setOk((fund ? "Sent " : "Took back ") + money(d.amount_minor) + (fund ? " to " : " from ") + d.agent + ".");
      setAmount(""); setNote(""); qc.invalidateQueries();
    },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  function submit() {
    if (!t) return;
    const q = fund ? "Send " + money(v) + " to " + t.name + "?" : "Take " + money(v) + " back from " + t.name + "? They hold " + money(t.balance_minor) + ".";
    if (window.confirm(q)) go.mutate();
  }
  return (
    <div className="card">
      <h2>{fund ? "Top up " + who : "Clawback points from " + who}</h2>
      <form className="top" onSubmit={(e) => { e.preventDefault(); submit(); }}>
        <label>Select {who}</label>
        <AgentPicker agents={agents} value={target} onChange={(id) => { setOk(""); setTarget(id); }} placeholder="Search by ID, name, or phone..." />
        <label htmlFor={kind + "-amt"}>{fund ? "Transfer" : "Clawback"} amount ($)</label>
        <input id={kind + "-amt"} type="number" inputMode="decimal" min="1" step="0.01" value={amount} onChange={(e) => { setOk(""); setAmount(e.target.value); }} />
        <label htmlFor={kind + "-note"}>Notes</label>
        <input id={kind + "-note"} maxLength={200} placeholder={fund ? "e.g. Holiday season top-up" : "e.g. Inactive agent balance reduction"} value={note} onChange={(e) => setNote(e.target.value)} />
        <button className={"btn full" + (fund ? "" : " danger")} disabled={!t || !(v >= 100) || go.isPending}>{go.isPending ? "Working..." : fund ? "Top up" : "Pull points back"}</button>
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g top">{ok}</p>}
    </div>
  );
}

function RegisterClub() {
  const qc = useQueryClient();
  const [f, setF] = useState({ phone: "", display_name: "", password: "" });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const create = useMutation({
    mutationFn: async () => (await api.post("/network/clubs", f)).data,
    onSuccess: () => { setMsg(""); setOk("Club agent " + f.display_name + " registered. An admin sets their commission rates."); setF({ phone: "", display_name: "", password: "" }); qc.invalidateQueries(); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  return (
    <div className="card">
      <h2>Register local club agent</h2>
      <form className="top" onSubmit={(e) => { e.preventDefault(); create.mutate(); }}>
        <label htmlFor="rc-n">Display name (club name)</label>
        <input id="rc-n" placeholder="e.g. Titan VIP Slot Club" value={f.display_name} onChange={(e) => { setOk(""); setF({ ...f, display_name: e.target.value }); }} />
        <label htmlFor="rc-p">Phone number</label>
        <input id="rc-p" type="tel" inputMode="tel" placeholder="e.g. 0912345678" value={f.phone} onChange={(e) => setF({ ...f, phone: e.target.value })} />
        <label htmlFor="rc-w">Password (10+ characters, upper, lower, number)</label>
        <input id="rc-w" type="password" autoComplete="new-password" value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} />
        <button className="btn full" disabled={create.isPending || !f.phone || !f.display_name || f.password.length < 10}>{create.isPending ? "Registering..." : "Register club agent"}</button>
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g top">{ok}</p>}
    </div>
  );
}

export function MoveCards({ who, withRegister, lead }: { who: string; withRegister?: boolean; lead?: ReactNode }) {
  const { data = [], isLoading } = useQuery<Agent[]>({ queryKey: ["net-agents"], queryFn: async () => (await api.get("/network/agents")).data });
  if (isLoading) return <p className="note">Loading...</p>;
  return (
    <div className="net3" style={{ marginBottom: 20 }}>
      {lead}{withRegister && <RegisterClub />}
      <MoveCard kind="fund" who={who} agents={data} />
      <MoveCard kind="clawback" who={who} agents={data} />
    </div>
  );
}
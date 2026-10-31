import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

type L = { kind: string; amount_minor: number | null; pending_amount_minor: number | null; pending_from: string | null };
type D = { kyc_status: string; kyc_required: boolean; excluded_until: string | null; limits: L[]; usage: Record<string, number> };

const LABEL: Record<string, string> = {
  deposit_day: "Daily deposit limit", deposit_week: "Weekly deposit limit",
  deposit_month: "Monthly deposit limit", loss_day: "Daily loss limit",
};
const toMinor = (s: string) => Math.round(parseFloat(s) * 100);

function LimitRow({ l, used }: { l: L; used: number }) {
  const qc = useQueryClient();
  const [val, setVal] = useState("");
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const save = useMutation({
    mutationFn: async (a: number) => (await api.put("/player/limits", { kind: l.kind, amount_minor: a })).data,
    onSuccess: (d) => {
      setMsg("");
      setOk(d.applied ? "Saved. It applies now." : "Saved. Because it raises or removes your limit, it applies after 24 hours (" + new Date(d.effective_from).toLocaleString() + ").");
      setVal("");
      qc.invalidateQueries({ queryKey: ["pl-limits"] });
    },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  const v = toMinor(val);
  return (
    <div className="card" style={{ marginBottom: 12 }}>
      <p className="lbl">{LABEL[l.kind]}</p>
      <p className="big">{l.amount_minor === null ? "No limit" : money(l.amount_minor)}</p>
      {l.amount_minor !== null && <p className="note">Used so far: {money(used)}</p>}
      {l.pending_from && (
        <p className="note y">Waiting: {l.pending_amount_minor === 0 ? "limit will be removed" : "limit will change to " + money(l.pending_amount_minor ?? 0)} on {new Date(l.pending_from).toLocaleString()}.</p>
      )}
      <form className="inline top" onSubmit={(e) => { e.preventDefault(); save.mutate(v); }}>
        <div>
          <label htmlFor={"lim-" + l.kind}>New limit ($)</label>
          <input id={"lim-" + l.kind} type="number" inputMode="decimal" min="0.01" step="0.01" value={val} onChange={(e) => { setOk(""); setVal(e.target.value); }} />
        </div>
        <button className="btn" disabled={!(v > 0) || save.isPending}>Set</button>
        {l.amount_minor !== null && (
          <button type="button" className="btn ghost" disabled={save.isPending}
            onClick={() => { if (window.confirm("Remove this limit? It will take 24 hours to apply.")) save.mutate(0); }}>Remove</button>
        )}
      </form>
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g">{ok}</p>}
    </div>
  );
}

export function LimitsTab() {
  const qc = useQueryClient();
  const { data: d, isLoading, error } = useQuery<D>({ queryKey: ["pl-limits"], queryFn: async () => (await api.get("/player/limits")).data });
  const [days, setDays] = useState("7");
  const [msg, setMsg] = useState("");
  const exclude = useMutation({
    mutationFn: async () => (await api.post("/player/exclude", { days: Number(days) })).data,
    onSuccess: () => { setMsg(""); qc.invalidateQueries({ queryKey: ["pl-limits"] }); },
    onError: (e) => setMsg(errText(e)),
  });
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !d) return <p className="err">Could not load your limits.</p>;
  return (
    <>
      <div className="card" style={{ marginBottom: 16 }}>
        <p className="lbl">Identity check</p>
        <p className={"big " + (d.kyc_status === "verified" ? "g" : "y")}>{d.kyc_status === "verified" ? "Verified" : d.kyc_status === "rejected" ? "Not accepted" : "Not verified yet"}</p>
        {d.kyc_status !== "verified" && <p className="note">{d.kyc_required ? "You need to be verified before you can deposit, withdraw or play. " : ""}Ask your club agent to check your ID.</p>}
      </div>
      <h2>Your limits</h2>
      <p className="note" style={{ marginBottom: 12 }}>Lowering a limit applies straight away. Raising or removing one takes 24 hours.</p>
      {d.limits.map((l) => <LimitRow key={l.kind + "-" + l.amount_minor + "-" + l.pending_from} l={l} used={d.usage[l.kind] ?? 0} />)}
      <div className="card">
        <h2>Take a break</h2>
        {d.excluded_until ? (
          <p className="y">You have excluded yourself until {new Date(d.excluded_until).toLocaleString()}. You cannot deposit or play until then. You can still withdraw your money.</p>
        ) : (
          <>
            <p className="note">While excluded you cannot deposit or play, and you cannot end it early. You can always withdraw.</p>
            <form className="inline top" onSubmit={(e) => {
              e.preventDefault();
              if (window.confirm("Exclude yourself for " + days + " day(s)? You will not be able to undo this.")) exclude.mutate();
            }}>
              <div>
                <label htmlFor="ex">For how long</label>
                <select id="ex" value={days} onChange={(e) => setDays(e.target.value)}>
                  <option value="1">1 day</option><option value="7">7 days</option><option value="30">30 days</option>
                  <option value="180">180 days</option><option value="365">365 days</option>
                </select>
              </div>
              <button className="btn" disabled={exclude.isPending}>Exclude me</button>
            </form>
            {msg && <p className="err">{msg}</p>}
          </>
        )}
      </div>
    </>
  );
}
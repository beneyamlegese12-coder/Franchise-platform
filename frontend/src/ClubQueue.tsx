import { useEffect, useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, money, errText } from "./api";

type PoolRow = { id: number; type: string; amount_minor: number; channel: string | null; created_at: string; player: string; player_id: number };
type Mine = { id: number; type: string; amount_minor: number; channel: string | null; player_phone: string | null; player_account: string | null; player_note: string | null; transfer_ref: string | null; claim_expires_at: string; player: string; player_id: number };
type Chan = { channel: string; phone: string; account_no: string | null };

const KEYS = ["q-pool", "q-mine", "club-overview", "club-ledger", "club-points"];
const when = (s: string) => new Date(s).toLocaleString();
const left = (iso: string) => {
  const s = Math.max(0, Math.floor((new Date(iso).getTime() - Date.now()) / 1000));
  return Math.floor(s / 60) + "m " + String(s % 60).padStart(2, "0") + "s";
};
const Type = ({ t }: { t: string }) => <span className={"tpill " + (t === "deposit" ? "tdep" : "twd")}>{t.toUpperCase()}</span>;

export function QueueTab() {
  const qc = useQueryClient();
  const [msg, setMsg] = useState("");
  const [, tick] = useState(0);
  useEffect(() => { const t = setInterval(() => tick((x) => x + 1), 1000); return () => clearInterval(t); }, []);
  const pool = useQuery<{ my_credit_minor: number; requests: PoolRow[] }>({ queryKey: ["q-pool"], queryFn: async () => (await api.get("/queue/pool")).data, refetchInterval: 5000 });
  const mine = useQuery<Mine[]>({ queryKey: ["q-mine"], queryFn: async () => (await api.get("/queue/mine")).data, refetchInterval: 5000 });
  const refresh = () => KEYS.forEach((k) => qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({
    mutationFn: async (v: { id: number; path: string }) => (await api.post(v.path.replace("{id}", String(v.id)))).data,
    onSuccess: () => { setMsg(""); refresh(); },
    onError: (e) => { setMsg(errText(e)); refresh(); },
  });
  const run = (id: number, path: string, confirm?: string) => { if (confirm && !window.confirm(confirm)) return; act.mutate({ id, path }); };

  return (
    <>
      {msg && <p className="err">{msg}</p>}
      <div className="card" style={{ marginBottom: 20 }}>
        <div className="rqtop"><h2>Available requests pool</h2><span className="note">First come, first served. Your credit: {money(pool.data?.my_credit_minor ?? 0)}</span></div>
        {pool.isLoading ? <p className="note">Loading...</p> : (pool.data?.requests ?? []).length === 0 ? <p className="note top">No open requests right now.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Player</th><th>Type</th><th className="n">Amount</th><th>Channel</th><th>Account details</th><th>Waiting since</th><th></th></tr></thead>
            <tbody>{pool.data!.requests.map((r) => (
              <tr key={r.id}>
                <td>{r.player}<div className="note">ID: {r.player_id}</div></td><td><Type t={r.type} /></td>
                <td className="n">{money(r.amount_minor)}</td><td>{r.channel ?? "-"}</td>
                <td className="note">Locked until you claim</td><td>{when(r.created_at)}</td>
                <td className="acts"><button className="btn" disabled={act.isPending} onClick={() => run(r.id, "/queue/{id}/claim")}>Claim</button></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
      <div className="card">
        <h2>My active claims</h2>
        <p className="note">Deposits: confirm the money reached your account, then approve. Withdrawals: pay the player first, then approve.</p>
        {mine.isLoading ? <p className="note">Loading...</p> : (mine.data ?? []).length === 0 ? <p className="note top">You have no active claims.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Player</th><th>Type</th><th className="n">Amount</th><th>Channel</th><th>Unlocked details</th><th>Time left</th><th></th></tr></thead>
            <tbody>{mine.data!.map((r) => (
              <tr key={r.id}>
                <td>{r.player}<div className="note">ID: {r.player_id}</div></td><td><Type t={r.type} /></td>
                <td className="n">{money(r.amount_minor)}</td><td>{r.channel ?? "-"}</td>
                <td>
                  {r.type === "deposit" && <div className={r.transfer_ref ? "g" : "note"}>{r.transfer_ref ? "Ref: " + r.transfer_ref : "(Awaiting transfer reference)"}</div>}
                  {r.type === "withdrawal" && r.player_account && <div><b>{r.channel}: {r.player_account}</b></div>}
                  {r.player_phone && <div>Phone: {r.player_phone}</div>}
                  {r.player_note && <div className="note">Note: {r.player_note}</div>}
                </td>
                <td>{left(r.claim_expires_at)}</td>
                <td className="acts">
                  <button className="btn" disabled={act.isPending} onClick={() => run(r.id, "/point-requests/{id}/approve",
                    r.type === "deposit" ? "Confirm you received " + money(r.amount_minor) + " from " + r.player + "?" : "Confirm you paid " + money(r.amount_minor) + " to " + r.player + "?")}>Approve / Complete</button>
                  <button className="btn ghost" disabled={act.isPending} onClick={() => run(r.id, "/point-requests/{id}/reject", "Reject this request?")}>Reject</button>
                  <button className="btn ghost" disabled={act.isPending} onClick={() => run(r.id, "/queue/{id}/release")}>Release</button>
                </td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}

export function ChannelsTab({ path = "/club/channels" }: { path?: string }) {
  const qc = useQueryClient();
  const { data = [] } = useQuery<Chan[]>({ queryKey: ["club-channels"], queryFn: async () => (await api.get(path)).data });
  const [msg, setMsg] = useState("");
  const [ok, setOk] = useState("");
  const [draft, setDraft] = useState<Record<string, { phone: string; account_no: string }>>({});
  const val = (ch: string) => draft[ch] ?? { phone: data.find((d) => d.channel === ch)?.phone ?? "", account_no: data.find((d) => d.channel === ch)?.account_no ?? "" };
  const save = useMutation({
    mutationFn: async (ch: string) => (await api.put(path, { channel: ch, phone: val(ch).phone, account_no: val(ch).account_no || undefined })).data,
    onSuccess: (_d, ch) => { setMsg(""); setOk(ch + " saved"); qc.invalidateQueries({ queryKey: ["club-channels"] }); },
    onError: (e) => { setOk(""); setMsg(errText(e)); },
  });
  return (
    <div className="card">
      <h2>Payment accounts</h2>
      <p className="note">Where players send deposits. Players see these only after you claim their request. You need the matching channel saved before you can claim a deposit.</p>
      {["CBE", "Telebirr", "Bank"].map((ch) => (
        <form key={ch} className="inline top" onSubmit={(e) => { e.preventDefault(); save.mutate(ch); }}>
          <div><label>{ch} phone</label><input value={val(ch).phone} onChange={(e) => setDraft({ ...draft, [ch]: { ...val(ch), phone: e.target.value } })} /></div>
          {ch !== "Telebirr" && <div><label>{ch} account number</label><input value={val(ch).account_no} onChange={(e) => setDraft({ ...draft, [ch]: { ...val(ch), account_no: e.target.value } })} /></div>}
          <button className="btn" disabled={save.isPending || !val(ch).phone}>Save {ch}</button>
        </form>
      ))}
      {msg && <p className="err">{msg}</p>}
      {ok && <p className="g top">{ok}</p>}
    </div>
  );
}
import { useState } from "react";
import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { api, errText } from "./api";

type P = { id: number; name: string; username: string; kyc_status: string; date_of_birth: string | null; kyc_verified_at: string | null; kyc_note: string | null; excluded_until: string | null };

function Row({ p }: { p: P }) {
  const qc = useQueryClient();
  const [dob, setDob] = useState(p.date_of_birth ?? "");
  const [note, setNote] = useState("");
  const [msg, setMsg] = useState("");
  const act = useMutation({
    mutationFn: async (status: "verified" | "rejected") => (await api.post("/kyc/players/" + p.id, { status, date_of_birth: dob || undefined, note: note || undefined })).data,
    onSuccess: () => { setMsg(""); qc.invalidateQueries({ queryKey: ["kyc"] }); },
    onError: (e) => { setMsg(errText(e)); qc.invalidateQueries({ queryKey: ["kyc"] }); },
  });
  const cls = p.kyc_status === "verified" ? "ok" : p.kyc_status === "rejected" ? "no" : "wait";
  return (
    <tr>
      <td>{p.name}<div className="note">{p.username}</div></td>
      <td><span className={"pill " + cls}>{p.kyc_status === "none" ? "not checked" : p.kyc_status}</span>
        {p.excluded_until && new Date(p.excluded_until) > new Date() && <div className="note y">Self-excluded until {new Date(p.excluded_until).toLocaleDateString()}</div>}
      </td>
      <td><input aria-label="Date of birth" type="date" value={dob} onChange={(e) => setDob(e.target.value)} style={{ width: 160 }} /></td>
      <td><input aria-label="Note" placeholder="e.g. National ID checked in person" value={note} onChange={(e) => setNote(e.target.value)} style={{ width: 230 }} /></td>
      <td className="acts">
        <button className="btn" disabled={!dob || act.isPending} onClick={() => act.mutate("verified")}>Verify</button>
        <button className="btn ghost" disabled={act.isPending} onClick={() => act.mutate("rejected")}>Reject</button>
        {msg && <span className="err">{msg}</span>}
      </td>
    </tr>
  );
}

export function KycTab() {
  const { data = [], isLoading } = useQuery<P[]>({ queryKey: ["kyc"], queryFn: async () => (await api.get("/kyc/players")).data });
  return (
    <div className="card">
      <h2>Identity and age checks</h2>
      <p className="note">Check the player&rsquo;s ID in person, enter their date of birth, and verify. Players under 18 are refused automatically. Do not type ID numbers in the note.</p>
      {isLoading ? <p className="note top">Loading...</p> : (
        <div className="tw top"><table style={{ minWidth: 760 }}>
          <thead><tr><th>Player</th><th>Status</th><th>Date of birth</th><th>Note</th><th></th></tr></thead>
          <tbody>{data.map((p) => <Row key={p.id + "-" + p.kyc_status} p={p} />)}</tbody>
        </table></div>
      )}
    </div>
  );
}
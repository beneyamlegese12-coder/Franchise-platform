import { useQuery } from "@tanstack/react-query";
import { api, money } from "./api";

type Bet = { id: number; player: string; provider_tx_id: string; game_id: string | null; amount_minor: number; win_minor: number; status: string; created_at: string };
type G = {
  bets_minor: number; wins_minor: number; ggr_minor: number; settled: number; open: number; rolled_back: number;
  house_balance_minor: number; recent: Bet[];
};

export function GamesTab() {
  const { data: g, isLoading, error } = useQuery<G>({
    queryKey: ["admin-games"],
    queryFn: async () => (await api.get("/admin/games")).data,
    refetchInterval: 10000,
  });
  if (isLoading) return <p className="note">Loading...</p>;
  if (error || !g) return <p className="err">Could not load game activity.</p>;
  return (
    <>
      <div className="grid" style={{ marginBottom: 20 }}>
        <div className="card"><p className="lbl">Total bets (settled)</p><p className="big b">{money(g.bets_minor)}</p><p className="note">{g.settled} settled, {g.open} open, {g.rolled_back} rolled back.</p></div>
        <div className="card"><p className="lbl">Wins paid</p><p className="big y">{money(g.wins_minor)}</p><p className="note">Paid out to players.</p></div>
        <div className="card"><p className="lbl">GGR (bets minus wins)</p><p className={"big " + (g.ggr_minor >= 0 ? "g" : "r")}>{money(g.ggr_minor)}</p><p className="note">The house take on settled bets.</p></div>
        <div className="card"><p className="lbl">House balance</p><p className={"big " + (g.house_balance_minor >= 0 ? "g" : "r")}>{money(g.house_balance_minor)}</p><p className="note">Includes bets still open.</p></div>
      </div>
      <div className="card">
        <h2>Recent bets</h2>
        {g.recent.length === 0 ? <p className="note">No bets yet. Run the mock provider to create some.</p> : (
          <div className="tw"><table>
            <thead><tr><th>Time</th><th>Player</th><th>Game</th><th className="n">Bet</th><th className="n">Win</th><th>Status</th></tr></thead>
            <tbody>{g.recent.map((b) => (
              <tr key={b.id}>
                <td>{new Date(b.created_at).toLocaleString()}</td><td>{b.player}</td><td>{b.game_id ?? "-"}</td>
                <td className="n">{money(b.amount_minor)}</td><td className="n">{b.win_minor > 0 ? money(b.win_minor) : "-"}</td>
                <td><span className={"pill " + (b.status === "settled" ? "ok" : b.status === "open" ? "wait" : "no")}>{b.status.replace("_", " ")}</span></td>
              </tr>
            ))}</tbody>
          </table></div>
        )}
      </div>
    </>
  );
}
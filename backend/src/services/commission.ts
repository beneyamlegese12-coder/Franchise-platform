// Rates are in basis points: 500 = 5.00%. Each slice is rounded down;
// any rounding remainder goes to admin so the split always reconciles exactly.
export function splitDeposit(amount: number, clubBps: number, superBps: number, adminBps: number) {
  const club = Math.floor((amount * clubBps) / 10000);
  const sup = Math.floor((amount * superBps) / 10000);
  const adm = Math.floor((amount * adminBps) / 10000);
  const pool = Math.floor((amount * (clubBps + superBps + adminBps)) / 10000);
  return { club, sup, admin: adm + (pool - (club + sup + adm)), total: pool };
}
// Ethiopian mobile numbers. Any common way of typing one becomes +2519XXXXXXXX or +2517XXXXXXXX.
export function normalizePhone(input: string): string | null {
  let s = String(input ?? "").replace(/[\s\-().]/g, "");
  if (s.startsWith("+")) s = s.slice(1);
  else if (s.startsWith("00")) s = s.slice(2);
  if (s.startsWith("251")) s = s.slice(3);
  else if (s.startsWith("0")) s = s.slice(1);
  return /^[79]\d{8}$/.test(s) ? "+251" + s : null;
}
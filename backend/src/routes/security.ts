import { Router } from "express";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import QRCode from "qrcode";
import { z } from "zod";
import { pool, withTx } from "../db/pool.js";
import { auth } from "../auth.js";
import { HttpError } from "../errors.js";
import { newSecret, matchStep, otpauthUri, seal, unseal } from "../services/totp.js";

export const security = Router();

const MAX_FAILS = 5;
const loginLimiter = rateLimit({ windowMs: 60_000, limit: 20 });
const DUMMY = bcrypt.hashSync("not-a-real-password", 10);

export function checkPasswordPolicy(pw: string, username: string): string | null {
  if (pw.length < 10) return "Password must be at least 10 characters";
  if (!/[a-z]/.test(pw) || !/[A-Z]/.test(pw) || !/[0-9]/.test(pw)) return "Password needs an uppercase letter, a lowercase letter and a number";
  if (pw.toLowerCase().includes(username.toLowerCase())) return "Password must not contain your username";
  if (/demo#?2026/i.test(pw)) return "Choose a password different from the demo password";
  return null;
}

const log = (actor: number | null, action: string, entity: string, id: number | null, detail?: unknown) =>
  pool.query(
    "INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,$2,$3,$4,$5)",
    [actor, action, entity, id, detail ? JSON.stringify(detail) : null]
  );

security.post("/auth/login", loginLimiter, async (req, res) => {
  const p = z.object({
    username: z.string().min(1).max(60),
    password: z.string().min(1).max(200),
    code: z.string().max(10).optional(),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Username and password are required" }); return; }

  const u = (await pool.query("SELECT * FROM users WHERE username=$1", [p.data.username])).rows[0];
  if (!u) {
    await bcrypt.compare(p.data.password, DUMMY); // same timing whether or not the user exists
    res.status(401).json({ error: "Wrong username or password" });
    return;
  }
  if (u.locked_until && new Date(u.locked_until) > new Date()) {
    const mins = Math.ceil((new Date(u.locked_until).getTime() - Date.now()) / 60000);
    res.status(429).json({ error: "Too many failed attempts. Try again in " + mins + " minute(s)." });
    return;
  }
  const fail = async () => {
    const n = u.failed_attempts + 1;
    if (n >= MAX_FAILS) {
      await pool.query("UPDATE users SET failed_attempts=0, locked_until=now() + interval '15 minutes' WHERE id=$1", [u.id]);
      await log(null, "account_locked", "user", u.id, { after_failed_attempts: n });
    } else {
      await pool.query("UPDATE users SET failed_attempts=$2 WHERE id=$1", [u.id, n]);
    }
    res.status(401).json({ error: "Wrong username or password" });
  };

  if (!(await bcrypt.compare(p.data.password, u.password_hash))) { await fail(); return; }
  if (u.status !== "active") { res.status(403).json({ error: "Account is " + u.status }); return; }
  const origin = req.headers.origin;
  if (origin && origin === process.env.STAFF_ORIGIN && u.role === "player") { res.status(403).json({ error: "Players sign in on the player site, not the staff portal." }); return; }
  if (origin && origin === process.env.PLAYER_ORIGIN && u.role !== "player") { res.status(403).json({ error: "Staff sign in on the staff portal, not the player site." }); return; }

  if (u.totp_enabled) {
    if (!p.data.code) { res.json({ need_code: true }); return; }
    const step = matchStep(unseal(u.totp_secret), p.data.code);
    if (step === null || step <= Number(u.totp_last_step)) { await fail(); return; } // wrong, or an already-used code
    await pool.query("UPDATE users SET totp_last_step=$2 WHERE id=$1", [u.id, step]);
  }

  await pool.query("UPDATE users SET failed_attempts=0, locked_until=NULL WHERE id=$1", [u.id]);
  const token = jwt.sign({ id: u.id, role: u.role, username: u.username }, process.env.JWT_SECRET as string, { expiresIn: "4h" });
  res.json({ token, user: { id: u.id, role: u.role, username: u.username, name: u.display_name } });
});

security.get("/auth/me", auth(), async (req, res) => {
  const u = (await pool.query(
    "SELECT id, role, username, display_name, must_change_password, totp_enabled FROM users WHERE id=$1", [req.user!.id]
  )).rows[0];
  res.json({
    id: u.id, role: u.role, username: u.username, name: u.display_name,
    totp_enabled: u.totp_enabled,
    must_change_password: process.env.ENFORCE_PASSWORD_CHANGE === "true" && u.must_change_password,
    needs_2fa_setup: process.env.ENFORCE_2FA === "true" && u.role !== "player" && !u.totp_enabled,
  });
});

security.post("/auth/change-password", auth(), async (req, res) => {
  const p = z.object({ current_password: z.string().min(1).max(200), new_password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Both passwords are required" }); return; }
  const u = (await pool.query("SELECT username, password_hash FROM users WHERE id=$1", [req.user!.id])).rows[0];
  if (!(await bcrypt.compare(p.data.current_password, u.password_hash))) throw new HttpError(400, "Your current password is not correct");
  const bad = checkPasswordPolicy(p.data.new_password, u.username);
  if (bad) throw new HttpError(400, bad);
  if (p.data.new_password === p.data.current_password) throw new HttpError(400, "Choose a different password from your current one");
  await pool.query("UPDATE users SET password_hash=$2, must_change_password=false WHERE id=$1", [req.user!.id, await bcrypt.hash(p.data.new_password, 12)]);
  await log(req.user!.id, "change_password", "user", req.user!.id);
  res.json({ ok: true });
});

security.post("/auth/2fa/setup", auth(), async (req, res) => {
  const u = (await pool.query("SELECT username, totp_enabled FROM users WHERE id=$1", [req.user!.id])).rows[0];
  if (u.totp_enabled) throw new HttpError(409, "Two-factor authentication is already on");
  const secret = newSecret();
  await pool.query("UPDATE users SET totp_secret=$2 WHERE id=$1", [req.user!.id, seal(secret)]);
  res.json({ secret, uri: otpauthUri(u.username, secret), qr: await QRCode.toDataURL(otpauthUri(u.username, secret)) });
});

security.post("/auth/2fa/enable", auth(), async (req, res) => {
  const p = z.object({ code: z.string().min(6).max(10) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Enter the 6-digit code" }); return; }
  const u = (await pool.query("SELECT totp_secret FROM users WHERE id=$1", [req.user!.id])).rows[0];
  if (!u.totp_secret) throw new HttpError(400, "Start the setup first");
  const step = matchStep(unseal(u.totp_secret), p.data.code);
  if (step === null) throw new HttpError(400, "That code is not correct. Check your phone clock and try again.");
  await pool.query("UPDATE users SET totp_enabled=true, totp_last_step=$2 WHERE id=$1", [req.user!.id, step]);
  await log(req.user!.id, "enable_2fa", "user", req.user!.id);
  res.json({ ok: true });
});

security.post("/auth/2fa/disable", auth(), async (req, res) => {
  const p = z.object({ password: z.string().min(1).max(200), code: z.string().min(6).max(10) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "Password and code are required" }); return; }
  const u = (await pool.query("SELECT role, password_hash, totp_enabled, totp_secret, totp_last_step FROM users WHERE id=$1", [req.user!.id])).rows[0];
  if (!u.totp_enabled) throw new HttpError(409, "Two-factor authentication is not on");
  if (process.env.ENFORCE_2FA === "true" && u.role !== "player") throw new HttpError(403, "Two-factor is required for your role and cannot be turned off");
  if (!(await bcrypt.compare(p.data.password, u.password_hash))) throw new HttpError(400, "Your password is not correct");
  const step = matchStep(unseal(u.totp_secret), p.data.code);
  if (step === null || step <= Number(u.totp_last_step)) throw new HttpError(400, "That code is not correct, or was already used. Wait for a new one.");
  await pool.query("UPDATE users SET totp_enabled=false, totp_secret=NULL WHERE id=$1", [req.user!.id]);
  await log(req.user!.id, "disable_2fa", "user", req.user!.id);
  res.json({ ok: true });
});

// Admin tools for a user who lost their phone or forgot their password
security.post("/admin/users/:id/reset-2fa", auth(["admin"]), async (req, res) => {
  const id = Number(req.params.id);
  if (id === req.user!.id) throw new HttpError(400, "You cannot reset your own two-factor here");
  const r = await pool.query("UPDATE users SET totp_enabled=false, totp_secret=NULL, totp_last_step=0 WHERE id=$1 RETURNING id", [id]);
  if (!r.rowCount) throw new HttpError(404, "User not found");
  await log(req.user!.id, "reset_2fa", "user", id);
  res.json({ id, totp_enabled: false });
});

security.post("/admin/users/:id/reset-password", auth(["admin"]), async (req, res) => {
  const id = Number(req.params.id);
  const p = z.object({ new_password: z.string().min(1).max(200) }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: "new_password is required" }); return; }
  const u = (await pool.query("SELECT username FROM users WHERE id=$1", [id])).rows[0];
  if (!u) throw new HttpError(404, "User not found");
  const bad = checkPasswordPolicy(p.data.new_password, u.username);
  if (bad) throw new HttpError(400, bad);
  await pool.query(
    "UPDATE users SET password_hash=$2, must_change_password=true, failed_attempts=0, locked_until=NULL WHERE id=$1",
    [id, await bcrypt.hash(p.data.new_password, 12)]
  );
  await log(req.user!.id, "reset_password", "user", id);
  res.json({ id, must_change_password: true });
});

const registerLimiter = rateLimit({ windowMs: 3_600_000, limit: 10 });

security.post("/auth/register", registerLimiter, async (req, res) => {
  const p = z.object({
    username: z.string().regex(/^[a-z0-9_]{3,30}$/, "Username: 3-30 lowercase letters, numbers or underscores"),
    display_name: z.string().trim().min(1, "Enter your name").max(60),
    password: z.string().min(1, "Choose a password").max(200),
    date_of_birth: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Enter your date of birth"),
  }).safeParse(req.body);
  if (!p.success) { res.status(400).json({ error: p.error.issues[0].message }); return; }

  const d = new Date(p.data.date_of_birth + "T00:00:00Z");
  if (isNaN(d.getTime())) throw new HttpError(400, "Enter a valid date of birth");
  const now = new Date();
  let age = now.getUTCFullYear() - d.getUTCFullYear();
  if (now.getUTCMonth() < d.getUTCMonth() || (now.getUTCMonth() === d.getUTCMonth() && now.getUTCDate() < d.getUTCDate())) age--;
  if (age < 0 || age > 120) throw new HttpError(400, "Enter a valid date of birth");
  const minAge = Number(process.env.MIN_AGE) || 18;
  if (age < minAge) throw new HttpError(400, "You must be at least " + minAge + " years old to register");

  const bad = checkPasswordPolicy(p.data.password, p.data.username);
  if (bad) throw new HttpError(400, bad);

  const club = (await pool.query(
    "SELECT id FROM users WHERE username=$1 AND role='club' AND status='active'",
    [process.env.DEFAULT_CLUB_USERNAME || "club_alpha"]
  )).rows[0];
  if (!club) throw new HttpError(503, "Registration is not available right now");

  try {
    const hash = await bcrypt.hash(p.data.password, 12);
    const id = await withTx(async (c) => {
      const u = await c.query(
        "INSERT INTO users (role, parent_id, username, display_name, password_hash, date_of_birth, must_change_password) VALUES ('player',$1,$2,$3,$4,$5,false) RETURNING id",
        [club.id, p.data.username, p.data.display_name, hash, p.data.date_of_birth]
      );
      await c.query("INSERT INTO accounts (user_id, type) VALUES ($1,'credit')", [u.rows[0].id]);
      await c.query("INSERT INTO audit_logs (actor_id, action, entity, entity_id, detail) VALUES ($1,'self_register','user',$1,$2)", [u.rows[0].id, JSON.stringify({ club_id: club.id })]);
      return u.rows[0].id as number;
    });
    const token = jwt.sign({ id, role: "player", username: p.data.username }, process.env.JWT_SECRET as string, { expiresIn: "4h" });
    res.status(201).json({ token, user: { id, role: "player", username: p.data.username, name: p.data.display_name } });
  } catch (e: any) {
    if (e?.code === "23505") { res.status(409).json({ error: "That username is already taken" }); return; }
    throw e;
  }
});
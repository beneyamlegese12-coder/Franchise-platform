import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { pool } from "./db/pool.js";

export type AuthUser = { id: number; role: string; username: string };

declare module "express-serve-static-core" {
  interface Request { user?: AuthUser }
}

// These stay reachable so a user can finish the forced steps.
const OPEN = [
  "/api/v1/auth/me",
  "/api/v1/auth/change-password",
  "/api/v1/auth/2fa/setup",
  "/api/v1/auth/2fa/enable",
];

export function auth(roles?: string[]) {
  return async (req: Request, res: Response, next: NextFunction) => {
    const h = req.headers.authorization || "";
    const token = h.startsWith("Bearer ") ? h.slice(7) : "";
    let id: number;
    try {
      id = (jwt.verify(token, process.env.JWT_SECRET as string) as AuthUser).id;
    } catch {
      res.status(401).json({ error: "Please log in" });
      return;
    }
    try {
      // The account is checked live, so freezing someone takes effect immediately.
      const r = await pool.query(
        "SELECT id, role, username, status, must_change_password, totp_enabled FROM users WHERE id=$1", [id]
      );
      const u = r.rows[0];
      if (!u) { res.status(401).json({ error: "Please log in" }); return; }
      if (u.status !== "active") {
        res.status(403).json({ error: "Your account is " + u.status + ". Please contact your club agent." });
        return;
      }
      const path = req.originalUrl.split("?")[0];
      if (!OPEN.includes(path)) {
        if (process.env.ENFORCE_PASSWORD_CHANGE === "true" && u.must_change_password) {
          res.status(403).json({ error: "Please change your password first." });
          return;
        }
        if (process.env.ENFORCE_2FA === "true" && u.role !== "player" && !u.totp_enabled) {
          res.status(403).json({ error: "Please set up two-factor authentication first." });
          return;
        }
      }
      if (roles && !roles.includes(u.role)) {
        res.status(403).json({ error: "Your role cannot do this" });
        return;
      }
      req.user = { id: u.id, role: u.role, username: u.username };
      next();
    } catch (e) {
      next(e);
    }
  };
}
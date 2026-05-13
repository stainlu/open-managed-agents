import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import type { UserStore } from "./store/types.js";

// Multi-source bearer-token auth for the orchestrator's public API.
//
// Token resolution order:
//   1. Admin token (OPENCLAW_API_TOKEN) — constant-time compare, full access,
//      no user_id scoping. Used by operators and deploy scripts.
//   2. User token (tok_xxx) — looked up in the users table. Scopes all
//      resource queries to the user's user_id. Expired anonymous tokens → 401.
//   3. Parent token (X-OpenClaw-Parent-Token) — admitted only on the
//      narrow in-container delegation paths. The orchestrator verifies
//      and scopes the token after auth because verification needs the
//      ParentTokenMinter owned by server.ts.
//   4. No token → 401 (unless auth is disabled or route is bypassed).
//
// The resolved identity is injected into Hono's context:
//   c.get('authRole')  → 'admin' | 'user' | 'parent-token'
//   c.get('userId')    → string | undefined (undefined for admin)

export type AuthConfig = {
  token: string | undefined;
  users?: UserStore;
};

const BYPASS_PATHS = new Set(["/healthz", "/metrics", "/v2", "/"]);
const AUTH_PATHS = new Set(["/auth/anonymous", "/auth/github", "/auth/github/callback"]);

function isParentTokenRoute(method: string, path: string): boolean {
  if (method === "POST" && path === "/v1/sessions") return true;
  if (method === "GET" && /^\/v1\/sessions\/[^/]+$/.test(path)) return true;
  if (method === "POST" && /^\/v1\/sessions\/[^/]+\/events$/.test(path)) return true;
  if (method === "GET" && /^\/v1\/sessions\/[^/]+\/events$/.test(path)) return true;
  return false;
}

export function createAuthMiddleware(cfg: AuthConfig): MiddlewareHandler {
  const expected = cfg.token?.trim();
  if (!expected) {
    return async (c, next) => {
      c.set("authRole", "admin");
      await next();
    };
  }

  const expectedBuf = Buffer.from(expected, "utf8");

  return async (c, next) => {
    if (BYPASS_PATHS.has(c.req.path) || AUTH_PATHS.has(c.req.path)) {
      await next();
      return;
    }

    const header = c.req.header("authorization") ?? c.req.header("Authorization");
    const queryToken = c.req.query("token");
    if (!header && !queryToken) {
      const parentToken = c.req.header("x-openclaw-parent-token");
      if (parentToken && isParentTokenRoute(c.req.method, c.req.path)) {
        c.set("authRole", "parent-token");
        await next();
        return;
      }
      return c.json(
        { error: "unauthorized", message: "missing Authorization header (expected: Bearer <token>)" },
        401,
      );
    }

    let provided = "";
    if (header) {
      const match = header.match(/^bearer\s+(.+)$/i);
      if (!match) {
        return c.json({ error: "unauthorized", message: "Authorization header must use Bearer scheme" }, 401);
      }
      provided = match[1]?.trim() ?? "";
    } else if (queryToken) {
      provided = queryToken.trim();
    }
    if (!provided) {
      return c.json({ error: "unauthorized", message: "empty bearer token" }, 401);
    }

    // Check 1: admin token (constant-time)
    const providedBuf = Buffer.from(provided, "utf8");
    let isAdmin = false;
    if (providedBuf.length === expectedBuf.length) {
      isAdmin = timingSafeEqual(providedBuf, expectedBuf);
    } else {
      const pad = Buffer.alloc(expectedBuf.length, 0);
      try { timingSafeEqual(pad, expectedBuf); } catch { /* timing pad */ }
    }

    if (isAdmin) {
      c.set("authRole", "admin");
      await next();
      return;
    }

    // Check 2: user token
    if (cfg.users) {
      const user = cfg.users.getByToken(provided);
      if (user) {
        if (user.expiresAt && user.expiresAt < Date.now()) {
          return c.json({ error: "token_expired", message: "anonymous trial expired — sign in with GitHub" }, 401);
        }
        c.set("authRole", "user");
        c.set("userId", user.userId);
        c.set("userTier", user.tier);
        await next();
        return;
      }
    }

    return c.json({ error: "unauthorized", message: "invalid token" }, 401);
  };
}

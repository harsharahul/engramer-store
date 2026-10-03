/**
 * What the client reads out of its own bearer token: the moment it was
 * minted. The client holds no signing key and verifies nothing; the
 * issue time only decides when to ask the server for a fresh token, so
 * a device that reopens with Face ID or Touch ID and never types the
 * password again does not run into the end of the token it signed in
 * with. The extensions read the same moment from the record the app
 * stores, which is what lets them say "open the app" a day early
 * instead of failing on every request once the token has ended.
 */

/** Tokens are minted for thirty days; the server's word is final. */
export const TOKEN_LIFETIME_MS = 30 * 24 * 3600 * 1000;

/** Renew once a token has been in service for a day. Cheap enough to
 * ask on every foreground, and early enough that a device opened even
 * once a fortnight never comes near the end. */
export const RENEW_AFTER_MS = 24 * 3600 * 1000;

/** The token's iat claim in milliseconds, or null for anything that
 * does not parse as a signed JSON token. */
export function tokenIssuedAtMs(token: string): number | null {
  const parts = token.split(".");
  if (parts.length !== 3 || !parts[1]) {
    return null;
  }
  try {
    const body = parts[1].replace(/-/g, "+").replace(/_/g, "/");
    const padded = body + "=".repeat((4 - (body.length % 4)) % 4);
    const claims = JSON.parse(atob(padded)) as { iat?: unknown };
    return typeof claims.iat === "number" && Number.isFinite(claims.iat) ? claims.iat * 1000 : null;
  } catch {
    return null;
  }
}

/** True once the token has served long enough to be worth renewing. A
 * token whose issue time cannot be read is left alone: renewing on a
 * guess would hammer the server with a request per foreground. */
export function tokenDueForRenewal(token: string, now = Date.now()): boolean {
  const issued = tokenIssuedAtMs(token);
  return issued !== null && now - issued > RENEW_AFTER_MS;
}

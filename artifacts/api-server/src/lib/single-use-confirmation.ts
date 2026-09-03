import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type ConfirmationCheck =
  | { ok: true }
  | { ok: false; status: number; reason: string; message: string };

/**
 * Generic preview-before-action interlock. Replay tracking is intentionally
 * process-local and is lost on restart; callers must therefore keep the
 * confirmed action idempotent as a second line of defense.
 */
export function createSingleUseConfirmation(options: {
  scope: string;
  ttlMs: number;
  messages: {
    required: string;
    mismatch: string;
    expired: string;
    used: string;
  };
}) {
  const key = createHmac("sha256", process.env.SESSION_SECRET || randomBytes(32))
    .update(options.scope)
    .digest();
  const spent = new Map<string, number>();
  const sign = (expiry: number, nonce: string, fingerprint: string) =>
    createHmac("sha256", key)
      .update(`${expiry}.${nonce}.${fingerprint}`)
      .digest("base64url");

  return {
    issue(fingerprint: string, now: Date) {
      const expiry = now.getTime() + options.ttlMs;
      const nonce = randomBytes(12).toString("base64url");
      return {
        token: `${expiry}.${nonce}.${sign(expiry, nonce, fingerprint)}`,
        expiresAt: new Date(expiry),
      };
    },
    verify(token: unknown, fingerprint: string, now: Date): ConfirmationCheck {
      if (typeof token !== "string" || token.length === 0) {
        return { ok: false, status: 400, reason: "confirmation_required", message: options.messages.required };
      }
      const mismatch: ConfirmationCheck = {
        ok: false,
        status: 409,
        reason: "confirmation_mismatch",
        message: options.messages.mismatch,
      };
      const parts = token.split(".");
      if (parts.length !== 3) return mismatch;
      const [expiryRaw, nonce, supplied] = parts;
      const expiry = Number(expiryRaw);
      if (!Number.isFinite(expiry) || !nonce || !supplied) return mismatch;
      const expected = sign(expiry, nonce, fingerprint);
      const suppliedBytes = Buffer.from(supplied);
      const expectedBytes = Buffer.from(expected);
      if (suppliedBytes.length !== expectedBytes.length || !timingSafeEqual(suppliedBytes, expectedBytes)) {
        return mismatch;
      }
      const nowMs = now.getTime();
      for (const [spentNonce, spentExpiry] of spent) {
        if (spentExpiry <= nowMs) spent.delete(spentNonce);
      }
      if (expiry <= nowMs) {
        return { ok: false, status: 409, reason: "confirmation_expired", message: options.messages.expired };
      }
      if (spent.has(nonce)) {
        return { ok: false, status: 409, reason: "confirmation_used", message: options.messages.used };
      }
      spent.set(nonce, expiry);
      return { ok: true };
    },
  };
}
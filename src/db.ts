import { createHmac, timingSafeEqual } from "crypto";

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
if (!INTERNAL_API_SECRET) throw new Error("INTERNAL_API_SECRET not set");

function sign(payload: string): string {
  return createHmac("sha256", INTERNAL_API_SECRET!).update(payload).digest("hex");
}

export function verifyTicket(
  ticket: string,
): { userId: number; username: string } | null {
  const parts = ticket.split(".");
  if (parts.length !== 4) return null;
  const [userIdStr, username, expiresAtStr, sig] = parts;
  const expected = sign(`${userIdStr}.${username}.${expiresAtStr}`);
  const a = Buffer.from(sig, "hex");
  const b = Buffer.from(expected, "hex");
  if (a.length !== b.length) return null;
  if (!timingSafeEqual(a, b)) return null;
  const expiresAt = Number(expiresAtStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return null;
  const userId = Number(userIdStr);
  if (!Number.isInteger(userId)) return null;
  return { userId, username };
}

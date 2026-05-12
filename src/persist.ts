const SVELTEKIT_INTERNAL_URL = process.env.SVELTEKIT_INTERNAL_URL;
const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;

if (!SVELTEKIT_INTERNAL_URL) throw new Error("SVELTEKIT_INTERNAL_URL not set");
if (!INTERNAL_API_SECRET) throw new Error("INTERNAL_API_SECRET not set");

export type Result = "white" | "black" | "draw";
export type EndReason =
  | "checkmate"
  | "stalemate"
  | "threefold"
  | "insufficient"
  | "fifty_move"
  | "resign"
  | "agreement"
  | "timeout"
  | "disconnect";

export async function fetchFriendIds(userId: number): Promise<number[]> {
  try {
    const res = await fetch(
      `${SVELTEKIT_INTERNAL_URL}/api/internal/friends?userId=${userId}`,
      {
        headers: { "x-internal-secret": INTERNAL_API_SECRET! },
      },
    );
    if (!res.ok) {
      console.error("fetchFriendIds: SvelteKit returned", res.status);
      return [];
    }
    const body = (await res.json()) as { ids?: number[] };
    return Array.isArray(body.ids) ? body.ids : [];
  } catch (err) {
    console.error("fetchFriendIds: fetch failed", err);
    return [];
  }
}

export async function persistResult(args: {
  whiteId: number;
  blackId: number;
  result: Result;
  endReason: EndReason;
}): Promise<void> {
  try {
    const res = await fetch(
      `${SVELTEKIT_INTERNAL_URL}/api/internal/game-result`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-internal-secret": INTERNAL_API_SECRET!,
        },
        body: JSON.stringify(args),
      },
    );
    if (!res.ok) {
      console.error("persistResult: SvelteKit returned", res.status, await res.text());
    }
  } catch (err) {
    console.error("persistResult: fetch failed", err);
  }
}

import { WebSocketServer } from "ws";
import type { WebSocket as WS } from "ws";
import { Chess } from "chess.js";
import { randomInt, randomUUID, type UUID } from "crypto";
import type { IncomingMessage } from "http";
import { verifyTicket } from "./db.ts";
import { persistResult, type EndReason, type Result } from "./persist.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;

declare module "ws" {
  interface WebSocket {
    color?: "white" | "black";
    roomId?: UUID;
    userId?: number;
    isAlive?: boolean;
  }
}

type Room = {
  white: WS;
  black: WS;
  whiteId: number;
  blackId: number;
  chess: Chess;
};

const wss = new WebSocketServer({
  port: 8080,
  maxPayload: 1024 * 10,
  handleProtocols: (protocols) => {
    for (const p of protocols) {
      if (p.startsWith("ticket.")) return p;
    }
    return false;
  },
});

const queue: WS[] = [];
const Rooms = new Map<UUID, Room>();

function pairing(player: WS): void {
  queue.push(player);
  player.send(JSON.stringify({ type: "finding" }));

  if (queue.length < 2) return;

  const [p1, p2] = [queue.shift()!, queue.shift()!];
  const [white, black] = randomInt(2) ? [p1, p2] : [p2, p1];
  const roomId = randomUUID();

  white.color = "white";
  black.color = "black";
  white.roomId = roomId;
  black.roomId = roomId;

  Rooms.set(roomId, {
    white,
    black,
    whiteId: white.userId!,
    blackId: black.userId!,
    chess: new Chess(),
  });

  white.send(JSON.stringify({ type: "match", color: "white" }));
  black.send(JSON.stringify({ type: "match", color: "black" }));
}

function endReasonFromChess(chess: Chess): EndReason | null {
  if (!chess.isGameOver()) return null;
  if (chess.isCheckmate()) return "checkmate";
  if (chess.isStalemate()) return "stalemate";
  if (chess.isThreefoldRepetition()) return "threefold";
  if (chess.isInsufficientMaterial()) return "insufficient";
  if (chess.isDraw()) return "fifty_move";
  return null;
}

function handleMove(
  player: WS,
  from: string,
  to: string,
  promotion: string | undefined,
): void {
  const room = Rooms.get(player.roomId!);
  if (!room) return;

  const moveResult = room.chess.move({ from, to, promotion });
  if (!moveResult) return;

  const opposite = player.color === "white" ? room.black : room.white;
  opposite.send(JSON.stringify({ type: "move", from, to, promotion }));

  const reason = endReasonFromChess(room.chess);
  if (!reason) return;

  let result: Result;
  if (reason === "checkmate") {
    result = player.color === "white" ? "white" : "black";
  } else {
    result = "draw";
  }

  for (const sock of [room.white, room.black]) {
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify({ type: "game_over", result, reason }));
    }
  }

  Rooms.delete(player.roomId!);
  void persistResult({
    whiteId: room.whiteId,
    blackId: room.blackId,
    result,
    endReason: reason,
  });
}

function handleDisconnect(player: WS): void {
  const queueIdx = queue.indexOf(player);
  if (queueIdx !== -1) queue.splice(queueIdx, 1);

  if (!player.roomId) return;
  const room = Rooms.get(player.roomId);
  if (!room) return;

  const opponent = player.color === "white" ? room.black : room.white;
  if (opponent.readyState === opponent.OPEN) {
    opponent.send(JSON.stringify({ type: "opponent_left" }));
  }
  Rooms.delete(player.roomId);

  const result: Result = player.color === "white" ? "black" : "white";
  void persistResult({
    whiteId: room.whiteId,
    blackId: room.blackId,
    result,
    endReason: "disconnect",
  });
}

wss.on("connection", async (player: WS, req: IncomingMessage) => {
  const proto = req.headers["sec-websocket-protocol"];
  const subprotocols = (proto ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const ticketProto = subprotocols.find((p) => p.startsWith("ticket."));
  const ticket = ticketProto?.slice("ticket.".length);

  if (!ticket) {
    player.close(4001, "unauthorized");
    return;
  }

  const userId = verifyTicket(ticket);
  if (!userId) {
    player.close(4001, "unauthorized");
    return;
  }

  player.userId = userId;
  player.isAlive = true;
  player.on("pong", () => {
    player.isAlive = true;
  });

  console.log(`client connected (userId=${userId})`);

  player.on("message", (data) => {
    let message: any;
    try {
      message = JSON.parse(data.toString());
    } catch {
      return;
    }
    switch (message.type) {
      case "find_match":
        pairing(player);
        break;
      case "move":
        handleMove(player, message.from, message.to, message.promotion);
        break;
      default:
        console.warn("unknown request", message.type);
    }
  });

  player.on("close", () => {
    console.log(`client disconnected (userId=${userId})`);
    handleDisconnect(player);
  });
});

const heartbeat = setInterval(() => {
  for (const player of wss.clients as Set<WS>) {
    if (player.isAlive === false) {
      console.log("terminating dead client");
      player.terminate();
      continue;
    }
    player.isAlive = false;
    player.ping();
  }
}, HEARTBEAT_INTERVAL_MS);

wss.on("close", () => clearInterval(heartbeat));

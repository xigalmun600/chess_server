import { WebSocketServer } from "ws";
import type { WebSocket as WS } from "ws";
import { Chess } from "chess.js";
import { randomInt, randomUUID, type UUID } from "crypto";
import type { IncomingMessage } from "http";
import { verifyTicket } from "./db.ts";
import { persistResult, type EndReason, type Result } from "./persist.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const CHAT_MIN_INTERVAL_MS = 200;
const CHAT_MAX_LENGTH = 200;

declare module "ws" {
  interface WebSocket {
    color?: "white" | "black";
    roomId?: UUID;
    userId?: number;
    username?: string;
    isAlive?: boolean;
    lastChatAt?: number;
  }
}

type Room = {
  white: WS;
  black: WS;
  whiteId: number;
  blackId: number;
  whiteName: string;
  blackName: string;
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
    whiteName: white.username!,
    blackName: black.username!,
    chess: new Chess(),
  });

  white.send(
    JSON.stringify({ type: "match", color: "white", opponent: black.username }),
  );
  black.send(
    JSON.stringify({ type: "match", color: "black", opponent: white.username }),
  );
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

function handleChat(player: WS, text: unknown): void {
  if (typeof text !== "string") return;
  const trimmed = text.trim();
  if (trimmed.length === 0 || trimmed.length > CHAT_MAX_LENGTH) {
    console.warn("chat rejected: length", trimmed.length);
    return;
  }
  const now = Date.now();
  if (player.lastChatAt && now - player.lastChatAt < CHAT_MIN_INTERVAL_MS) {
    console.warn("chat rejected: rate limit");
    return;
  }
  player.lastChatAt = now;

  if (!player.roomId) return;
  const room = Rooms.get(player.roomId);
  if (!room) return;

  const opponent = player.color === "white" ? room.black : room.white;
  if (opponent.readyState === opponent.OPEN) {
    opponent.send(
      JSON.stringify({ type: "chat", from: player.color, text: trimmed }),
    );
  }
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

  const verified = verifyTicket(ticket);
  if (!verified) {
    player.close(4001, "unauthorized");
    return;
  }

  player.userId = verified.userId;
  player.username = verified.username;
  player.isAlive = true;
  player.on("pong", () => {
    player.isAlive = true;
  });

  console.log(`client connected (userId=${verified.userId}, username=${verified.username})`);

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
      case "chat":
        handleChat(player, message.text);
        break;
      default:
        console.warn("unknown request", message.type);
    }
  });

  player.on("close", () => {
    console.log(`client disconnected (userId=${verified.userId})`);
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

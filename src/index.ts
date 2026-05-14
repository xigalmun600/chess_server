import { WebSocketServer } from "ws";
import type { WebSocket as WS } from "ws";
import { Chess } from "chess.js";
import { randomInt, randomUUID, type UUID } from "crypto";
import { createServer, type IncomingMessage } from "http";
import { verifyTicket } from "./db.ts";
import {
  persistResult,
  type EndReason,
  type Result,
} from "./persist.ts";

const HEARTBEAT_INTERVAL_MS = 30_000;
const CHAT_MIN_INTERVAL_MS = 200;
const CHAT_MAX_LENGTH = 200;
const INVITE_TTL_MS = 60_000;
const INVITE_SWEEP_MS = 10_000;

const INTERNAL_API_SECRET = process.env.INTERNAL_API_SECRET;
if (!INTERNAL_API_SECRET) throw new Error("INTERNAL_API_SECRET not set");

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
  drawOfferedBy: "white" | "black" | null;
};

const wss = new WebSocketServer({
  noServer: true,
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
const Connections = new Map<number, Set<WS>>();
type Invite = {
  inviteId: string;
  fromId: number;
  fromUsername: string;
  toId: number;
  expiresAt: number;
};
const Invites = new Map<string, Invite>();

function addConnection(player: WS): boolean {
  const id = player.userId!;
  let set = Connections.get(id);
  const wasOnline = !!set;
  if (!set) {
    set = new Set();
    Connections.set(id, set);
  }
  set.add(player);
  return !wasOnline; // true if this is the first connection for the user
}

function removeConnection(player: WS): boolean {
  const id = player.userId;
  if (id == null) return false;
  const set = Connections.get(id);
  if (!set) return false;
  set.delete(player);
  if (set.size === 0) {
    Connections.delete(id);
    return true; // last connection gone
  }
  return false;
}

function sendTo(userId: number, msg: object): void {
  const set = Connections.get(userId);
  if (!set) return;
  const payload = JSON.stringify(msg);
  for (const sock of set) {
    if (sock.readyState === sock.OPEN) sock.send(payload);
  }
}

function isInGame(userId: number): boolean {
  for (const room of Rooms.values()) {
    if (room.whiteId === userId || room.blackId === userId) return true;
  }
  return false;
}

function startMatch(p1: WS, p2: WS): void {
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
    drawOfferedBy: null,
  });

  white.send(
    JSON.stringify({ type: "match", color: "white", opponent: black.username }),
  );
  black.send(
    JSON.stringify({ type: "match", color: "black", opponent: white.username }),
  );
}

function pairing(player: WS): void {
  if (isInGame(player.userId!)) return;
  queue.push(player);
  player.send(JSON.stringify({ type: "finding" }));

  if (queue.length < 2) return;

  const [p1, p2] = [queue.shift()!, queue.shift()!];
  startMatch(p1, p2);
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

function endGame(
  roomId: UUID,
  room: Room,
  result: Result,
  reason: EndReason,
): void {
  for (const sock of [room.white, room.black]) {
    if (sock.readyState === sock.OPEN) {
      sock.send(JSON.stringify({ type: "game_over", result, reason }));
    }
  }
  Rooms.delete(roomId);
  void persistResult({
    whiteId: room.whiteId,
    blackId: room.blackId,
    result,
    endReason: reason,
  });
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

  if (room.drawOfferedBy === player.color) {
    room.drawOfferedBy = null;
    if (opposite.readyState === opposite.OPEN) {
      opposite.send(JSON.stringify({ type: "draw_withdrawn" }));
    }
  }

  const reason = endReasonFromChess(room.chess);
  if (!reason) return;

  let result: Result;
  if (reason === "checkmate") {
    result = player.color === "white" ? "white" : "black";
  } else {
    result = "draw";
  }

  endGame(player.roomId!, room, result, reason);
}

function handleResign(player: WS): void {
  if (!player.roomId) return;
  const room = Rooms.get(player.roomId);
  if (!room) return;
  const result: Result = player.color === "white" ? "black" : "white";
  endGame(player.roomId, room, result, "resign");
}

function handleDrawOffer(player: WS): void {
  if (!player.roomId) return;
  const room = Rooms.get(player.roomId);
  if (!room) return;
  if (room.drawOfferedBy) return;
  room.drawOfferedBy = player.color!;
  const opposite = player.color === "white" ? room.black : room.white;
  if (opposite.readyState === opposite.OPEN) {
    opposite.send(JSON.stringify({ type: "draw_offered" }));
  }
}

function handleDrawAccept(player: WS): void {
  if (!player.roomId) return;
  const room = Rooms.get(player.roomId);
  if (!room) return;
  if (!room.drawOfferedBy || room.drawOfferedBy === player.color) return;
  endGame(player.roomId, room, "draw", "agreement");
}

function handleDrawDecline(player: WS): void {
  if (!player.roomId) return;
  const room = Rooms.get(player.roomId);
  if (!room) return;
  if (!room.drawOfferedBy || room.drawOfferedBy === player.color) return;
  room.drawOfferedBy = null;
  const opposite = player.color === "white" ? room.black : room.white;
  if (opposite.readyState === opposite.OPEN) {
    opposite.send(JSON.stringify({ type: "draw_declined" }));
  }
}

async function handleInvite(player: WS, toUserId: unknown): Promise<void> {
  if (typeof toUserId !== "number" || !Number.isInteger(toUserId)) return;
  if (toUserId === player.userId) return;
  if (isInGame(player.userId!)) {
    player.send(
      JSON.stringify({ type: "invite_error", reason: "in_game" }),
    );
    return;
  }
  if (isInGame(toUserId)) {
    player.send(
      JSON.stringify({ type: "invite_error", reason: "target_in_game" }),
    );
    return;
  }
  if (!Connections.has(toUserId)) {
    player.send(
      JSON.stringify({ type: "invite_error", reason: "user_offline" }),
    );
    return;
  }
  // dedupe: if there's already a pending invite between these two, drop it
  for (const inv of Invites.values()) {
    if (inv.fromId === player.userId && inv.toId === toUserId) {
      player.send(
        JSON.stringify({ type: "invite_error", reason: "already_pending" }),
      );
      return;
    }
  }
  const inviteId = randomUUID();
  const invite: Invite = {
    inviteId,
    fromId: player.userId!,
    fromUsername: player.username!,
    toId: toUserId,
    expiresAt: Date.now() + INVITE_TTL_MS,
  };
  Invites.set(inviteId, invite);
  player.send(
    JSON.stringify({
      type: "invite_sent",
      inviteId,
      toId: toUserId,
    }),
  );
  sendTo(toUserId, {
    type: "invite_received",
    inviteId,
    fromId: player.userId,
    fromUsername: player.username,
  });
}

function handleInviteAccept(player: WS, inviteId: unknown): void {
  if (typeof inviteId !== "string") return;
  const invite = Invites.get(inviteId);
  if (!invite) return;
  if (invite.toId !== player.userId) return;
  if (Date.now() > invite.expiresAt) {
    Invites.delete(inviteId);
    return;
  }
  Invites.delete(inviteId);

  // find a socket of the sender
  const senderSet = Connections.get(invite.fromId);
  const sender = senderSet && [...senderSet].find((s) => s.readyState === s.OPEN);
  if (!sender) {
    player.send(
      JSON.stringify({ type: "invite_error", reason: "sender_gone" }),
    );
    return;
  }
  if (isInGame(invite.fromId) || isInGame(player.userId!)) {
    return;
  }
  // remove both from queue if present
  for (const sock of [player, sender]) {
    const idx = queue.indexOf(sock);
    if (idx !== -1) queue.splice(idx, 1);
  }
  startMatch(sender, player);
}

function handleInviteDecline(player: WS, inviteId: unknown): void {
  if (typeof inviteId !== "string") return;
  const invite = Invites.get(inviteId);
  if (!invite || invite.toId !== player.userId) return;
  Invites.delete(inviteId);
  sendTo(invite.fromId, { type: "invite_declined", inviteId });
}

function handleInviteCancel(player: WS, inviteId: unknown): void {
  if (typeof inviteId !== "string") return;
  const invite = Invites.get(inviteId);
  if (!invite || invite.fromId !== player.userId) return;
  Invites.delete(inviteId);
  sendTo(invite.toId, { type: "invite_cancelled", inviteId });
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

  addConnection(player);

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
      case "resign":
        handleResign(player);
        break;
      case "draw_offer":
        handleDrawOffer(player);
        break;
      case "draw_accept":
        handleDrawAccept(player);
        break;
      case "draw_decline":
        handleDrawDecline(player);
        break;
      case "invite":
        void handleInvite(player, message.toUserId);
        break;
      case "invite_accept":
        handleInviteAccept(player, message.inviteId);
        break;
      case "invite_decline":
        handleInviteDecline(player, message.inviteId);
        break;
      case "invite_cancel":
        handleInviteCancel(player, message.inviteId);
        break;
      default:
        console.warn("unknown request", message.type);
    }
  });

  player.on("close", () => {
    console.log(`client disconnected (userId=${verified.userId})`);
    const lastConnection = removeConnection(player);
    if (lastConnection) {
      // drop any outgoing invites this user had
      for (const [id, inv] of Invites) {
        if (inv.fromId === verified.userId) {
          Invites.delete(id);
          sendTo(inv.toId, { type: "invite_cancelled", inviteId: id });
        }
      }
    }
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

const inviteSweeper = setInterval(() => {
  const now = Date.now();
  for (const [id, inv] of Invites) {
    if (now > inv.expiresAt) {
      Invites.delete(id);
      sendTo(inv.fromId, { type: "invite_expired", inviteId: id });
      sendTo(inv.toId, { type: "invite_cancelled", inviteId: id });
    }
  }
}, INVITE_SWEEP_MS);

async function readJsonBody(req: IncomingMessage): Promise<unknown> {
  return new Promise((resolve, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 64 * 1024) {
        reject(new Error("payload too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolve(JSON.parse(raw));
      } catch (e) {
        reject(e);
      }
    });
    req.on("error", reject);
  });
}

const httpServer = createServer(async (req, res) => {
  if (req.method === "POST" && req.url === "/internal/notify") {
    if (req.headers["x-internal-secret"] !== INTERNAL_API_SECRET) {
      res.writeHead(401);
      res.end("unauthorized");
      return;
    }
    let body: any;
    try {
      body = await readJsonBody(req);
    } catch {
      res.writeHead(400);
      res.end("bad json");
      return;
    }
    if (
      !body ||
      typeof body.userId !== "number" ||
      !body.payload ||
      typeof body.payload !== "object"
    ) {
      res.writeHead(400);
      res.end("bad body");
      return;
    }
    sendTo(body.userId, body.payload);
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ ok: true }));
    return;
  }
  res.writeHead(404);
  res.end();
});

httpServer.on("upgrade", (req, socket, head) => {
  wss.handleUpgrade(req, socket, head, (ws) => {
    wss.emit("connection", ws, req);
  });
});

httpServer.listen(8080, () => {
  console.log("chess_server listening on :8080 (WS + /internal/notify)");
});

wss.on("close", () => {
  clearInterval(heartbeat);
  clearInterval(inviteSweeper);
});

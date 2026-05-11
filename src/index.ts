import { WebSocketServer } from "ws";
import type { WebSocket as WS } from "ws";
import { randomInt, randomUUID, type UUID } from "crypto";
const wss = new WebSocketServer({ port: 8080, maxPayload: 1024 * 10 });
const queue: WS[] = [];

declare module 'ws' {
  interface WebSocket {
    color?: "white" | "black";
    roomId?: UUID;
  }
}

const Rooms = new Map<UUID, {
  white: WS,
  black: WS,
}>();

let handleQueue = (player: WS) => {
  queue.push(player);
  player.send(JSON.stringify({ "type": "finding" }));

  if (queue.length >= 2) {
    const [p1, p2] = [queue.shift()!, queue.shift()!];
    const [white, black] = randomInt(2) ? [p1, p2] : [p2, p1];
    const roomId = randomUUID();

    white.color = "white";
    black.color = "black";
    white.roomId = roomId;
    black.roomId = roomId;

    Rooms.set(roomId, { white: white, black: black });
    white.send(JSON.stringify({ type: "match", color: "white" }))
    black.send(JSON.stringify({ type: "match", color: "black" }))
  }
}

let handleMove = (player: WS, from: string, to: string) => {
  let room = Rooms.get(player.roomId!);
  if (!room) return;
  let opposite = player.color == "white" ? room.black : room.white;
  opposite.send(JSON.stringify({ type: "move", from, to }));
}

wss.on("connection", (player: WS) => {
  console.log("client connected");

  player.on("message", (data) => {
    let message = JSON.parse(data.toString());
    switch (message.type) {
      case "find_match":
        handleQueue(player);
        break;
      case "move":
        handleMove(player, message.from, message.to);
        break;
      default:
        console.warn("unknown request");
    }
  });

  player.on("close", () => {
    console.log("client disconnected");
  });
});

import { WebSocketServer } from "ws";
import type { WebSocket as WS } from "ws";
import readline from "readline";

const wss = new WebSocketServer({ port: 8080 });
const rl = readline.createInterface({
  input: process.stdin,
  output: process.stdout,
});

let socket: WS | undefined;

rl.on("line", (input: string) => {
  if (!socket) {
    console.log("not connected");
  } else {
    socket.send(input);
  }
});

wss.on("connection", (ws: WS) => {
  console.log("client connected");
  socket = ws;

  ws.on("message", (data) => {
    console.log("received", data.toString());
  });

  ws.on("close", () => {
    socket = undefined;
    console.log("client disconnected");
  });
});

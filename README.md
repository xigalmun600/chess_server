# chess_server

Servidor WebSocket que empareja a dos jugadores de [neon_chess](https://github.com/xigalmun600/neon_chess) y retransmite movimientos entre ellos. Soporta chat, retos por nombre, rendicion, ofertas de tablas y, al terminar la partida, le pasa el resultado a SvelteKit por un endpoint interno.

Ejecutar con `node --experimental-strip-types src/index.ts`.

## Levantarlo en local
Necesita el secreto compartido con neon_chess para el endpoint `/internal/notify`. Mete esto en un `.env`:

```env
INTERNAL_API_SECRET=lo-que-sea-pero-igual-en-las-dos-apps
```
Y arrancarlo:

```bash
git clone https://github.com/xigalmun600/chess_server.git
cd chess_server
npm install
npm run dev
```
Con nix tienes `nix develop` para entrar a un shell con Node 22 ya configurado.

## Como conectar con neon_chess
El cliente de neon_chess pide un ticket HMAC al servidor SvelteKit, abre el WebSocket contra `ws://localhost:8080` (o `wss://<dominio>/ws` en produccion) y le pasa el ticket como subprotocolo. Si el ticket es valido, el servidor lo mete en la cola de emparejamiento.

Cuando una partida acaba, chess_server hace un POST a `http://localhost:5173/api/internal/game-result` con la cabecera `x-internal-secret` para que neon_chess persista el resultado y recalcule el ELO.

## En producción
En systemd usa `chess-server.service`, escuchando en `127.0.0.1:8080`. Caddy enruta `/ws` hasta el. Se despliega automaticamente con un GitHub Action al hacer push a `main` (entra por SSH, `git pull`, `npm install`, `systemctl restart`). Las unidades de systemd estan en `deploy/`.

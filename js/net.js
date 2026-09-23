/* =========================================================
   MikuQuiz · js/net.js
   Red P2P con PeerJS (broker público gratuito).
   El creador es el "host": los jugadores se conectan a él
   usando el código de sala como ID de peer.
   ========================================================= */

const PEER_PREFIX = "mikuquiz-v2-";

function makeCode() {
  const chars = "ABCDEFGHJKMNPQRSTUVWXYZ23456789";
  let code = "";
  for (let i = 0; i < 5; i++) code += chars[Math.floor(Math.random() * chars.length)];
  return code;
}

/* -------------------- HOST (creador) -------------------- */
class Host {
  constructor(code, handlers) {
    this.code = code;
    this.h = handlers;               // {onOpen, onJoin(conn,hello), onData(conn,msg), onLeave(conn)}
    this.conns = new Map();          // conn -> playerId
    this.peer = new Peer(PEER_PREFIX + code, { debug: 1 });

    this.peer.on("open", () => this.h.onOpen && this.h.onOpen());

    this.peer.on("connection", (conn) => {
      conn.on("data", (msg) => {
        if (msg && msg.t === "join") {
          // primer mensaje: el jugador se presenta
          this.conns.set(conn, msg);
          this.h.onJoin && this.h.onJoin(conn, msg);
        } else {
          this.h.onData && this.h.onData(conn, msg);
        }
      });
      conn.on("close", () => {
        const info = this.conns.get(conn);
        this.conns.delete(conn);
        this.h.onLeave && this.h.onLeave(conn, info);
      });
      conn.on("error", () => {});
    });

    this.peer.on("error", (err) => {
      if (this.h.onError) this.h.onError(err);
      else console.error("Host error:", err);
    });
  }
  send(conn, msg) { try { conn.send(msg); } catch (e) {} }
  broadcast(msg) { this.conns.forEach((_, c) => this.send(c, msg)); }
  kick(conn) { try { conn.close(); } catch (e) {} this.conns.delete(conn); }
  destroy() { try { this.peer.destroy(); } catch (e) {} }
}

/* -------------------- CLIENT (jugador) -------------------- */
class Client {
  constructor(code, handlers) {
    this.h = handlers;               // {onOpen, onData, onClose, onError}
    this.peer = new Peer({ debug: 1 });
    this.conn = null;

    this.peer.on("open", () => {
      this.conn = this.peer.connect(PEER_PREFIX + code, { reliable: true });
      this.conn.on("open", () => this.h.onOpen && this.h.onOpen());
      this.conn.on("data", (m) => this.h.onData && this.h.onData(m));
      this.conn.on("close", () => this.h.onClose && this.h.onClose());
      this.conn.on("error", () => {});
    });

    // llamada de video del creador (para ver la pantalla del jugador)
    this.peer.on("call", (call) => { if (this.h.onCall) this.h.onCall(call); });

    this.peer.on("error", (err) => {
      this.h.onError && this.h.onError(err);
    });
  }
  send(msg) { if (this.conn && this.conn.open) this.conn.send(msg); }
  destroy() { try { this.peer.destroy(); } catch (e) {} }
}

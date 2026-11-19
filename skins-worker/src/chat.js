// Staff chat room: one Durable Object (SQLite-backed, free plan) that all logged-in developer/staff panels connect to over a WebSocket.
// The Worker authenticates the panel session first and passes the name/role/expiry in x-chat-* headers, which only the Worker can set.
const MAX_LEN = 500;
const KEEP = 500;

export class ChatRoom {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    try { state.setWebSocketAutoResponse(new WebSocketRequestResponsePair('{"type":"ping"}', '{"type":"pong"}')); } catch (e) { /* not available in tests */ }
  }

  online() {
    const s = new Set();
    for (const ws of this.state.getWebSockets()) { const a = ws.deserializeAttachment(); if (a && a.name) s.add(a.name); }
    return [...s];
  }

  broadcast(obj, except) {
    const data = JSON.stringify(obj);
    for (const ws of this.state.getWebSockets()) { if (ws !== except) { try { ws.send(data); } catch (e) { /* closed */ } } }
  }

  async history() {
    const m = await this.state.storage.list({ prefix: "m:", reverse: true, limit: 100 });
    return [...m.values()].reverse();
  }

  async fetch(req) {
    if (req.headers.get("upgrade") !== "websocket") return new Response("expected websocket", { status: 426 });
    const name = req.headers.get("x-chat-name") || "";
    const role = req.headers.get("x-chat-role") || "";
    const exp = Number(req.headers.get("x-chat-exp") || 0);
    if (!name || !role) return new Response("forbidden", { status: 403 });
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    this.state.acceptWebSocket(server);
    server.serializeAttachment({ name, role, exp, last: 0 });
    server.send(JSON.stringify({ type: "history", messages: await this.history(), online: this.online() }));
    this.broadcast({ type: "presence", online: this.online() }, server);
    return new Response(null, { status: 101, webSocket: client });
  }

  // an account that was suspended/deleted, or whose panel session ended, is cut off on its next message
  async stillAllowed(me) {
    if (!me || !me.name) return false;
    if (me.exp && Date.now() > me.exp) return false;
    if (me.role === "staff") {
      try { const v = await this.env.SKINS.get("staff:" + me.name); const r = v ? JSON.parse(v) : null; if (!r || r.off) return false; } catch (e) { return false; }
    }
    return true;
  }

  async webSocketMessage(ws, data) {
    const me = ws.deserializeAttachment() || {};
    if (!(await this.stillAllowed(me))) { try { ws.close(4001, "session ended"); } catch (e) { /* closed */ } return; }
    let m;
    try { m = JSON.parse(String(data)); } catch (e) { return; }
    if (m.type === "del") {
      if (me.role !== "admin") return;
      const id = String(m.id || "").slice(0, 40);
      const all = await this.state.storage.list({ prefix: "m:", reverse: true, limit: 300 });
      for (const [k, v] of all) { if (v.id === id) { await this.state.storage.delete(k); this.broadcast({ type: "del", id }); break; } }
      return;
    }
    if (m.type !== "msg") return;
    const text = String(m.text || "").trim().slice(0, MAX_LEN);
    if (!text) return;
    const now = Date.now();
    if (me.last && now - me.last < 700) return; // flood guard
    me.last = now;
    ws.serializeAttachment(me);
    const msg = { id: crypto.randomUUID().slice(0, 8), t: now, by: me.name, role: me.role, text };
    await this.state.storage.put("m:" + String(now).padStart(13, "0") + ":" + msg.id, msg);
    this.broadcast({ type: "msg", msg });
    const n = ((await this.state.storage.get("n")) || 0) + 1;
    await this.state.storage.put("n", n);
    if (n % 100 === 0) { // keep the newest KEEP messages
      const keys = [...(await this.state.storage.list({ prefix: "m:", limit: 2000 })).keys()];
      const extra = keys.length - KEEP;
      for (let i = 0; i < extra; i += 100) await this.state.storage.delete(keys.slice(i, Math.min(i + 100, extra)));
    }
  }

  async webSocketClose(ws) {
    try { ws.close(); } catch (e) { /* already closed */ }
    this.broadcast({ type: "presence", online: this.online() }, ws);
  }

  async webSocketError() { /* the close handler cleans up */ }
}

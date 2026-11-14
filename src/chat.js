// League chat, bridged to the league's GroupMe group.
// GroupMe sends every group message to our callback (a GroupMe "bot" the commissioner creates); each league's
// messages live in one Durable Object, which also holds the open app connections and pushes new messages to them
// live. Posting from the app goes out through the same bot. Nothing here touches KV except the one-time setup,
// so chat never eats into the 1,000-writes-a-day KV budget.

const okLid = (p, l) => ["flea", "sleeper", "espn", "mfl"].includes(p) && /^[A-Za-z0-9_-]{1,40}$/.test(l);
const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const KEEP = 3000; // messages kept per league
const pad = n => String(n).padStart(15, "0");
const IMG_KEEP = 600; // photos kept per league (Durable Object storage; the free plan allows 5 GB)
const IMG_MAX = 1800000;
const imgType = b => { const a = new Uint8Array(b, 0, 12); if (a[0] === 0xff && a[1] === 0xd8) return "image/jpeg"; if (a[0] === 0x89 && a[1] === 0x50) return "image/png"; if (a[8] === 0x57 && a[9] === 0x45 && a[10] === 0x42 && a[11] === 0x50) return "image/webp"; if (a[0] === 0x47 && a[1] === 0x49) return "image/gif"; return ""; };
const PHOTO_RE = /https?:\/\/[^\s]+?\/p\/([a-z0-9]{6,12})\/([a-z0-9]{14,24})/;

export class ChatRoom {
  constructor(state, env) { this.state = state; this.env = env; this.lastPost = new Map(); }
  async fetch(request) {
    const u = new URL(request.url), st = this.state.storage;
    if (u.pathname === "/ws") {
      if (request.headers.get("Upgrade") !== "websocket") return new Response("Expected websocket", { status: 426 });
      const pair = new WebSocketPair(), [client, server] = Object.values(pair);
      this.state.acceptWebSocket(server);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname === "/add") {
      const m = await request.json();
      const key = "m:" + pad(m.at) + ":" + m.id;
      if (await st.get(key)) return out({ ok: true, dup: true });
      await st.put(key, m);
      let n = ((await st.get("count")) || 0) + 1;
      if (n > KEEP + 100) { const old = await st.list({ prefix: "m:", limit: Math.min(128, n - KEEP) }); if (old.size) { await st.delete([...old.keys()]); n -= old.size; } }
      await st.put("count", n);
      const msg = JSON.stringify({ type: "msg", m });
      for (const ws of this.state.getWebSockets()) { try { ws.send(msg); } catch (e) {} }
      return out({ ok: true });
    }
    if (u.pathname === "/img/put") {
      // Photos posted from the app. Keys sort by time (id starts with the time in base 36), so the oldest go first.
      const id = u.searchParams.get("id"), type = u.searchParams.get("t") || "image/jpeg";
      const b = await request.arrayBuffer();
      await st.put("i:" + id, { t: type, b });
      let n = ((await st.get("imgs")) || 0) + 1;
      if (n > IMG_KEEP + 20) { const old = await st.list({ prefix: "i:", limit: n - IMG_KEEP }); if (old.size) { await st.delete([...old.keys()]); n -= old.size; } }
      await st.put("imgs", n);
      return out({ ok: true });
    }
    if (u.pathname === "/img/get") {
      const v = await st.get("i:" + u.searchParams.get("id"));
      if (!v) return new Response("Not found", { status: 404 });
      return new Response(v.b, { headers: { "content-type": v.t, "cache-control": "public, max-age=31536000, immutable" } });
    }
    if (u.pathname === "/state") {
      // Small bits of server state that change often (live-score bookkeeping), kept here instead of KV's daily write limit.
      const k = "s:" + (u.searchParams.get("k") || "");
      if (request.method === "POST") { await st.put(k, await request.json()); return out({ ok: true }); }
      return out((await st.get(k)) || null);
    }
    if (u.pathname === "/bump") {
      const k = "c:" + (u.searchParams.get("k") || "").slice(0, 80); await st.put(k, ((await st.get(k)) || 0) + 1); return out({ ok: true });
    }
    if (u.pathname === "/counts") {
      const got = await st.list({ prefix: "c:" + (u.searchParams.get("day") || ""), limit: 200 }); return out(Object.fromEntries([...got.entries()].map(([k, v]) => [k.slice(2), v])));
    }
    if (u.pathname === "/addMany") {
      // Many items in one request (the breaking-news feed): returns only the ones that weren't stored yet.
      const items = await request.json(), fresh = [];
      const keys = items.map(m => "m:" + pad(m.at) + ":" + m.id), have = await st.get(keys);
      const put = {};
      items.forEach((m, i) => { if (!have.get(keys[i])) { put[keys[i]] = m; fresh.push(m); } });
      if (fresh.length) {
        for (let i = 0, ks = Object.keys(put); i < ks.length; i += 100) await st.put(Object.fromEntries(ks.slice(i, i + 100).map(k => [k, put[k]])));
        let n = ((await st.get("count")) || 0) + fresh.length;
        if (n > KEEP + 100) { const old = await st.list({ prefix: "m:", limit: Math.min(128, n - KEEP) }); if (old.size) { await st.delete([...old.keys()]); n -= old.size; } }
        await st.put("count", n);
      }
      return out({ fresh, had: ((await st.get("count")) || 0) - fresh.length });
    }
    if (u.pathname === "/list") {
      const before = u.searchParams.get("before");
      const opts = { prefix: "m:", reverse: true, limit: 60 };
      if (before) opts.end = before;
      const got = await st.list(opts);
      const list = [...got.entries()].map(([k, v]) => Object.assign({ k }, v)).reverse();
      return out({ list, more: got.size === 60 });
    }
    if (u.pathname === "/gate") {
      // Simple flood guard for posting from the app: one message every 2 seconds per device.
      const dev = u.searchParams.get("dev") || "", now = Date.now(), last = this.lastPost.get(dev) || 0;
      if (now - last < 2000) return out({ ok: false }, 429);
      this.lastPost.set(dev, now);
      return out({ ok: true });
    }
    return new Response("Not found", { status: 404 });
  }
  webSocketMessage(ws, msg) { if (msg === "ping") { try { ws.send("pong"); } catch (e) {} } }
  webSocketClose(ws, code) { try { ws.close(code === 1005 ? 1000 : code, "bye"); } catch (e) {} }
  webSocketError() {}
}

const room = (env, p, lid) => env.CHAT.get(env.CHAT.idFromName(p + ":" + lid));
const cfgKey = (p, lid) => "gm:" + p + ":" + lid;
const getCfg = (env, p, lid) => env.SNAP.get(cfgKey(p, lid), "json");

// Post text into the league's GroupMe through its bot. Returns false when the league isn't connected.
export async function groupmeSay(env, p, lid, text) {
  if (!env.SNAP) return false;
  const c = await getCfg(env, p, lid).catch(() => null);
  if (!c || !c.bot) return false;
  const chunks = []; let t = String(text || "").trim();
  while (t && chunks.length < 3) { if (t.length <= 990) { chunks.push(t); break; } let cut = t.lastIndexOf("\n", 990); if (cut < 500) cut = t.lastIndexOf(" ", 990); if (cut < 1) cut = 990; chunks.push(t.slice(0, cut)); t = t.slice(cut).trim(); }
  for (const c2 of chunks) {
    const r = await fetch("https://api.groupme.com/v3/bots/post", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ bot_id: c.bot, text: c2 }) });
    if (!r.ok) throw new Error("GroupMe answered " + r.status + (r.status === 404 ? " (bot not found — check the bot ID)" : ""));
  }
  return true;
}

const isComm = async (env, p, lid, dev) => { const c = await env.SNAP.get("comm:" + p + ":" + lid, "json"); return !!(c && c.owner && c.owner.dev === dev); };
const okDev = d => /^[a-f0-9]{16,64}$/.test(String(d || ""));

export async function chatRoute(request, url, env) {
  const path = url.pathname;
  if (!env.CHAT || !env.SNAP) return out({ error: "Chat isn’t available on this server yet." }, 503);

  // Photos from the app: /p/<code>/<id> is a small page GroupMe turns into a picture preview; <id>.img is the file.
  if (path.startsWith("/p/")) {
    const [, , code, file] = path.split("/"), id = String(file || "").replace(/\.img$/, "");
    if (!/^[a-z0-9]{6,12}$/.test(code || "") || !/^[a-z0-9]{14,24}$/.test(id)) return new Response("Not found", { status: 404 });
    const m = await env.SNAP.get("gmc:" + code, "json");
    if (!m) return new Response("Not found", { status: 404 });
    const imgUrl = url.origin + "/p/" + code + "/" + id + ".img";
    if (file.endsWith(".img")) {
      const cache = typeof caches !== "undefined" ? caches.default : null, hit = cache && await cache.match(imgUrl); if (hit) return hit;
      const r = await room(env, m.p, m.lid).fetch("https://chat/img/get?id=" + id);
      if (r.ok && cache) await cache.put(imgUrl, r.clone()).catch(() => {});
      return r;
    }
    return new Response('<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Photo · Snap Count</title><meta property="og:title" content="Photo from Snap Count"><meta property="og:image" content="' + imgUrl + '"><meta name="twitter:card" content="summary_large_image"><style>body{margin:0;background:#111;display:grid;place-items:center;min-height:100vh}img{max-width:100%;max-height:100vh}</style></head><body><img src="' + imgUrl + '" alt="Photo"></body></html>', { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "public, max-age=86400" } });
  }

  // GroupMe's callback: short form /g/<code> (GroupMe's form limits how long the address can be), or the
  // original /api/groupme/<p>/<lid>/<token>.
  if (path.startsWith("/api/groupme/") || path.startsWith("/g/")) {
    let p, lid, token;
    if (path.startsWith("/g/")) { const code = path.slice(3); const m = /^[a-z0-9]{6,12}$/.test(code) ? await env.SNAP.get("gmc:" + code, "json") : null; if (!m) return out({ ok: false }, 404); p = m.p; lid = m.lid; token = m.token; }
    else [, , , p, lid, token] = path.split("/");
    if (request.method !== "POST" || !okLid(p, lid)) return out({ ok: false }, 400);
    const c = await getCfg(env, p, lid);
    if (!c || !token || c.token !== token) return out({ ok: false }, 403);
    const g = await request.json().catch(() => null);
    if (!g || !g.id) return out({ ok: false }, 400);
    const img = (g.attachments || []).find(a => a.type === "image" && /^https:\/\/i\.groupme\.com\//.test(a.url || ""));
    const m = { id: String(g.id).slice(0, 40), at: (Number(g.created_at) || Math.floor(Date.now() / 1000)) * 1000, name: String(g.name || "").slice(0, 60), av: /^https:\/\/i\.groupme\.com\//.test(g.avatar_url || "") ? g.avatar_url : "", text: String(g.text || "").slice(0, 2000), bot: g.sender_type === "bot", sys: g.sender_type === "system" || !!g.system, img: img ? img.url : "" };
    const ph = m.text.match(PHOTO_RE);
    if (ph && !m.img) { m.img = "/p/" + ph[1] + "/" + ph[2] + ".img"; m.text = m.text.replace(ph[0], "").replace(/📷\s*$/, "").replace(/\n+$/, ""); }
    if (!m.text && !m.img) return out({ ok: true });
    await room(env, p, lid).fetch("https://chat/add", { method: "POST", body: JSON.stringify(m) });
    return out({ ok: true });
  }

  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
  if (!okLid(p, lid)) return out({ error: "Bad league" }, 400);

  if (path === "/api/chat/ws") {
    const c = await getCfg(env, p, lid);
    if (!c || !c.bot) return out({ error: "not connected" }, 409);
    return room(env, p, lid).fetch("https://chat/ws", request);
  }

  if (path === "/api/chat" && request.method === "GET") {
    const c = await getCfg(env, p, lid);
    const dev = url.searchParams.get("dev"), comm = await isComm(env, p, lid, dev);
    const canSet = !c || !c.bot || !c.dev || c.dev === dev || comm;
    if (!c || !c.bot) return out({ connected: false, isComm: canSet, callback: canSet && c && c.code ? url.origin + "/g/" + c.code : null });
    const r = await room(env, p, lid).fetch("https://chat/list" + (url.searchParams.get("before") ? "?before=" + encodeURIComponent(url.searchParams.get("before")) : ""));
    return out(Object.assign({ connected: true, isComm: comm, group: c.group || "" }, await r.json()));
  }

  if (path === "/api/chat/photo" && request.method === "POST") {
    const dev = url.searchParams.get("dev") || "";
    if (!okDev(dev)) return out({ error: "Bad request" }, 400);
    const c = await getCfg(env, p, lid);
    if (!c || !c.bot || !c.code) return out({ error: "This league isn’t connected to GroupMe yet." }, 409);
    const body = await request.arrayBuffer();
    if (body.byteLength > IMG_MAX) return out({ error: "That photo is too big. Try a smaller one." }, 413);
    const type = body.byteLength > 12 ? imgType(body) : "";
    if (!type) return out({ error: "That file isn’t a photo." }, 415);
    const gate = await room(env, p, lid).fetch("https://chat/gate?dev=" + dev);
    if (gate.status === 429) return out({ error: "Slow down a second." }, 429);
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    const id = Date.now().toString(36).padStart(9, "0") + [...a].map(x => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
    await room(env, p, lid).fetch("https://chat/img/put?id=" + id + "&t=" + encodeURIComponent(type), { method: "POST", body });
    const name = String(url.searchParams.get("name") || "Someone").slice(0, 40), cap = String(url.searchParams.get("text") || "").replace(/\*\*/g, "").trim().slice(0, 700);
    try { await groupmeSay(env, p, lid, name + ": " + (cap ? cap + "\n" : "📷 ") + url.origin + "/p/" + c.code + "/" + id); }
    catch (e) { return out({ error: e.message }, 502); }
    return out({ ok: true });
  }

  if (request.method !== "POST") return out({ error: "POST only" }, 405);
  const b = await request.json().catch(() => ({}));
  if (!okDev(b.dev)) return out({ error: "Bad request" }, 400);

  if (path === "/api/chat/post" || path === "/api/chat/share") {
    let text = String(b.text || "").replace(/\*\*/g, "").trim();
    if (!text) return out({ error: "Nothing to send." }, 400);
    const gate = await room(env, p, lid).fetch("https://chat/gate?dev=" + b.dev);
    if (gate.status === 429) return out({ error: "Slow down a second." }, 429);
    if (path === "/api/chat/post") text = String(b.name || "Someone").slice(0, 40) + ": " + text.slice(0, 900);
    else text = text.slice(0, 2900);
    try { if (!(await groupmeSay(env, p, lid, text))) return out({ error: "This league isn’t connected to GroupMe yet." }, 409); }
    catch (e) { return out({ error: e.message }, 502); }
    return out({ ok: true });
  }

  if (path === "/api/chat/setup") {
    const key = cfgKey(p, lid), c = (await env.SNAP.get(key, "json")) || {};
    // Whoever starts the setup can finish it (or the league's Snap Count commissioner). Once a bot is connected,
    // only that person or the commissioner can change it.
    if (c.bot && c.dev && c.dev !== b.dev && !(await isComm(env, p, lid, b.dev))) return out({ error: "Someone else in your league already set up GroupMe. They (or your commissioner) can change it." }, 403);
    if (!c.dev) c.dev = b.dev;
    if (b.action === "start") {
      if (!c.token || !c.code || !c.saved) { c.saved = 1;
        const a = new Uint8Array(12); crypto.getRandomValues(a); c.token = c.token || [...a].map(x => x.toString(16).padStart(2, "0")).join("");
        const b2 = new Uint8Array(7); crypto.getRandomValues(b2); c.code = [...b2].map(x => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
        await env.SNAP.put("gmc:" + c.code, JSON.stringify({ p, lid, token: c.token }));
        await env.SNAP.put(key, JSON.stringify(c));
      }
      return out({ callback: url.origin + "/g/" + c.code, bot: c.bot || "" });
    }
    if (b.action === "bot") {
      const bot = String(b.bot || "").trim();
      if (!/^[A-Za-z0-9]{10,40}$/.test(bot)) return out({ error: "That doesn’t look like a GroupMe bot ID. It’s the long code on dev.groupme.com/bots." }, 400);
      if (!c.token) return out({ error: "Start setup first." }, 409);
      c.bot = bot; c.group = String(b.group || "").slice(0, 80);
      await env.SNAP.put(key, JSON.stringify(c));
      try { await groupmeSay(env, p, lid, "🏈 Snap Count is connected. This chat now shows up in the app, and trade grades, recaps and trade market posts will land here."); }
      catch (e) { return out({ error: "Saved, but GroupMe didn’t take a test message: " + e.message }, 502); }
      return out({ ok: true });
    }
    if (b.action === "off") { if (c.code) await env.SNAP.delete("gmc:" + c.code); await env.SNAP.delete(key); return out({ ok: true }); }
    return out({ error: "Unknown action" }, 400);
  }
  return out({ error: "Not found" }, 404);
}

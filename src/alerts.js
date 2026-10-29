// Snap Count push alerts.
// Every minute a cron run checks QBs plus one other position (RB, WR, TE in turn) from Sleeper,
// so QBs are checked every minute and other positions every 3 minutes. It compares them with the last snapshot,
// and sends phone notifications to each subscriber whose players or leagues are affected.

import { ICON_192, ICON_512 } from "./icons.js";

const UA = { "User-Agent": "SnapCount/1.0 (fantasy dashboard)", "Accept": "application/json" };
const te = new TextEncoder();
const OTHERS = ["RB", "WR", "TE"];
const THRESH = { QB: { start: 14, jump: 5 }, RB: { start: 10, jump: 4 }, WR: { start: 10, jump: 4 }, TE: { start: 8, jump: 4 } };
const OUTISH = new Set(["out", "ir", "doubtful", "sus", "suspended", "pup", "na", "cov"]);

export const norm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]/g, "");
const b64u = buf => {
  const a = new Uint8Array(buf); let s = "";
  for (let i = 0; i < a.length; i++) s += String.fromCharCode(a[i]);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
};
const out = (data, status = 200) => new Response(JSON.stringify(data), {
  status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" }
});
async function hashId(s) {
  const h = await crypto.subtle.digest("SHA-256", te.encode(s));
  return [...new Uint8Array(h)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, 32);
}

/* ---------- Web Push (VAPID, no payload; the phone fetches the alert text) ---------- */
let vapidCache = null;
async function vapid(env) {
  if (vapidCache) return vapidCache;
  let v = await env.SNAP.get("vapid", "json");
  if (!v) {
    const kp = await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"]);
    v = { jwk: await crypto.subtle.exportKey("jwk", kp.privateKey), pub: b64u(await crypto.subtle.exportKey("raw", kp.publicKey)) };
    await env.SNAP.put("vapid", JSON.stringify(v));
  }
  return (vapidCache = v);
}
export async function sendPush(env, sub, contact) {
  const v = await vapid(env);
  const key = await crypto.subtle.importKey("jwk", v.jwk, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
  const head = b64u(te.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = b64u(te.encode(JSON.stringify({ aud: new URL(sub.endpoint).origin, exp: Math.floor(Date.now() / 1000) + 12 * 3600, sub: contact || "https://workers.dev" })));
  const sig = b64u(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, te.encode(head + "." + claims)));
  const r = await fetch(sub.endpoint, {
    method: "POST",
    headers: { TTL: "86400", Urgency: "high", Authorization: "vapid t=" + head + "." + claims + "." + sig + ", k=" + v.pub, "Content-Length": "0" }
  });
  return r.status;
}

async function addAlerts(env, id, items) {
  const key = "al:" + id;
  const list = (await env.SNAP.get(key, "json")) || [];
  const seen = new Set(list.map(a => a.id));
  const fresh = items.filter(a => !seen.has(a.id));
  if (!fresh.length) return 0;
  const next = fresh.map(a => Object.assign({ t: Date.now(), read: false }, a)).concat(list).slice(0, 40);
  await env.SNAP.put(key, JSON.stringify(next));
  return fresh.length;
}
async function deliver(env, id, rec, items) {
  const n = await addAlerts(env, id, items);
  if (!n) return 0;
  const st = await sendPush(env, rec.sub, rec.origin);
  if (st === 404 || st === 410) { await env.SNAP.delete("sub:" + id); await env.SNAP.delete("al:" + id); }
  return n;
}

/* ---------- HTTP routes ---------- */
export async function alertsRoute(request, env, p, url) {
  if (!env.SNAP) return out({ error: "Alerts storage isn't set up yet." }, 503);
  try {
    if (p === "/api/push/key") return out({ key: (await vapid(env)).pub });
    if (request.method === "POST") {
      const body = await request.json().catch(() => ({}));
      const endpoint = (body.sub && body.sub.endpoint) || body.endpoint;
      if (!endpoint || !/^https:\/\//.test(endpoint)) return out({ error: "Missing subscription" }, 400);
      const id = await hashId(endpoint);
      if (p === "/api/push/subscribe") {
        const rec = {
          sub: { endpoint, keys: (body.sub && body.sub.keys) || {} },
          ids: (body.ids || []).slice(0, 400).map(String),
          names: (body.names || []).slice(0, 400).map(String),
          leagues: (body.leagues || []).slice(0, 30).map(l => ({ p: l.p === "flea" ? "flea" : "sleeper", id: String(l.id), name: String(l.name || "").slice(0, 80) })),
          prefs: { mine: body.prefs?.mine !== false, fa: body.prefs?.fa !== false, faPos: body.prefs?.faPos === "QB" ? "QB" : "ALL" },
          origin: url.origin
        };
        const prev = await env.SNAP.get("sub:" + id);
        const s = JSON.stringify(rec);
        if (prev !== s) await env.SNAP.put("sub:" + id, s);
        return out({ ok: true, watching: rec.ids.length + rec.names.length, leagues: rec.leagues.length });
      }
      if (p === "/api/push/unsubscribe") { await env.SNAP.delete("sub:" + id); await env.SNAP.delete("al:" + id); return out({ ok: true }); }
      if (p === "/api/push/test") {
        const rec = await env.SNAP.get("sub:" + id, "json");
        if (!rec) return out({ error: "This phone isn't signed up for alerts yet." }, 404);
        await deliver(env, id, rec, [{ id: "test:" + Date.now(), title: "Snap Count alerts are on", body: "You'll hear about injuries to your players and free agents who suddenly become starters." }]);
        return out({ ok: true });
      }
    }
    if (p === "/api/push/alerts") {
      const e = url.searchParams.get("e") || "";
      if (!e) return out({ alerts: [] });
      const id = await hashId(e), key = "al:" + id;
      const list = (await env.SNAP.get(key, "json")) || [];
      const unread = list.filter(a => !a.read);
      const res = list.map(a => Object.assign({}, a, { fresh: !a.read }));
      if (url.searchParams.get("mark") === "1" && unread.length) await env.SNAP.put(key, JSON.stringify(list.map(a => Object.assign(a, { read: true }))));
      return out({ alerts: res });
    }
    if (p === "/api/push/run") {
      const pos = ["QB", "RB", "WR", "TE"].includes(url.searchParams.get("pos")) ? url.searchParams.get("pos") : "QB";
      return out(await runChecks(env, pos));
    }
    if (p === "/api/push/status") {
      const snaps = {};
      for (const pos of ["QB", "RB", "WR", "TE"]) {
        const s = await env.SNAP.get("snap:" + pos, "json");
        snaps[pos] = s ? { week: s.week, players: Object.keys(s.p || {}).length, checked: s.at, lastEvents: s.events || [] } : null;
      }
      return out({ snaps, lastError: await env.SNAP.get("err", "json") });
    }
    return out({ error: "Not found" }, 404);
  } catch (e) {
    return out({ error: "Alerts hit a problem: " + (e && e.message || e) }, 500);
  }
}

/* ---------- the check ---------- */
function labelFor(st) {
  const s = norm(st);
  if (!s) return "is off the injury report";
  if (s === "out") return "has been ruled OUT";
  if (s === "ir") return "was placed on IR";
  if (s === "questionable") return "is now Questionable";
  if (s === "doubtful") return "is now Doubtful";
  if (s === "sus" || s === "suspended") return "has been suspended";
  if (s === "pup") return "was placed on PUP";
  return "is now listed " + st;
}
const fmtPts = n => (Math.round(n * 10) / 10).toFixed(1);

export async function readSlate(pos, season, week, seasonType) {
  const url = "https://api.sleeper.com/projections/nfl/" + season + "/" + week + "?season_type=" + seasonType + "&position[]=" + pos + "&order_by=pts_ppr";
  const r = await fetch(url, { headers: UA });
  if (!r.ok) throw new Error("Sleeper projections answered " + r.status);
  const text = await r.text();
  let arr; try { arr = JSON.parse(text); } catch (e) { throw new Error("Sleeper projections weren't JSON: " + text.slice(0, 120)); }
  const now = {};
  for (const x of Array.isArray(arr) ? arr : []) {
    const pl = x.player || {}, id = x.player_id || pl.player_id;
    if (!id) continue;
    const s = x.stats || {};
    const proj = Number(s.pts_ppr ?? s.pts_half_ppr ?? s.pts_std ?? 0) || 0;
    const team = x.team || pl.team || "";
    if (!team && !proj) continue;
    now[id] = [((pl.first_name || "") + " " + (pl.last_name || "")).trim(), team, pl.injury_status || "", pl.injury_body_part || "", Math.round(proj * 10) / 10];
  }
  if (!Object.keys(now).length) throw new Error("Sleeper projections came back empty (" + (Array.isArray(arr) ? arr.length + " rows" : typeof arr) + "): " + text.slice(0, 160));
  return now;
}

export function diffSlate(pos, prev, now) {
  const th = THRESH[pos];
  const ev = [];
  for (const id in now) {
    const n = now[id], o = prev[id];
    if (!o) continue;
    const base = { id, pos, name: n[0], team: n[1] };
    if (norm(n[2]) !== norm(o[2])) ev.push(Object.assign({ kind: "status", from: o[2], to: n[2], part: n[3], proj: n[4], prevProj: o[4] }, base));
    if (n[1] && o[1] && n[1] !== o[1]) ev.push(Object.assign({ kind: "team", from: o[1], to: n[1] }, base));
    if (n[4] >= th.start && n[4] - o[4] >= th.jump) ev.push(Object.assign({ kind: "jump", from: o[4], to: n[4] }, base));
  }
  // A starter is newly out: the best healthy teammate at his position is the next man up.
  for (const e of ev.slice()) {
    if (e.kind !== "status" || !OUTISH.has(norm(e.to)) || OUTISH.has(norm(e.from)) || e.prevProj < th.start) continue;
    const mates = Object.entries(now).filter(([id, v]) => id !== e.id && v[1] === e.team && !OUTISH.has(norm(v[2]))).sort((a, b) => b[1][4] - a[1][4]);
    if (mates.length) {
      const [mid, m] = mates[0];
      ev.push({ kind: "nextup", id: mid, pos, name: m[0], team: m[1], starter: e.name, starterStatus: e.to, proj: m[4] });
    }
  }
  return ev;
}

async function leagueRostered(L, cache) {
  const key = L.p + ":" + L.id;
  if (cache.has(key)) return cache.get(key);
  let set = null;
  try {
    if (L.p === "sleeper") {
      const r = await fetch("https://api.sleeper.app/v1/league/" + L.id + "/rosters", { headers: UA });
      if (r.ok) { set = new Set(); for (const ro of await r.json()) for (const pid of (ro.players || [])) set.add("id:" + pid); }
    } else {
      const r = await fetch("https://www.fleaflicker.com/api/FetchLeagueRosters?sport=NFL&league_id=" + L.id, { headers: UA });
      if (r.ok) { set = new Set(); for (const ro of ((await r.json()).rosters || [])) for (const lp of (ro.players || [])) { const pp = lp.proPlayer || {}; set.add("nm:" + norm(pp.nameFull) + "|" + pp.position); } }
    }
  } catch (e) {}
  cache.set(key, set);
  return set;
}

export function messagesFor(rec, events, week) {
  const ids = new Set(rec.ids), names = new Set(rec.names);
  const mine = e => ids.has(e.id) || names.has(norm(e.name) + "|" + e.pos);
  const minePush = [], faCandidates = [];
  for (const e of events) {
    const tag = e.kind + ":" + e.id + ":" + week + ":" + norm(String(e.to ?? e.starter ?? ""));
    if (mine(e)) {
      if (!rec.prefs.mine) continue;
      if (e.kind === "status") minePush.push({ id: tag, title: e.name + " " + labelFor(e.to), body: e.pos + " · " + e.team + (e.part ? " · " + e.part : "") + ". He's on your roster." });
      else if (e.kind === "team") minePush.push({ id: tag, title: e.name + " traded to " + e.to, body: e.pos + ", formerly " + e.from + ". He's on your roster." });
      else if (e.kind === "nextup") minePush.push({ id: tag, title: e.name + " is in line to start", body: e.starter + " " + labelFor(e.starterStatus).replace(/^is |^has been |^was /, "") + ". Projected " + fmtPts(e.proj) + " pts this week." });
    } else if (rec.prefs.fa && (e.kind === "jump" || e.kind === "nextup") && (rec.prefs.faPos === "ALL" || rec.prefs.faPos === e.pos)) {
      faCandidates.push(Object.assign({ tag }, e));
    }
  }
  const nextIds = new Set(faCandidates.filter(e => e.kind === "nextup").map(e => e.id));
  const fa = faCandidates.filter(e => e.kind === "nextup" || !nextIds.has(e.id));
  fa.sort((a, b) => (b.kind === "nextup") - (a.kind === "nextup") || (b.to ?? b.proj) - (a.to ?? a.proj));
  return { minePush, faCandidates: fa.slice(0, 3) };
}

export async function runChecks(env, forcePos) {
  if (!env.SNAP) return { skipped: "no storage" };
  const st = await (await fetch("https://api.sleeper.app/v1/state/nfl", { headers: UA })).json();
  const seasonType = st.season_type === "post" ? "post" : "regular";
  if (st.season_type === "off" || st.season_type === "pre") return { skipped: "offseason", seasonType: st.season_type };
  const season = st.league_season || st.season, week = st.display_week || st.week;
  const pos = forcePos || "QB";
  let now;
  try { now = await readSlate(pos, season, week, seasonType); }
  catch (e) {
    const msg = String(e.message || e), prevErr = await env.SNAP.get("err", "json");
    if (!prevErr || prevErr.msg !== msg) await env.SNAP.put("err", JSON.stringify({ msg, at: Date.now(), pos }));
    return { error: msg, pos, week, season };
  }
  const prev = await env.SNAP.get("snap:" + pos, "json");
  const fresh = !prev || prev.week !== week || String(prev.season) !== String(season);
  const events = fresh ? [] : diffSlate(pos, prev.p || {}, now);
  const changed = fresh || Object.keys(now).some(id => !prev.p[id] || prev.p[id].join("|") !== now[id].join("|"));
  let sent = 0;
  if (events.length) {
    const list = await env.SNAP.list({ prefix: "sub:" });
    const cache = new Map();
    for (const k of list.keys) {
      const rec = await env.SNAP.get(k.name, "json");
      if (!rec) continue;
      const { minePush, faCandidates } = messagesFor(rec, events, week);
      const items = minePush.slice();
      for (const e of faCandidates) {
        const free = [];
        for (const L of rec.leagues) {
          const set = await leagueRostered(L, cache);
          if (!set) continue;
          const taken = L.p === "sleeper" ? set.has("id:" + e.id) : set.has("nm:" + norm(e.name) + "|" + e.pos);
          if (!taken) free.push(L.name);
        }
        if (!free.length) continue;
        const where = "Free in " + free.slice(0, 3).join(", ") + (free.length > 3 ? " and " + (free.length - 3) + " more" : "") + ".";
        if (e.kind === "nextup") items.push({ id: e.tag, title: "Next man up: " + e.name + " (" + e.pos + ", " + e.team + ")", body: e.starter + " " + labelFor(e.starterStatus).replace(/^is |^has been |^was /, "") + ". " + where });
        else items.push({ id: e.tag, title: "Free agent " + e.pos + " " + e.name + " projected " + fmtPts(e.to) + " pts", body: "Up from " + fmtPts(e.from) + " (" + e.team + "). " + where });
      }
      if (items.length) sent += await deliver(env, k.name.slice(4), rec, items);
    }
  }
  if (changed) {
    const lastEvents = events.length ? events.slice(0, 8).map(e => e.kind + " " + e.name + " " + (e.to ?? e.starter ?? "")) : (prev && prev.events) || [];
    await env.SNAP.put("snap:" + pos, JSON.stringify({ week, season, at: Date.now(), p: now, events: lastEvents }));
  }
  return { pos, week, players: Object.keys(now).length, events: events.length, sent, baseline: fresh };
}

export async function runMinute(env) {
  await runChecks(env, "QB").catch(() => {});
  await runChecks(env, OTHERS[new Date().getUTCMinutes() % OTHERS.length]).catch(() => {});
}

/* ---------- files the phone needs ---------- */
export const SW_JS = `
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", e => e.waitUntil(self.clients.claim()));
self.addEventListener("push", e => e.waitUntil((async () => {
  let items = [];
  try {
    const sub = await self.registration.pushManager.getSubscription();
    const r = await fetch("/api/push/alerts?mark=1&e=" + encodeURIComponent(sub ? sub.endpoint : ""));
    items = ((await r.json()).alerts || []).filter(a => a.fresh);
  } catch (err) {}
  if (!items.length) items = [{ id: "update", title: "Snap Count", body: "There's news about your players." }];
  for (const a of items.slice(0, 4)) {
    await self.registration.showNotification(a.title, { body: a.body, tag: a.id, icon: "/icon-192.png", data: { url: "/#alerts" } });
  }
})()));
self.addEventListener("notificationclick", e => {
  e.notification.close();
  e.waitUntil(self.clients.matchAll({ type: "window", includeUncontrolled: true }).then(ws => {
    for (const w of ws) { if ("focus" in w) { w.postMessage({ open: "alerts" }); return w.focus(); } }
    return self.clients.openWindow("/#alerts");
  }));
});
`;

export const MANIFEST = JSON.stringify({
  name: "Snap Count", short_name: "Snap Count", start_url: "/", display: "standalone",
  background_color: "#10181f", theme_color: "#14202b",
  icons: [{ src: "/icon-192.png", sizes: "192x192", type: "image/png" }, { src: "/icon-512.png", sizes: "512x512", type: "image/png" }]
});

export function staticRoute(p) {
  if (p === "/sw.js") return new Response(SW_JS, { headers: { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache", "service-worker-allowed": "/" } });
  if (p === "/manifest.json") return new Response(MANIFEST, { headers: { "content-type": "application/manifest+json", "cache-control": "public, max-age=3600" } });
  if (p === "/icon-192.png" || p === "/icon-512.png") {
    const b = atob(p === "/icon-192.png" ? ICON_192 : ICON_512), a = new Uint8Array(b.length);
    for (let i = 0; i < b.length; i++) a[i] = b.charCodeAt(i);
    return new Response(a, { headers: { "content-type": "image/png", "cache-control": "public, max-age=86400" } });
  }
  return null;
}

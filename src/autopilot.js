// Lineup Autopilot (Fleaflicker): 50–95 minutes before kickoff, a starter who is out, on IR, suspended or on bye is
// replaced by the best healthy bench player who fits the slot. The owner's Fleaflicker session is stored encrypted
// (AES-GCM) in live state; it is never logged or returned. Every change is announced with one-tap undo.
import { hotGet, hotPut } from "./alerts.js";
import { notifyTeam } from "./bets.js";
import { fleaOwnsTeam, fleaSetLineup } from "./more.js";
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const okId = x => /^\d{1,12}$/.test(String(x || ""));
const keyName = (lid, team) => "ap:" + lid + ":" + team;

let aesKey = null;
async function key(env) {
  if (aesKey) return aesKey;
  let raw = await env.SNAP.get("ap:key");
  if (!raw) { const b = crypto.getRandomValues(new Uint8Array(32)); raw = btoa(String.fromCharCode(...b)); await env.SNAP.put("ap:key", raw); }
  const bytes = Uint8Array.from(atob(raw), c => c.charCodeAt(0));
  return (aesKey = await crypto.subtle.importKey("raw", bytes, "AES-GCM", false, ["encrypt", "decrypt"]));
}
async function seal(env, text) { const iv = crypto.getRandomValues(new Uint8Array(12)), ct = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, await key(env), new TextEncoder().encode(text))); return btoa(String.fromCharCode(...iv)) + "." + btoa(String.fromCharCode(...ct)); }
async function open(env, s) { const [a, b] = String(s || "").split("."); const iv = Uint8Array.from(atob(a), c => c.charCodeAt(0)), ct = Uint8Array.from(atob(b), c => c.charCodeAt(0)); return new TextDecoder().decode(await crypto.subtle.decrypt({ name: "AES-GCM", iv }, await key(env), ct)); }

export async function autopilotRoute(request, env, url) {
  const lid = url.searchParams.get("lid") || "", team = url.searchParams.get("team") || "", dev = url.searchParams.get("dev") || "";
  if (!okId(lid) || !okId(team) || !/^[a-f0-9]{16,64}$/.test(dev)) return out({ error: "Bad request" }, 400);
  const k = keyName(lid, team), rec = await hotGet(env, k);
  const mine = rec && rec.dev === dev;
  if (request.method === "GET") return out({ on: !!(mine && rec.on), late: !!(mine && rec.late), err: mine ? rec.err || null : null, log: mine ? (rec.log || []).slice(0, 8) : [] });
  const b = await request.json().catch(() => ({}));
  if (b.action === "on") {
    const cookie = request.headers.get("x-flea-cookie") || "";
    const own = await fleaOwnsTeam(cookie, lid, team);
    if (own.error) return out(own, 401);
    if (!own.owns) return out({ error: "Fleaflicker says that isn’t your team." }, 403);
    const next = { on: true, dev, c: await seal(env, cookie), at: Date.now(), log: (rec && rec.dev === dev && rec.log) || [] };
    await hotPut(env, k, next);
    const idx = (await hotGet(env, "ap:idx")) || []; if (!idx.includes(k)) { idx.push(k); await hotPut(env, "ap:idx", idx.slice(-200)); }
    return out({ ok: true, on: true });
  }
  if (!mine) return out({ error: "Autopilot isn’t on for this phone." }, 403);
  if (b.action === "off") { await hotPut(env, k, null); const idx = ((await hotGet(env, "ap:idx")) || []).filter(x => x !== k); await hotPut(env, "ap:idx", idx); return out({ ok: true, on: false }); }
  if (b.action === "late") { rec.late = !!b.late; await hotPut(env, k, rec); return out({ ok: true, late: rec.late }); }
  if (b.action === "undo") {
    const entry = (rec.log || []).find(x => x.id === b.id); if (!entry || entry.undone) return out({ error: "Nothing to undo." }, 404);
    const r = await fleaSetLineup(await open(env, rec.c), lid, team, entry.before);
    if (!r.ok) return out({ error: r.error || "Couldn’t undo" }, r.status || 409);
    entry.undone = Date.now(); await hotPut(env, k, rec); return out({ ok: true });
  }
  return out({ error: "Unknown action" }, 400);
}

// Fleaflicker and ESPN spell a few teams differently (JAC/JAX, WAS/WSH, LA/LAR); compare on one spelling.
const CANON = { JAX: "JAC", WSH: "WAS", LAR: "LA", LVR: "LV", OAK: "LV", SD: "LAC", STL: "LA", ARZ: "ARI", BLT: "BAL", CLV: "CLE", HST: "HOU" };
const canon = a => { a = String(a || "").toUpperCase(); return CANON[a] || a; };
const LATE_EDGE = 3;
const OUT_RE = /^(O|OUT|IR|SUS|SUSP|PUP|NFI|D|DOUBTFUL|COV)$/i;
const fits = (label, pos) => String(label).toUpperCase().split("/").map(x => x.trim()).includes(String(pos).toUpperCase()) || (/^(DEF|D\/ST|DST)$/i.test(pos) && /D\/ST|DEF/i.test(label));
// Runs every 5 minutes from the minute cron.
export async function autopilotRun(env, force) {
  const idx = (await hotGet(env, "ap:idx")) || []; if (!idx.length) return { none: true };
  // NFL teams kicking off in 50–95 minutes, teams already playing, and teams with a game this week
  let soon = new Set(), started = new Set(), playing = new Set(), windowKey = "";
  try {
    const sb = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", { headers: UA }).then(r => r.json()), now = Date.now();
    for (const e of sb.events || []) {
      const c = (e.competitions || [])[0] || {}, st = ((c.status || e.status || {}).type || {}).state, t = Date.parse(c.date || e.date);
      const abbrs = (c.competitors || []).map(x => (x.team || {}).abbreviation).filter(Boolean).map(canon);
      abbrs.forEach(a => playing.add(a));
      if (st && st !== "pre") abbrs.forEach(a => started.add(a));
      else if (force || (t - now > 50 * 60e3 && t - now < 95 * 60e3)) { abbrs.forEach(a => soon.add(a)); windowKey = windowKey || new Date(t).toISOString().slice(0, 13); }
    }
  } catch (e) { return { error: "scoreboard" }; }
  if (!soon.size) return { skipped: true };
  const nt = canon, res = {};
  for (const k of idx) {
    const rec = await hotGet(env, k); if (!rec || !rec.on) continue;
    const [, lid, team] = k.split(":");
    if ((rec.log || []).some(x => x.window === windowKey) && !force) continue;
    const ro = await fetch("https://www.fleaflicker.com/api/FetchRoster?sport=NFL&league_id=" + lid + "&team_id=" + team, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!ro) continue;
    // Fleaflicker labels the START and INJURED groups; the bench group has no label.
    const slotsOf = g => ((ro.groups || []).find(x => g === "BENCH" ? (!x.group || x.group === "BENCH") : x.group === g) || { slots: [] }).slots;
    const P = s => { const lp = s.leaguePlayer || {}, pp = lp.proPlayer || {}, inj = pp.injury || {}; return lp.proPlayer ? { id: String(pp.id), name: pp.nameFull, pos: pp.position, team: nt(pp.proTeamAbbreviation || ""), inj: inj.typeAbbreviaition || inj.typeAbbreviation || "", proj: (lp.viewingProjectedPoints || {}).value || 0, label: (s.position || {}).label || "" } : null; };
    const start = slotsOf("START").map(s => ({ label: (s.position || {}).label || "", p: P(s) })), bench = slotsOf("BENCH").map(P).filter(Boolean);
    const used = new Set(), swaps = [];
    for (const s of start) {
      const p = s.p; if (!p || started.has(p.team)) continue;
      const bye = p.team && !playing.has(p.team), hurt = OUT_RE.test(p.inj);
      if (!(bye || (hurt && soon.has(p.team)) || (bye && soon.size))) continue;
      const cand = bench.filter(x => !used.has(x.id) && fits(s.label, x.pos) && x.team && playing.has(x.team) && !started.has(x.team) && !OUT_RE.test(x.inj) && x.proj > 0).sort((a, b) => b.proj - a.proj)[0];
      if (!cand) continue;
      used.add(cand.id); swaps.push({ label: s.label, out: p, in: cand, why: bye ? "on bye" : (p.inj || "out") });
    }
    // Late swaps (opt-in): before a starter or a bench player locks, start the bench player if he's projected at
    // least LATE_EDGE points more. Decided only while both games are still unplayed, so it's a normal lineup move.
    if (rec.late) {
      // Best bench players first; each replaces the weakest starter he can play for.
      const healthy = x => x && x.team && playing.has(x.team) && !started.has(x.team) && !OUT_RE.test(x.inj);
      for (const x of bench.filter(y => !used.has(y.id) && healthy(y)).sort((a, c) => c.proj - a.proj)) {
        const slot = start.filter(s2 => s2.p && healthy(s2.p) && !swaps.some(w => w.out.id === s2.p.id) && fits(s2.label, x.pos) && (soon.has(s2.p.team) || soon.has(x.team)) && x.proj - s2.p.proj >= LATE_EDGE).sort((a, c) => a.p.proj - c.p.proj)[0];
        if (!slot) continue;
        used.add(x.id); swaps.push({ label: slot.label, out: slot.p, in: x, why: "projected " + x.proj.toFixed(1) + " vs " + slot.p.proj.toFixed(1) });
      }
    }
    if (!swaps.length) { res[k] = "nothing to do"; continue; }
    const before = start.filter(s => s.p).map(s => ({ id: s.p.id, slot: s.label }));
    const after = before.map(x => { const sw = swaps.find(w => w.out.id === x.id); return sw ? { id: sw.in.id, slot: x.slot } : x; });
    let cookie; try { cookie = await open(env, rec.c); } catch (e) { continue; }
    const r = await fleaSetLineup(cookie, lid, team, after);
    const entry = { id: Date.now().toString(36), at: Date.now(), window: windowKey, before, swaps: swaps.map(w => ({ out: w.out.name, in: w.in.name, why: w.why })), ok: !!r.ok, err: r.ok ? null : r.error };
    rec.log = [entry].concat(rec.log || []).slice(0, 20);
    if (r.login) { rec.err = "signin"; rec.on = false; }
    await hotPut(env, k, rec);
    const lines = swaps.map(w => w.in.name + " in for " + w.out.name + " (" + w.why + ")").join(", ");
    await notifyTeam(env, "flea", lid, team, r.ok
      ? { show: 1, tag: "ap:" + lid, title: swaps.every(w => /^projected/.test(w.why)) ? "🤖 Autopilot made a late swap" : "🤖 Autopilot fixed your lineup", body: lines + ". Tap to review or undo.", url: "/?autopilot=" + lid }
      : { show: 1, tag: "ap:" + lid, title: r.login ? "🤖 Autopilot needs you to sign in to Fleaflicker again" : "🤖 Autopilot couldn’t fix your lineup", body: r.login ? "It’s paused until you sign in again in Snap Count." : (lines + ". " + (r.error || "")), url: "/?autopilot=" + lid });
    res[k] = r.ok ? "swapped " + swaps.length : "failed: " + r.error;
  }
  return res;
}

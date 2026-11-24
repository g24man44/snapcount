import { fleaOwnsTeam } from "./more.js";
// One phone, one team: a phone that posts or acts for a team in a league is locked to that team, and the name shown is
// the team's real name from the league site. Stops anyone from typing someone else's name into the league chat or
// sending bets, trade offers and taunts as another team. The league's Snap Count commissioner can reset a team.
const hot = env => env.CHAT.get(env.CHAT.idFromName("hot"));
async function hget(env, k) { try { return await hot(env).fetch("https://chat/state?k=" + encodeURIComponent(k)).then(r => r.json()); } catch (e) { return null; } }
async function hput(env, k, v) { await hot(env).fetch("https://chat/state?k=" + encodeURIComponent(k), { method: "POST", body: JSON.stringify(v) }); }
const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const okDev = d => /^[a-f0-9]{16,64}$/.test(String(d || ""));

async function fleaTeamNames(env, lid) {
  const k = "tn:flea:" + lid, c = await hget(env, k);
  if (c && Date.now() - c.at < 6 * 3600e3) return c.m;
  const r = await fetch("https://www.fleaflicker.com/api/FetchLeagueStandings?sport=NFL&league_id=" + lid, { headers: UA }).catch(() => null);
  const j = r && r.ok ? await r.json().catch(() => null) : null;
  if (!j) return c ? c.m : null;
  const m = {}; (j.divisions || []).forEach(d => (d.teams || []).forEach(t => { m[String(t.id)] = t.name; }));
  await hput(env, k, { at: Date.now(), m });
  return m;
}
async function commOf(env, p, lid) { const c = await env.SNAP.get("comm:" + p + ":" + lid, "json").catch(() => null); return c && c.owner ? c.owner : null; }

// Returns { name } when this phone may act for `team`, or { error, status }.
export async function asTeam(env, p, lid, team, dev, givenName) {
  team = String(team || ""); dev = String(dev || "");
  if (!team || !okDev(dev)) return { error: "Pick your team in this league first.", status: 400 };
  let name = String(givenName || "").slice(0, 60);
  if (p === "flea") { const m = await fleaTeamNames(env, lid); if (m) { if (!m[team]) return { error: "That team isn’t in this league.", status: 400 }; name = m[team]; } }
  const k = "claims:" + p + ":" + lid, cl = (await hget(env, k)) || {};
  const comm = await commOf(env, p, lid);
  if (comm && String(comm.team) === team && comm.dev !== dev) return { error: name + " belongs to your league’s commissioner. Pick your own team in Snap Count.", status: 403 };
  if (cl[team] && cl[team].dev !== dev && cl[team].verified) return { error: name + " is verified by its owner through Fleaflicker. Pick your own team in Snap Count.", status: 403 };
  if (cl[team] && cl[team].dev !== dev) return { error: "Another phone already acts as " + name + ". If that’s really your team, ask your commissioner to reset it.", status: 403 };
  const held = Object.keys(cl).find(t => t !== team && cl[t].dev === dev);
  if (held) return { error: "This phone is set up as " + (cl[held].name || "another team") + " in this league. Ask your commissioner to switch it.", status: 403 };
  if (!cl[team]) { cl[team] = { dev, name, at: Date.now() }; await hput(env, k, cl); }
  return { name: name || "A manager", verified: !!(cl[team] && cl[team].verified) };
}
// Fleaflicker sign-in proved this phone owns `team`: it takes the team over from any unverified phone.
export async function verifyTeam(env, p, lid, team, dev) {
  const k = "claims:" + p + ":" + lid, cl = (await hget(env, k)) || {};
  Object.keys(cl).forEach(t => { if (cl[t].dev === dev && t !== team) delete cl[t]; });
  let name = cl[team] && cl[team].name || "";
  if (p === "flea") { const m = await fleaTeamNames(env, lid); if (m && m[team]) name = m[team]; }
  cl[team] = { dev, name, at: Date.now(), verified: true };
  await hput(env, k, cl);
  return { name };
}
export async function claimsRoute(request, env, url) {
  const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "", dev = url.searchParams.get("dev") || "";
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad league" }, 400);
  const k = "claims:" + p + ":" + lid, cl = (await hget(env, k)) || {}, comm = await commOf(env, p, lid), isComm = !!(comm && comm.dev === dev);
  if (request.method === "GET") return out({ isComm, mine: Object.keys(cl).find(t => cl[t].dev === dev) || null, teams: Object.fromEntries(Object.entries(cl).map(([t, v]) => [t, { name: v.name, at: v.at, verified: !!v.verified }])) });
  const b = await request.json().catch(() => ({}));
  if (b.action === "verify") {
    if (p !== "flea") return out({ error: "Verification works with Fleaflicker leagues for now." }, 400);
    const r = await fleaOwnsTeam(request.headers.get("x-flea-cookie") || "", lid, String(b.team || ""));
    if (r.error) return out(r, 401);
    if (!r.owns) return out({ error: "Fleaflicker says that isn’t your team. Pick the team you own." }, 403);
    if (!/^[a-f0-9]{16,64}$/.test(dev)) return out({ error: "Bad device" }, 400);
    return out(Object.assign({ ok: true }, await verifyTeam(env, p, lid, String(b.team), dev)));
  }
  if (!isComm) return out({ error: "Only your league’s Snap Count commissioner can reset a team." }, 403);
  if (b.action === "reset" && cl[String(b.team)]) { delete cl[String(b.team)]; await hput(env, k, cl); }
  return out({ ok: true });
}

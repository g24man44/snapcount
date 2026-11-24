// Last-place punishment: the league suggests punishments and votes (one vote per team) during the regular season.
// When the regular season ends, voting closes, the last-place team is set from the standings (Fleaflicker) or by the
// commissioner, and the loser posts proof photos. Served punishments go into the league's Hall of Shame.
import { hotGet, hotPut, eachSubscriber } from "./alerts.js";
import { asTeam } from "./claims.js";
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const shameRoom = (env, p, lid) => env.CHAT.get(env.CHAT.idFromName("shame:" + p + ":" + lid));
const IMG_MAX = 1800000;
const imgType = b => { const a = new Uint8Array(b, 0, 12); if (a[0] === 0xff && a[1] === 0xd8) return "image/jpeg"; if (a[0] === 0x89 && a[1] === 0x50) return "image/png"; if (a[8] === 0x57 && a[9] === 0x45) return "image/webp"; return ""; };
async function commOf(env, p, lid) { const c = await env.SNAP.get("comm:" + p + ":" + lid, "json").catch(() => null); return c && c.owner ? c.owner : null; }
// Fleaflicker: has the regular season ended, and who finished last?
async function fleaLast(lid) {
  const sb = await fetch("https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=" + lid, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
  if (!sb || !(sb.games || []).some(g => g.isPlayoffs || g.isConsolation)) return null;
  const st = await fetch("https://www.fleaflicker.com/api/FetchLeagueStandings?sport=NFL&league_id=" + lid, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
  const T = []; ((st && st.divisions) || []).forEach(d => (d.teams || []).forEach(t => T.push({ team: String(t.id), name: t.name, w: (t.recordOverall || {}).wins || 0, pf: ((t.pointsFor || {}).value) || 0 })));
  T.sort((a, b) => (a.w - b.w) || (a.pf - b.pf));
  return T[0] || null;
}
export async function punishRoute(request, env, url) {
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "", season = url.searchParams.get("season") || String(new Date().getFullYear());
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid) || !/^\d{4}$/.test(season)) return out({ error: "Bad league" }, 400);
  if (url.pathname === "/api/punish/img") {
    const r = await shameRoom(env, p, lid).fetch("https://chat/img/get?id=" + encodeURIComponent(url.searchParams.get("id") || ""));
    return new Response(r.body, { status: r.status, headers: { "content-type": r.headers.get("content-type") || "image/jpeg", "cache-control": "public, max-age=31536000, immutable" } });
  }
  const k = "punish:" + p + ":" + lid + ":" + season, S = (await hotGet(env, k)) || { ideas: [], votes: {}, proofs: [] };
  const shameK = "shame:" + p + ":" + lid, shame = (await hotGet(env, shameK)) || [];
  // Close the vote automatically once a Fleaflicker league reaches its playoffs
  if (!S.closed && p === "flea") { const last = await fleaLast(lid); if (last) { closeVote(S, last); await hotPut(env, k, S); await announce(env, p, lid, S); } }
  if (request.method === "GET") return out(Object.assign({}, S, { shame }));
  const dev = url.searchParams.get("dev") || "";
  if (url.pathname === "/api/punish/photo") {
    const who = await asTeam(env, p, lid, url.searchParams.get("team"), dev, url.searchParams.get("teamName")); if (who.error) return out({ error: who.error }, who.status);
    const comm = await commOf(env, p, lid);
    if (!S.loser || (String(url.searchParams.get("team")) !== S.loser.team && !(comm && comm.dev === dev))) return out({ error: "Only the last-place team posts the proof." }, 403);
    const body = await request.arrayBuffer(); if (body.byteLength > IMG_MAX) return out({ error: "That photo is too big. Try a smaller one." }, 413);
    const type = body.byteLength > 12 ? imgType(body) : ""; if (!type) return out({ error: "That file isn’t a photo." }, 415);
    if ((S.proofs || []).length >= 12) return out({ error: "That’s plenty of proof." }, 429);
    const a = new Uint8Array(8); crypto.getRandomValues(a);
    const id = Date.now().toString(36) + [...a].map(x => "abcdefghijkmnpqrstuvwxyz23456789"[x % 32]).join("");
    await shameRoom(env, p, lid).fetch("https://chat/img/put?id=" + id + "&t=" + encodeURIComponent(type), { method: "POST", body });
    S.proofs = (S.proofs || []).concat({ id, cap: String(url.searchParams.get("text") || "").slice(0, 200), at: Date.now() });
    const first = !S.served; S.served = S.served || Date.now(); await hotPut(env, k, S);
    if (first) {
      const pun = (S.ideas.find(x => x.id === S.winner) || {}).text || "the punishment";
      shame.unshift({ season, loser: S.loser, punishment: pun, proofs: [id], at: Date.now() }); await hotPut(env, shameK, shame.slice(0, 30));
      await eachSubscriber(env, rec => (rec.leagues || []).some(L => L.p === p && String(L.id) === lid) ? [{ id: "shame:" + lid + ":" + season, title: "🚽 " + S.loser.name + " served their punishment", body: pun + ". See the proof in Snap Count.", url: "/?punish=" + p + ":" + lid }] : []);
    } else { const h = shame.find(x => x.season === season); if (h) { h.proofs = (h.proofs || []).concat(id).slice(-12); await hotPut(env, shameK, shame); } }
    return out({ ok: true, id });
  }
  const b = await request.json().catch(() => ({}));
  const who = await asTeam(env, p, lid, b.team, b.dev, b.teamName); if (who.error) return out({ error: who.error }, who.status);
  const team = String(b.team);
  if (b.action === "idea") {
    if (S.closed) return out({ error: "Voting is closed for this season." }, 409);
    const text = String(b.text || "").trim().slice(0, 160); if (text.length < 4) return out({ error: "Describe the punishment." }, 400);
    if (S.ideas.filter(x => x.by.team === team).length >= 2) return out({ error: "Two ideas per team." }, 429);
    const idea = { id: Date.now().toString(36), text, by: { team, name: who.name }, at: Date.now() };
    S.ideas.push(idea); S.votes[team] = S.votes[team] || idea.id; await hotPut(env, k, S); return out({ ok: true });
  }
  if (b.action === "vote") {
    if (S.closed) return out({ error: "Voting is closed for this season." }, 409);
    if (!S.ideas.some(x => x.id === b.id)) return out({ error: "Pick one of the ideas." }, 400);
    S.votes[team] = String(b.id); await hotPut(env, k, S); return out({ ok: true });
  }
  if (b.action === "close") { // the commissioner closes the vote and names last place (needed outside Fleaflicker)
    const comm = await commOf(env, p, lid); if (!comm || comm.dev !== String(b.dev)) return out({ error: "Only your league’s Snap Count commissioner can close the vote." }, 403);
    closeVote(S, { team: String(b.loser || ""), name: String(b.loserName || "").slice(0, 60) }); await hotPut(env, k, S); await announce(env, p, lid, S); return out({ ok: true });
  }
  return out({ error: "Unknown action" }, 400);
}
function closeVote(S, last) {
  const c = {}; Object.values(S.votes || {}).forEach(id => c[id] = (c[id] || 0) + 1);
  S.winner = (S.ideas.slice().sort((a, b) => (c[b.id] || 0) - (c[a.id] || 0) || a.at - b.at)[0] || {}).id || null;
  S.loser = { team: last.team, name: last.name }; S.closed = Date.now();
}
async function announce(env, p, lid, S) {
  const pun = (S.ideas.find(x => x.id === S.winner) || {}).text; if (!S.loser || !S.loser.team) return;
  await eachSubscriber(env, rec => (rec.leagues || []).some(L => L.p === p && String(L.id) === lid) ? [{ id: "punish:" + lid + ":" + S.closed, title: "🚽 " + S.loser.name + " finished last", body: pun ? "The league voted: " + pun + "." : "Time to decide their punishment.", url: "/?punish=" + p + ":" + lid }] : []);
}

// Side bets: friendly stakes between two managers in a league (no money ever goes through the app).
// Stored in the live-state Durable Object (no KV writes). Fleaflicker bets settle themselves when the week is final;
// on other sites either side taps the winner.
import { hotGet, hotPut, sendPushData, subscriberIds } from "./alerts.js";

const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const keyOf = (p, lid) => "bets:" + p + ":" + lid;
const MONEY = /\$|\bdollars?\b|\bbucks\b|venmo|cash ?app|paypal|zelle|\bmoney\b/i;

async function notifyTeam(env, p, lid, team, data) {
  let sent = 0;
  for (const id of await subscriberIds(env)) {
    const rec = await env.SNAP.get("sub:" + id, "json");
    if (!rec || !rec.sub) continue;
    if (!(rec.leagues || []).some(L => L.p === p && L.id === lid && L.team === team)) continue;
    try { const st = await sendPushData(env, rec.sub, rec.origin, data, 3600); if (st >= 200 && st < 300) sent++; } catch (e) {}
  }
  return sent;
}
const nm = s => String(s || "").slice(0, 60);

export async function betsRoute(request, env, url) {
  if (request.method === "GET") {
    const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
    if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad request" }, 400);
    return out({ bets: (await hotGet(env, keyOf(p, lid))) || [] });
  }
  if (request.method !== "POST") return out({ error: "GET or POST" }, 405);
  const b = await request.json().catch(() => ({}));
  const p = String(b.p || ""), lid = String(b.lid || "");
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad request" }, 400);
  const k = keyOf(p, lid), list = (await hotGet(env, k)) || [];
  const tag = "bet:" + lid;
  if (b.action === "offer") {
    const from = b.from || {}, to = b.to || {}, stake = String(b.stake || "").trim().slice(0, 90), week = Number(b.week);
    if (!from.id || !to.id || from.id === to.id || !stake || !(week > 0 && week < 30)) return out({ error: "Pick a team, a week and the stakes." }, 400);
    if (MONEY.test(stake)) return out({ error: "Keep it friendly: Snap Count bets are for bragging rights, not money." }, 400);
    if (list.filter(x => x.status === "offered" || x.status === "on").length >= 40) return out({ error: "This league has a lot of open bets. Settle a few first." }, 429);
    const bet = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), week, stake, from: { id: String(from.id), name: nm(from.name) }, to: { id: String(to.id), name: nm(to.name) }, status: "offered", at: Date.now() };
    list.unshift(bet); await hotPut(env, k, list.slice(0, 150)); await trackBetLeague(env, p, lid);
    const sent = await notifyTeam(env, p, lid, bet.to.id, { show: 1, tag, title: "🤝 " + bet.from.name + " wants a side bet", body: "Higher score in week " + week + ". Loser: " + stake, url: "/?bets=" + p + ":" + lid });
    return out({ ok: true, bet, sent });
  }
  const bet = list.find(x => x.id === b.id);
  if (!bet) return out({ error: "That bet is gone." }, 404);
  const team = String(b.team || "");
  if (b.action === "accept" || b.action === "decline") {
    if (team !== bet.to.id || bet.status !== "offered") return out({ error: "Only " + bet.to.name + " can answer this bet." }, 403);
    bet.status = b.action === "accept" ? "on" : "declined"; bet.answered = Date.now();
    await hotPut(env, k, list);
    await notifyTeam(env, p, lid, bet.from.id, { show: 1, tag, title: b.action === "accept" ? "🤝 It’s on: " + bet.to.name + " took your bet" : bet.to.name + " passed on your bet", body: b.action === "accept" ? "Week " + bet.week + ". Loser: " + bet.stake : "Maybe next week.", url: "/?bets=" + p + ":" + lid });
    return out({ ok: true, bet });
  }
  if (b.action === "cancel") {
    if (team !== bet.from.id || bet.status !== "offered") return out({ error: "Only an unanswered offer can be taken back." }, 403);
    bet.status = "cancelled"; await hotPut(env, k, list); return out({ ok: true, bet });
  }
  if (b.action === "settle") { // sites other than Fleaflicker: either side reports the result
    if (p === "flea") return out({ error: "Fleaflicker bets settle themselves once the week is final." }, 400);
    if (bet.status !== "on" || (team !== bet.from.id && team !== bet.to.id)) return out({ error: "Only the two of you can settle this bet." }, 403);
    const w = String(b.winner || "");
    if (w !== bet.from.id && w !== bet.to.id && w !== "push") return out({ error: "Pick the winner." }, 400);
    settle(bet, w, null); await hotPut(env, k, list);
    await announce(env, p, lid, bet);
    return out({ ok: true, bet });
  }
  if (b.action === "paid") { // the winner says the loser made good on the stakes
    const w = bet.winner;
    if (bet.status !== "settled" || team !== w) return out({ error: "Only the winner can mark it done." }, 403);
    bet.paid = Date.now(); await hotPut(env, k, list); return out({ ok: true, bet });
  }
  return out({ error: "Unknown action" }, 400);
}
function settle(bet, winner, scores) { bet.status = "settled"; bet.winner = winner; bet.settled = Date.now(); if (scores) bet.scores = scores; }
async function announce(env, p, lid, bet) {
  const tag = "bet:" + lid;
  if (bet.winner === "push") {
    for (const t of [bet.from, bet.to]) await notifyTeam(env, p, lid, t.id, { show: 1, tag, title: "🤝 Your bet ended in a tie", body: "Week " + bet.week + ": nobody owes anything.", url: "/?bets=" + p + ":" + lid });
    return;
  }
  const W = bet.winner === bet.from.id ? bet.from : bet.to, Lz = bet.winner === bet.from.id ? bet.to : bet.from;
  const sc = bet.scores ? " (" + bet.scores[W.id] + " to " + bet.scores[Lz.id] + ")" : "";
  await notifyTeam(env, p, lid, W.id, { show: 1, tag, title: "🏆 You won your bet with " + Lz.name, body: "Week " + bet.week + sc + ". They owe you: " + bet.stake, url: "/?bets=" + p + ":" + lid });
  await notifyTeam(env, p, lid, Lz.id, { show: 1, tag, title: "😬 You lost your bet with " + W.name, body: "Week " + bet.week + sc + ". Time to pay up: " + bet.stake, url: "/?bets=" + p + ":" + lid });
}
// Runs from the minute cron every 15 minutes: settle Fleaflicker bets whose week is final.
export async function settleBets(env) {
  const idx = (await hotGet(env, "bets:leagues")) || [];
  for (const lid of idx) {
    const k = keyOf("flea", lid), list = (await hotGet(env, k)) || [];
    const weeks = [...new Set(list.filter(x => x.status === "on").map(x => x.week))];
    let changed = false;
    for (const w of weeks) {
      const r = await fetch("https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&scoring_period=" + w, { headers: UA }).catch(() => null);
      if (!r || !r.ok) continue;
      const j = await r.json().catch(() => null); if (!j || !(j.games || []).length) continue;
      if (!(j.games || []).every(g => g.isFinalScore)) continue;
      const pts = {}; (j.games || []).forEach(g => { pts[String(g.away.id)] = (g.awayScore && g.awayScore.score && g.awayScore.score.value) || 0; pts[String(g.home.id)] = (g.homeScore && g.homeScore.score && g.homeScore.score.value) || 0; });
      for (const bet of list.filter(x => x.status === "on" && x.week === w)) {
        const a = pts[bet.from.id], c = pts[bet.to.id]; if (a == null || c == null) continue;
        settle(bet, a === c ? "push" : a > c ? bet.from.id : bet.to.id, { [bet.from.id]: a, [bet.to.id]: c });
        changed = true; await announce(env, "flea", lid, bet);
      }
    }
    if (changed) await hotPut(env, k, list);
  }
}
export async function trackBetLeague(env, p, lid) {
  if (p !== "flea") return;
  const idx = (await hotGet(env, "bets:leagues")) || [];
  if (!idx.includes(lid)) { idx.push(lid); await hotPut(env, "bets:leagues", idx.slice(-50)); }
}

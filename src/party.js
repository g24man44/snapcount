import { asTeam } from "./claims.js";
// Game day: a live thread that lives only inside Snap Count (nothing goes to GroupMe). The minute cron posts the league's
// fantasy scoring plays, lead changes and final results; managers add comments and reactions from the app.
import { hotGet, hotPut } from "./alerts.js";

const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const FF = "https://www.fleaflicker.com/api/";
const getJ = u => fetch(u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const roomOf = (env, p, lid) => env.CHAT.get(env.CHAT.idFromName("party:" + p + ":" + lid));
const norm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, "").replace(/[^a-z]/g, "");
const f2 = n => (Math.round(n * 100) / 100).toFixed(2).replace(/\.?0+$/, "");
async function postMsg(env, p, lid, m) {
  await roomOf(env, p, lid).fetch("https://chat/add", { method: "POST", body: JSON.stringify(Object.assign({ at: Date.now() }, m)) });
}

export async function partyRoute(request, env, url) {
  if (!env.CHAT) return out({ error: "Game day isn’t available on this server yet." }, 503);
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad league" }, 400);
  if (request.method === "GET") {
    const r = await roomOf(env, p, lid).fetch("https://chat/list"); return out(await r.json());
  }
  if (request.method !== "POST") return out({ error: "GET or POST" }, 405);
  const b = await request.json().catch(() => ({}));
  const dev = String(b.dev || ""), poll = b.poll && Array.isArray(b.poll.opts) ? b.poll : null;
  const text = String(b.text || (poll ? poll.q : "") || "").trim().slice(0, 400);
  if (!/^[a-f0-9]{16,64}$/.test(dev) || !text) return out({ error: "Nothing to send." }, 400);
  const who = await asTeam(env, p, lid, b.team, dev, b.teamName);
  if (who.error) return out({ error: who.error }, who.status);
  const name = who.name;
  const gate = await roomOf(env, p, lid).fetch("https://chat/gate?dev=" + dev);
  if (gate.status === 429) return out({ error: "Slow down a second." }, 429);
  const a = new Uint8Array(6); crypto.getRandomValues(a);
  const id = "u" + Date.now().toString(36) + [...a].map(x => x.toString(16)).join("");
  if (poll) {
    const opts = poll.opts.slice(0, 4).map(o => ({ id: String(o.id || "").slice(0, 20), name: String(o.name || "").slice(0, 50), pos: String(o.pos || "").slice(0, 6) })).filter(o => o.name);
    if (opts.length < 2) return out({ error: "A poll needs at least two choices." }, 400);
    await postMsg(env, p, lid, { id, name, text, kind: "poll", data: { opts, week: Number(poll.week) || 0, by: String(b.team || "") } });
    return out({ ok: true });
  }
  await postMsg(env, p, lid, { id, name, text, kind: "user" });
  return out({ ok: true });
}

// Every 2 minutes while NFL games are on (cheap: it reads the scoring plays the touchdown alerts already saved).
export async function partyFeed(env) {
  const plays = (await hotGet(env, "plays:state")) || {};
  const live = Object.keys(plays).some(k => k !== "_ev");
  const idx = (await env.SNAP.get("fleaLeagues", "json")) || {};
  for (const lid of Object.keys(idx).slice(0, 10)) {
    const seenK = "party:seen:" + lid, seen = (await hotGet(env, seenK)) || { ev: [], lead: {}, fin: 0 };
    let changed = false;
    // 1. Scoring plays by rostered players
    const evs = (plays._ev || []).filter(e => !seen.ev.includes(e.id));
    if (evs.length) {
      let ros = await hotGet(env, "party:ros:" + lid);
      if (!ros || Date.now() - ros.at > 1800e3) {
        const r = await fetch("https://www.fleaflicker.com/api/FetchLeagueRosters?sport=NFL&league_id=" + lid, { headers: UA }).catch(() => null);
        const j = r && r.ok ? await r.json().catch(() => null) : null;
        if (j) { ros = { at: Date.now(), m: {} }; (j.rosters || []).forEach(t => (t.players || []).forEach(pl => { const pp = pl.proPlayer || {}; if (pp.nameFull) ros.m[norm(pp.nameFull)] = { n: pp.nameFull, t: (t.team || {}).name || "" }; })); await hotPut(env, "party:ros:" + lid, ros); }
      }
      for (const e of evs) {
        seen.ev.push(e.id); changed = true;
        if (!ros) continue;
        const t = " " + e.text.toLowerCase().replace(/[^a-z ]/g, "") + " ";
        const hits = Object.values(ros.m).filter(x => { const parts = x.n.toLowerCase().replace(/\b(jr|sr|ii|iii|iv)\.?\b/g, "").replace(/[^a-z ]/g, "").trim(); return parts.length > 5 && t.includes(" " + parts + " "); });
        if (!hits.length) continue;
        const icon = e.kind === "td" ? "🏈" : e.kind === "score" ? "🎯" : "💨";
        await postMsg(env, "flea", lid, { id: "e:" + e.id, name: "Game day", kind: "play", text: icon + " " + hits.map(x => x.n + " (" + x.t + ")").join(", ") + ": " + e.text + (e.game ? " · " + e.game : "") });
      }
      seen.ev = seen.ev.slice(-200);
    }
    // 2. Lead changes and final results, every 6 minutes while games are live (and once after the last one ends)
    const m = new Date().getUTCMinutes();
    if ((live && m % 6 === 1) || (!live && m % 10 === 1 && seen.lead && Object.keys(seen.lead).length && !seen.finWeek)) {
      const r = await fetch("https://www.fleaflicker.com/api/FetchLeagueScoreboard?sport=NFL&league_id=" + lid, { headers: UA }).catch(() => null);
      const j = r && r.ok ? await r.json().catch(() => null) : null;
      if (j) {
        const wk = (j.schedulePeriod || {}).ordinal || 0;
        if (seen.week !== wk) { seen.week = wk; seen.lead = {}; seen.finWeek = 0; changed = true; }
        const sc = x => (x && x.score && x.score.value) || 0;
        const games = j.games || [], allFinal = games.length && games.every(g => g.isFinalScore);
        for (const g of games) {
          const a = sc(g.awayScore), h = sc(g.homeScore), A = g.away.name, H = g.home.name, k = g.id;
          if (!(a || h)) continue;
          const lead = a === h ? "tie" : a > h ? "a" : "h", was = seen.lead[k];
          if (was && was !== lead && lead !== "tie" && !allFinal) await postMsg(env, "flea", lid, { id: "l:" + k + ":" + Date.now(), name: "Game day", kind: "lead", text: "🔄 " + (lead === "a" ? A : H) + " takes the lead over " + (lead === "a" ? H : A) + ", " + f2(Math.max(a, h)) + " to " + f2(Math.min(a, h)) + "." });
          if (was !== lead) { seen.lead[k] = lead; changed = true; }
        }
        if (allFinal && seen.finWeek !== wk) {
          const lines = games.map(g => { const a = sc(g.awayScore), h = sc(g.homeScore); return (a >= h ? g.away.name : g.home.name) + " beat " + (a >= h ? g.home.name : g.away.name) + ", " + f2(Math.max(a, h)) + " to " + f2(Math.min(a, h)); });
          await postMsg(env, "flea", lid, { id: "f:" + wk, name: "Game day", kind: "final", text: "🏁 Week " + wk + " is final.\n" + lines.join("\n") });
          seen.finWeek = wk; changed = true;
        }
      }
    }
    if (changed) await hotPut(env, seenK, seen);
  }
}

// Votes for polls and "who won this trade?": one vote per phone, counts only.
export async function pollRoute(request, env, url) {
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad league" }, 400);
  const key = id => "poll:" + p + ":" + lid + ":" + id;
  if (request.method === "GET") {
    const ids = String(url.searchParams.get("ids") || "").split(",").filter(x => /^[\w:.-]{1,60}$/.test(x)).slice(0, 30), dev = url.searchParams.get("dev") || "";
    const res = {};
    for (const id of ids) { const v = (await hotGet(env, key(id))) || {}; const c = {}; Object.values(v).forEach(ch => c[ch] = (c[ch] || 0) + 1); res[id] = { counts: c, mine: v[dev] || null }; }
    return out({ polls: res });
  }
  const b = await request.json().catch(() => ({}));
  const id = String(b.id || ""), dev = String(b.dev || ""), ch = String(b.choice || "").slice(0, 40);
  if (!/^[\w:.-]{1,60}$/.test(id) || !/^[a-f0-9]{16,64}$/.test(dev) || !ch) return out({ error: "Bad vote" }, 400);
  const v = (await hotGet(env, key(id))) || {}; v[dev] = ch; await hotPut(env, key(id), v);
  return out({ ok: true });
}

// Transaction wire: every trade and pickup in the league, posted to Game day (checked every 6 minutes).
const tslim = t => { const team = x => ({ id: String((x || {}).id || ""), name: (x || {}).name || "" });
  return { id: String(t.id), t: Number(t.approvedOn || t.proposedOn || 0), desc: t.description || "",
    sides: (t.teams || []).map(sd => Object.assign(team(sd.team), {
      players: (sd.playersObtained || []).map(x => { const pp = x.proPlayer || {}; return { id: String(pp.id), name: pp.nameFull || "", pos: pp.position || "", team: pp.proTeamAbbreviation || "" }; }),
      picks: (sd.picksObtained || []).map(x => { const pk = x.draftPick || x, sl = pk.slot || {}; return { season: Number(pk.season) || 0, round: Number(sl.round || pk.round) || 0, slot: Number(sl.slot) || 0, overall: Number(sl.overall) || 0, from: ((pk.originalOwner || {}).name) || "" }; }) })) }; };
export async function wireFeed(env) {
  const idx = (await env.SNAP.get("fleaLeagues", "json")) || {};
  for (const lid of Object.keys(idx).slice(0, 10)) {
    const k = "wire:" + lid, st = (await hotGet(env, k)) || {}, first = !st.seeded;
    st.trades = st.trades || []; st.tx = st.tx || [];
    const tr = await getJ(FF + "FetchTrades?sport=NFL&filter=TRADES_COMPLETED&league_id=" + lid);
    for (const t of ((tr && tr.trades) || []).slice().reverse()) {
      const id = String(t.id); if (st.trades.includes(id)) continue; st.trades.push(id);
      if (first) continue;
      const s2 = tslim(t), say = s2.sides.map(sd => sd.name + " gets " + (sd.players.map(x => x.name).concat(sd.picks.map(x => x.season + " round " + x.round + " pick")).join(", ") || "nothing")).join(". ");
      await postMsg(env, "flea", lid, { id: "t:" + id, name: "Trade wire", kind: "trade", text: "🔁 Trade! " + say + ".", data: s2 });
    }
    const tx = await getJ(FF + "FetchLeagueTransactions?sport=NFL&league_id=" + lid);
    const groups = {};
    for (const it of ((tx && tx.items) || [])) {
      const t = it.transaction || {}, pp = (t.player || {}).proPlayer || {}, team = t.team || {}, type = t.type || "TRANSACTION_ADD";
      if (/TRADE/.test(type)) continue;
      const id = it.timeEpochMilli + ":" + pp.id + ":" + type; if (st.tx.includes(id)) continue; st.tx.push(id);
      if (first) continue;
      const g = groups[team.id + ":" + Math.floor(Number(it.timeEpochMilli) / 600000)] = groups[team.id + ":" + Math.floor(Number(it.timeEpochMilli) / 600000)] || { team: team.name, add: [], drop: [], claim: false, t: Number(it.timeEpochMilli) };
      const nm = pp.nameFull + " (" + (pp.position || "") + (pp.proTeamAbbreviation ? ", " + pp.proTeamAbbreviation : "") + ")";
      if (/DROP/.test(type)) g.drop.push(nm); else { g.add.push(nm); if (/CLAIM/.test(type)) g.claim = true; }
    }
    for (const [gk, g] of Object.entries(groups).sort((a, b) => a[1].t - b[1].t)) {
      const parts = []; if (g.add.length) parts.push((g.claim ? "claimed " : "added ") + g.add.join(", ")); if (g.drop.length) parts.push("dropped " + g.drop.join(", "));
      if (parts.length) await postMsg(env, "flea", lid, { id: "x:" + gk, name: "Transaction wire", kind: "move", text: "📝 " + g.team + " " + parts.join(" and ") + "." });
    }
    st.trades = st.trades.slice(-60); st.tx = st.tx.slice(-300); st.seeded = true;
    await hotPut(env, k, st);
  }
}

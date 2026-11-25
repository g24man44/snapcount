// Receipts: Snap Count keeps every bold prediction made in the league chat, then shows the result when it comes in.
// Every 10 minutes the cron reads new chat messages (GroupMe-bridged chat, Fleaflicker leagues), asks the AI to
// pick out checkable predictions ("I'm beating Ryan by 30", "Jeanty busts this week", "Tuna misses the playoffs"),
// and stores them. When a week goes final, the AI judges each due prediction against that week's exact scores,
// every rostered player's points, NFL results and the standings. Settled receipts are posted in the app's chat only
// (never to GroupMe) and sent as one notification to the league. All storage is in the live-state Durable Object.
import { hotGet, hotPut, subscriberIds, sendPushData } from "./alerts.js";
import { aiComplete } from "./more.js";

const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const FF = "https://www.fleaflicker.com/api/";
const getJ = u => fetch(u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const val = x => x == null ? null : typeof x === "object" ? Number(x.value ?? x.formatted ?? 0) : Number(x);
const n2 = x => String(Math.round((Number(x) || 0) * 100) / 100);
const keyOf = (p, lid) => "rcpt:" + p + ":" + lid;
const room = (env, p, lid) => env.CHAT.get(env.CHAT.idFromName(p + ":" + lid));
const KEEP = 250;
const HINT = /\b(will|won'?t|gonna|going to|bet|lock|guarantee[ds]?|easy|ez|smash|crush|beat|beats|beating|win|wins|winning|lose|loses|losing|bust|busts|boom|booms|over|under|points?|pts|playoffs?|champ|champion|championship|title|last place|ship|trophy|no way|never|calling it|book it|mark my words|predict(ion)?|by \d+)\b/i;
const day = t => new Date(t).toLocaleDateString("en-US", { timeZone: "America/New_York", month: "short", day: "numeric" });
const when = t => new Date(t).toLocaleString("en-US", { timeZone: "America/New_York", weekday: "short", month: "short", day: "numeric", hour: "numeric", minute: "2-digit" });

function parseJSON(t) { const m = String(t || "").match(/\{[\s\S]*\}/); if (!m) return null; try { return JSON.parse(m[0]); } catch (e) { return null; } }

// Who said it: a person's GroupMe name, or the team name on a message posted from the app ("Team ✓: text").
function speaker(m) {
  if (m.sys) return null;
  const text = String(m.text || "");
  if (!m.bot) return { by: String(m.name || "").slice(0, 60), text };
  if (/^(📣|🏈|📰|🔥|🧾)/.test(text) || m.name === "Receipts") return null;
  const x = text.match(/^([^:\n]{1,60}?)(?: ✓)?: ([\s\S]+)$/);
  return x ? { by: x[1], text: x[2] } : null;
}

async function weekState(lid) {
  const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid);
  if (!sb) return null;
  const W = Number((sb.schedulePeriod || {}).ordinal || (sb.schedulePeriod || {}).value || 0);
  const g = sb.games || [];
  const allFinal = g.length && g.every(x => x.isFinalScore), started = g.some(x => x.isInProgress || x.isFinalScore || val((x.homeScore || {}).score) || val((x.awayScore || {}).score));
  const teams = [...new Set(g.flatMap(x => [(x.away || {}).name, (x.home || {}).name]).filter(Boolean))];
  return { W, allFinal: !!allFinal, started: !!started, teams, name: (sb.league || {}).name || "" };
}

const EXTRACT = `You read a fantasy football league's group chat and pick out bold, checkable PREDICTIONS so the app can show the receipts later.
Return ONLY JSON: {"claims":[{"i":<message number>,"claim":"<short neutral restatement naming who/what, the outcome and the week>","week":<fantasy week number or null>,"season":<true or false>}]}
Count a message only if it predicts a future outcome that exact fantasy scores, NFL game results or final standings will settle:
- a fantasy matchup winner or margin ("I'm beating Ryan by 30 this week")
- a fantasy team or a player scoring over/under a number, or busting/booming in a given week
- an NFL game result
- season outcomes: who makes or misses the playoffs, wins the title, finishes last, ends with some record (set "season": true, "week": null)
Skip: questions, jokes with no checkable outcome, results that already happened, trades and roster talk, vague takes ("he's washed") with no week or season outcome, anything unclear.
Week rules: fantasy weeks follow NFL weeks (Thursday to Monday). "This week" means the current week unless that week is already over, then it means the next one. "Next week" adds one. Use the TEAMS list to write team names exactly.
Most messages contain no prediction. An empty list is normal and correct.`;

const JUDGE = `You check fantasy football predictions against DATA and give each a verdict.
Return ONLY JSON: {"verdicts":[{"id":"<id>","verdict":"right"|"wrong"|"pending"|"void","proof":"<one short sentence with the exact numbers from DATA that settle it>"}]}
- right: DATA clearly shows the prediction came true. wrong: DATA clearly shows it did not.
- pending: the outcome is not settled by DATA yet (season predictions before the regular season is over or before the title game is final).
- void: the prediction can't be checked with this kind of DATA at all (for example a player who isn't on any roster and has no score here).
- Use only DATA. Never guess a number. "Bust" means clearly below what a starter at that position normally scores (under about 8 points for RB/WR/TE, under about 12 for QB); "boom" means clearly above (over about 20, or 25 for QB).
- A margin prediction ("by 30") is right only if the margin was at least that big.
- Keep each proof factual and short, no jokes, no emoji.`;

// Everything needed to settle predictions about week w.
async function weekFacts(lid, w) {
  const [sb, st, espn] = await Promise.all([getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&scoring_period=" + w), getJ(FF + "FetchLeagueStandings?sport=NFL&league_id=" + lid), getJ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=" + w)]);
  if (!sb || !(sb.games || []).length || !(sb.games || []).every(g => g.isFinalScore)) return null;
  const L = ["FANTASY WEEK " + w + " (all games final)."];
  const po = (sb.games || []).some(g => g.isPlayoffs || g.isChampionshipGame || g.isConsolation), champ = (sb.games || []).find(g => g.isChampionshipGame);
  L.push(po ? "THE REGULAR SEASON IS OVER: week " + w + " is a playoff week, so the standings below are final regular-season standings." : "The regular season is still going after week " + w + ".");
  const boxes = await Promise.all((sb.games || []).map(g => getJ(FF + "FetchLeagueBoxscore?sport=NFL&league_id=" + lid + "&fantasy_game_id=" + g.id + "&scoring_period=" + w)));
  L.push("", "MATCHUPS (exact final scores):");
  (sb.games || []).forEach((g, i) => {
    const a = (g.away || {}).name, h = (g.home || {}).name, as = val((g.awayScore || {}).score) || 0, hs = val((g.homeScore || {}).score) || 0;
    L.push("- " + a + " " + n2(as) + " vs " + h + " " + n2(hs) + (as === hs ? " (tie)" : " (" + (as > hs ? a : h) + " won by " + n2(Math.abs(as - hs)) + ")") + (g.isChampionshipGame ? " [CHAMPIONSHIP]" : g.isPlayoffs ? " [playoffs]" : g.isConsolation ? " [consolation]" : ""));
    const b = boxes[i]; if (!b) return;
    for (const [k, tn] of [["away", a], ["home", h]]) {
      const st2 = [], be = [];
      (b.lineups || []).forEach(gr => (gr.slots || []).forEach(sl => { const x = sl[k]; if (!x || !x.proPlayer) return; (gr.group === "START" ? st2 : be).push(x.proPlayer.nameFull + " " + x.proPlayer.position + " " + n2(val(x.viewingActualPoints) || 0)); }));
      L.push("  " + tn + " starters: " + st2.join(", ") + (be.length ? ". Bench: " + be.join(", ") : ""));
    }
  });
  if (champ && champ.isFinalScore) { const as = val((champ.awayScore || {}).score) || 0, hs = val((champ.homeScore || {}).score) || 0; L.push("", "LEAGUE CHAMPION: " + (as > hs ? champ.away : champ.home).name + "."); }
  const teams = []; ((st && st.divisions) || []).forEach(dv => (dv.teams || []).forEach(t => teams.push({ name: t.name, w: (t.recordOverall || {}).wins || 0, l: (t.recordOverall || {}).losses || 0, pf: val(t.pointsFor) || 0 })));
  if (teams.length) { L.push("", "STANDINGS NOW (wins-losses, points for):"); teams.sort((a, b) => b.w - a.w || b.pf - a.pf).forEach((t, i) => L.push((i + 1) + ". " + t.name + " " + t.w + "-" + t.l + ", " + n2(t.pf))); }
  const ev = (espn && espn.events) || [];
  if (ev.length) { L.push("", "NFL WEEK " + w + " RESULTS:"); ev.forEach(e => { const c = ((e.competitions || [])[0] || {}).competitors || []; if (c.length === 2 && (((e.competitions[0] || {}).status || {}).type || {}).state === "post") L.push("- " + c.map(x => (x.team || {}).displayName + " " + x.score).join(", ")); }); }
  return L.join("\n");
}

async function notifyLeague(env, p, lid, data) {
  for (const id of await subscriberIds(env)) {
    const rec = await env.SNAP.get("sub:" + id, "json");
    if (!rec || !rec.sub || !(rec.leagues || []).some(L => L.p === p && L.id === lid)) continue;
    try { await sendPushData(env, rec.sub, rec.origin, data, 6 * 3600); } catch (e) {}
  }
}

// Find new predictions in one league's chat.
async function scanLeague(env, p, lid, ws) {
  const k = keyOf(p, lid), S = (await hotGet(env, k)) || { list: [], cur: "" };
  const r = await room(env, p, lid).fetch("https://chat/list").then(x => x.json()).catch(() => null);
  const msgs = ((r && r.list) || []).filter(m => m.k > (S.cur || "") && (S.cur || Date.now() - m.at < 3 * 86400000));
  if (!msgs.length) return 0;
  S.cur = msgs[msgs.length - 1].k;
  const cands = msgs.map(m => Object.assign({ m }, speaker(m) || {})).filter(x => x.by && x.text && x.text.length >= 8 && x.text.length <= 500 && HINT.test(x.text)).slice(-30);
  let added = 0;
  if (cands.length) {
    const user = "TODAY: " + when(Date.now()) + " Eastern.\nCURRENT FANTASY WEEK: " + ws.W + " (" + (ws.allFinal ? "all games final, so 'this week' now means week " + (ws.W + 1) : ws.started ? "games in progress" : "not started yet") + ").\nTEAMS: " + ws.teams.join("; ") + "\n\nMESSAGES:\n" +
      cands.map((c, i) => i + ". [" + when(c.m.at) + "] " + c.by + ": " + c.text.replace(/\s+/g, " ")).join("\n");
    const j = parseJSON(await aiComplete(env, EXTRACT, user, 900, 0.1));
    for (const c of ((j && j.claims) || [])) {
      const x = cands[Number(c.i)]; if (!x || !c.claim) continue;
      if (S.list.some(y => y.mk === x.m.k)) continue;
      const week = Number(c.week) || null, season = !!c.season;
      if (!season && !(week >= 1 && week <= 18)) continue;
      S.list.unshift({ id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), mk: x.m.k, by: x.by, quote: x.text.slice(0, 300), claim: String(c.claim).slice(0, 200), week, season, at: x.m.at, status: "pending" });
      added++;
    }
    S.list = S.list.slice(0, KEEP);
  }
  await hotPut(env, k, S);
  return added;
}

// Judge predictions whose week is final.
async function settleLeague(env, p, lid, ws) {
  const k = keyOf(p, lid), S = await hotGet(env, k);
  if (!S || !S.list) return 0;
  const lastFinal = ws.allFinal ? ws.W : ws.W - 1;
  if (lastFinal < 1) return 0;
  const due = S.list.filter(x => x.status === "pending" && (x.season ? (x.checked || 0) < lastFinal : x.week <= lastFinal && !x.checked));
  if (!due.length) return 0;
  const byWeek = {}; due.forEach(x => { const w = x.season ? lastFinal : x.week; (byWeek[w] = byWeek[w] || []).push(x); });
  const done = [];
  for (const w of Object.keys(byWeek).map(Number).sort((a, b) => a - b).slice(-3)) {
    const facts = await weekFacts(lid, w); if (!facts) continue;
    const list = byWeek[w].slice(0, 25);
    const user = "DATA:\n" + facts + "\n\nPREDICTIONS TO CHECK:\n" + list.map(x => "- id " + x.id + ": " + x.claim + (x.season ? " [season prediction]" : " [week " + x.week + "]") + " (said by " + x.by + ": \"" + x.quote.replace(/\s+/g, " ").slice(0, 200) + "\")").join("\n");
    const j = parseJSON(await aiComplete(env, JUDGE, user, 1200, 0.1));
    if (!j) continue;
    for (const v of (j.verdicts || [])) {
      const x = list.find(y => y.id === String(v.id)); if (!x) continue;
      x.checked = w;
      if (v.verdict === "right" || v.verdict === "wrong") { x.status = v.verdict; x.proof = String(v.proof || "").slice(0, 240); x.settled = Date.now(); done.push(x); }
      else if (v.verdict === "void") x.status = "void";
      else if (!x.season) x.status = "void"; // a week's prediction that the final week can't settle never will be
    }
  }
  await hotPut(env, k, S);
  if (!done.length) return 0;
  for (const x of done) {
    const text = "🧾 RECEIPT: " + x.by + " said this " + day(x.at) + ":\n“" + x.quote + "”\n" + (x.status === "right" ? "✅ CALLED IT. " : "❌ WRONG. ") + (x.proof || "");
    await room(env, p, lid).fetch("https://chat/add", { method: "POST", body: JSON.stringify({ id: "rc-" + x.id, at: Date.now(), name: "Receipts", av: "", text, bot: true, sys: false, img: "" }) }).catch(() => {});
  }
  const first = done[0];
  await notifyLeague(env, p, lid, done.length === 1
    ? { show: 1, tag: "rcpt:" + lid, title: "🧾 Receipt: " + first.by + (first.status === "right" ? " called it" : " was wrong"), body: "“" + first.quote.slice(0, 90) + "” " + (first.proof || ""), url: "/?receipts=" + p + ":" + lid }
    : { show: 1, tag: "rcpt:" + lid, title: "🧾 " + done.length + " new receipts", body: done.slice(0, 3).map(x => x.by + (x.status === "right" ? " called it" : " was wrong")).join(" · "), url: "/?receipts=" + p + ":" + lid });
  return done.length;
}

export async function receiptsRun(env) {
  if (!env.SNAP || !env.CHAT) return { leagues: 0 };
  // Which leagues have chat: listed from KV at most every 6 hours (KV lists are limited on the free plan).
  let idx = await hotGet(env, "rcpt:leagues");
  if (!idx || Date.now() - idx.at > 6 * 3600000) { const keys = await env.SNAP.list({ prefix: "gm:flea:" }).catch(() => null); if (keys) { idx = { at: Date.now(), names: (keys.keys || []).map(x => x.name) }; await hotPut(env, "rcpt:leagues", idx); } }
  const res = [];
  for (const name of ((idx && idx.names) || []).slice(0, 20)) {
    const lid = name.split(":")[2]; if (!/^[\w-]{1,40}$/.test(lid || "")) continue;
    const c = await env.SNAP.get(name, "json").catch(() => null); if (!c || !c.bot) continue;
    const ws = await weekState(lid); if (!ws || !ws.W) continue;
    const added = await scanLeague(env, "flea", lid, ws).catch(e => "err " + e.message);
    const settled = await settleLeague(env, "flea", lid, ws).catch(e => "err " + e.message);
    res.push({ lid, added, settled });
  }
  return { leagues: res.length, res };
}

export async function receiptsRoute(request, env, url) {
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad request" }, 400);
  const k = keyOf(p, lid);
  if (request.method === "GET") {
    const S = (await hotGet(env, k)) || { list: [] };
    const c = await env.SNAP.get("gm:" + p + ":" + lid, "json").catch(() => null);
    return out({ chat: !!(c && c.bot), list: (S.list || []).filter(x => x.status !== "void").map(({ mk, ...x }) => x) });
  }
  if (request.method !== "POST") return out({ error: "GET or POST" }, 405);
  const b = await request.json().catch(() => ({}));
  if (b.action === "strike") { // the commissioner can strike a misread from the record
    const comm = await env.SNAP.get("comm:" + p + ":" + lid, "json");
    if (!comm || !comm.owner || comm.owner.dev !== String(b.dev || "")) return out({ error: "Only your league’s Snap Count commissioner can strike a receipt." }, 403);
    const S = (await hotGet(env, k)) || { list: [] }, x = (S.list || []).find(y => y.id === String(b.id || ""));
    if (!x) return out({ error: "That receipt is gone." }, 404);
    x.status = "void"; await hotPut(env, k, S); return out({ ok: true });
  }
  return out({ error: "Unknown action" }, 400);
}

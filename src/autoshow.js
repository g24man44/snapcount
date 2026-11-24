// The weekly league show makes itself: after Monday night's game, each Fleaflicker league's episode for the
// week that just ended is written and recorded on the server, a few lines at a time, and ready by early Tuesday.
import { showRoute } from "./show.js";
import { hotGet, hotPut, eachSubscriber } from "./alerts.js";

const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const FF = "https://www.fleaflicker.com/api/";
const val = x => x == null ? null : typeof x === "object" ? Number(x.value ?? x.formatted ?? 0) : Number(x);
const getJ = (u) => fetch(u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
const DEV = "5a0c0c0a5e5e5e5e5a0c0c0a5e5e5e5e"; // the server's own "device" for show requests
const LINES_PER_RUN = 6;

function etParts(d = new Date()) {
  return Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", hour12: false }).formatToParts(d).map(p => [p.type, p.value]));
}

// Which week to cover: the current Fleaflicker week if all its games are final (or the NFL week is over), else the week before.
async function showWeek(lid) {
  const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid);
  if (!sb) return null;
  const W = Number((sb.schedulePeriod || {}).ordinal || (sb.schedulePeriod || {}).value || 0);
  if (!W) return null;
  const allFinal = (sb.games || []).length && (sb.games || []).every(g => g.isFinalScore);
  if (allFinal) return W;
  const espn = await getJ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=" + W);
  const ev = (espn && espn.events) || [];
  if (ev.length && ev.every(e => (((e.competitions || [])[0] || {}).status || e.status || {}).type?.state === "post")) return W;
  return W > 1 ? W - 1 : null;
}

// The same facts the app builds on the phone (exact scores, top scorers, bench blunders, standings).
async function fleaFacts(lid, name, w) {
  const [sb, st] = await Promise.all([getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&scoring_period=" + w), getJ(FF + "FetchLeagueStandings?sport=NFL&league_id=" + lid)]);
  if (!sb || !(sb.games || []).length) return null;
  const teams = {};
  ((st && st.divisions) || []).forEach(dv => (dv.teams || []).forEach(t => { teams[String(t.id)] = { name: t.name, w: (t.recordOverall || {}).wins || 0, l: (t.recordOverall || {}).losses || 0, pf: val(t.pointsFor) || 0 }; }));
  const T = id => teams[id] || { name: "Team " + id, w: 0, l: 0, pf: 0 };
  const games = await Promise.all((sb.games || []).map(async g => {
    const b = await getJ(FF + "FetchLeagueBoxscore?sport=NFL&league_id=" + lid + "&fantasy_game_id=" + g.id + "&scoring_period=" + w);
    if (!b) return null;
    const side = (k, tid, tot) => { const t = (tot || {}).total || {}, start = [], bench = [];
      (b.lineups || []).forEach(gr => (gr.slots || []).forEach(sl => { const x = sl[k]; if (!x || !x.proPlayer) return; const it = { name: x.proPlayer.nameFull, pos: x.proPlayer.position, pts: val(x.viewingActualPoints) || 0 }; (gr.group === "START" ? start : bench).push(it); }));
      return { tid, act: val(t.value) || 0, opt: val(t.optimum) || val(t.value) || 0, start, bench }; };
    return [side("away", String((g.away || {}).id), b.pointsAway), side("home", String((g.home || {}).id), b.pointsHome)];
  }));
  const ok = games.filter(Boolean); if (!ok.length) return null;
  const blunder = s => { let best = null; s.start.forEach(a => s.bench.forEach(x => { if (x.pos === a.pos && x.pts - a.pts > 0 && (!best || x.pts - a.pts > best.d)) best = { start: a, bench: x, d: x.pts - a.pts }; })); return best; };
  const f = ok.map(([x, y]) => { const win = x.act >= y.act ? x : y, lose = win === x ? y : x;
    const top = s => s.start.slice().sort((a, b) => b.pts - a.pts)[0], dud = s => s.start.filter(p => !["K", "D/ST", "DEF"].includes(p.pos)).sort((a, b) => a.pts - b.pts)[0];
    return { win, lose, margin: win.act - lose.act, tie: win.act === lose.act, couldWin: lose.opt != null && lose.opt > win.act, wTop: top(win), lTop: top(lose), lDud: dud(lose), bl: blunder(lose), blW: blunder(win) }; });
  const n = x => String(Math.round((Number(x) || 0) * 100) / 100), nm = s => T(s.tid).name;
  const lines = ["LEAGUE: " + name + ". This episode covers WEEK " + w + " (every game final). " + Object.keys(teams).length + " teams.", "", "EVERY GAME, WEEK " + w + " (winner first, exact final scores):"];
  f.slice().sort((a, b) => a.margin - b.margin).forEach(g => {
    lines.push("- " + nm(g.win) + " " + n(g.win.act) + " def. " + nm(g.lose) + " " + n(g.lose.act) + " (won by " + n(g.margin) + ")." +
      (g.wTop ? " " + nm(g.win) + " top scorer: " + g.wTop.name + " " + n(g.wTop.pts) + "." : "") + (g.lTop ? " " + nm(g.lose) + " top scorer: " + g.lTop.name + " " + n(g.lTop.pts) + "." : "") +
      (g.lDud ? " " + nm(g.lose) + " worst starter: " + g.lDud.name + " " + n(g.lDud.pts) + "." : "") +
      (g.lose.opt != null ? " " + nm(g.lose) + " left " + n(Math.max(0, g.lose.opt - g.lose.act)) + " points on the bench" + (g.couldWin ? " and WOULD HAVE WON with its best lineup (" + n(g.lose.opt) + ")." : ".") : "") +
      (g.bl ? " " + nm(g.lose) + " started " + g.bl.start.name + " (" + n(g.bl.start.pts) + ") over " + g.bl.bench.name + " (" + n(g.bl.bench.pts) + ") on the bench." : ""));
  });
  const all = f.flatMap(g => [g.win, g.lose]), hi = all.slice().sort((a, b) => b.act - a.act)[0], lo = all.slice().sort((a, b) => a.act - b.act)[0];
  const close = f.slice().sort((a, b) => a.margin - b.margin)[0], blow = f.slice().sort((a, b) => b.margin - a.margin)[0];
  const bls = f.flatMap(g => [g.bl && { t: nm(g.lose), b: g.bl, lost: g.couldWin }, g.blW && { t: nm(g.win), b: g.blW, lost: false }]).filter(Boolean).sort((a, b) => (b.lost - a.lost) || (b.b.d - a.b.d));
  lines.push("", "HEADLINES (already worked out, use exactly):",
    "- Closest game: " + nm(close.win) + " " + n(close.win.act) + " to " + nm(close.lose) + " " + n(close.lose.act) + ", decided by " + n(close.margin) + ".",
    "- Biggest blowout: " + nm(blow.win) + " " + n(blow.win.act) + " to " + nm(blow.lose) + " " + n(blow.lose.act) + ", by " + n(blow.margin) + ".",
    "- Highest score of the week: " + nm(hi) + " with " + n(hi.act) + ".", "- Lowest score of the week: " + nm(lo) + " with " + n(lo.act) + ".");
  if (bls[0]) lines.push("- Blunder of the week: " + bls[0].t + " started " + bls[0].b.start.name + " (" + n(bls[0].b.start.pts) + ") while " + bls[0].b.bench.name + " scored " + n(bls[0].b.bench.pts) + " on the bench" + (bls[0].lost ? ", and it cost them the game." : "."));

  // One lineup change that would have flipped a loss: a bench player at the same position who outscored a starter by more than the margin.
  const swaps = f.filter(g => !(g.margin === 0)).map(g => { let best = null; g.lose.start.forEach(a => g.lose.bench.forEach(b => { const gain = b.pts - a.pts; if (b.pos === a.pos && gain > g.margin && (!best || gain > best.gain)) best = {a, b, gain}; })); return best ? {g, ...best} : g.couldWin ? {g, opt: true} : null; }).filter(Boolean);
  if (swaps.length) { lines.push("", "LOSSES THAT ONE LINEUP CHANGE WOULD HAVE WON (use exactly):"); swaps.forEach(x => lines.push("- " + nm(x.g.lose) + " lost by " + n(x.g.margin) + (x.a ? ". Starting " + x.b.name + " (" + n(x.b.pts) + ") instead of " + x.a.name + " (" + n(x.a.pts) + ") would have won it." : ". Their best possible lineup (" + n(x.g.lose.opt) + ") would have won it."))); }

  const bottom = Object.entries(teams).map(([id, t]) => Object.assign({ id }, t)).sort((a, b) => a.w - b.w || a.pf - b.pf).slice(0, 3);
  lines.push("", "ROAST CORNER (the bottom of the standings; roast them playfully about their fantasy season, never mean):");
  bottom.forEach(t => { const g = f.find(x => x.win.tid === t.id || x.lose.tid === t.id), won = g && g.win.tid === t.id && g.margin > 0; lines.push("- " + t.name + " is " + t.w + "-" + t.l + " with " + n(t.pf) + " points for" + (g ? ", and " + (won ? "actually WON this week, " + n(g.win.act) + " to " + n(g.lose.act) : "lost again this week, " + n(g.lose.act) + " to " + n(g.win.act)) : "") + "."); });
  lines.push("", "STANDINGS NOW (wins-losses, points for):");
  Object.values(teams).sort((a, b) => b.w - a.w || b.pf - a.pf).forEach((t, i) => lines.push((i + 1) + ". " + t.name + " " + t.w + "-" + t.l + ", " + n(t.pf) + " points for"));
  return lines.join("\n").replace(/\p{Extended_Pictographic}️?/gu, "").replace(/ +/g, " ");
}

const call = async (env, path, q, body) => {
  const url = new URL("https://snapcount.internal" + path + "?" + q);
  const req = new Request(url, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(Object.assign({ dev: DEV }, body)) } : { method: "GET" });
  return (await showRoute(req, url, env)).json();
};

// Runs every 5 minutes from Tuesday 12:30 AM to Wednesday night (Eastern), so a slow night or a busy AI still catches up.
export async function autoShows(env, force) {
  const et = etParts(), h = Number(et.hour) % 24;
  if (!force && !((et.weekday === "Tue" && h >= 0) || et.weekday === "Wed")) return { skipped: true };
  const idx = (await env.SNAP.get("fleaLeagues", "json")) || {};
  const out = {};
  for (const [lid, name] of Object.entries(idx)) {
    const w = await showWeek(lid); if (!w) { out[lid] = "no week"; continue; }
    const tag = "autoshow:" + lid + ":" + w, st = (await hotGet(env, tag)) || {};
    if (st.done) { out[lid] = "done"; continue; }
    if (st.fails >= 8) { out[lid] = "gave up"; continue; }
    const q = "p=flea&lid=" + encodeURIComponent(lid) + "&w=" + w;
    let show = (await call(env, "/api/show", q)).show;
    if (!show) {
      const ctx = await fleaFacts(lid, name, w);
      if (!ctx) { out[lid] = "no facts"; continue; }
      const r = await call(env, "/api/show/script", q, { ctx, final: true, league: name });
      if (!r.show) { await hotPut(env, tag, { fails: (st.fails || 0) + 1, err: r.error || "script" }); out[lid] = "script failed: " + (r.error || ""); return out; }
      out[lid] = "script written"; return out; // record on the next runs
    }
    let done = show.done || 0;
    for (let k = 0; k < LINES_PER_RUN && done < show.total; k++) {
      const r = await call(env, "/api/show/line", q, { i: done });
      if (r.error) { await hotPut(env, tag, { fails: (st.fails || 0) + 1, err: r.error }); out[lid] = "line " + done + " failed: " + r.error; return out; }
      done++;
    }
    if (done >= show.total) {
      await hotPut(env, tag, { done: true, at: Date.now() });
      // Let the league know.
      await eachSubscriber(env, rec => (rec.leagues || []).some(L => L.p === "flea" && L.id === lid) ? [{ id: "show:" + lid + ":" + w, title: "🎙 Week " + w + " of The Snap Count Show is ready", body: "Dez and Sam break down every " + name + " matchup. Tap to listen." }] : []).catch(() => {});
      out[lid] = "recorded";
    } else out[lid] = "recorded " + done + "/" + show.total;
    return out; // one league per run keeps each run small
  }
  return out;
}

/* ---------- Halftime Show and Awards night: the same write-then-record steps, other episodes ---------- */
// Writes the script if needed, then records up to LINES_PER_RUN lines; tells the league when it's done.
async function produce(env, lid, name, w, tag, factsFn, ready) {
  const st = (await hotGet(env, tag)) || {};
  if (st.done) return "done";
  if (st.fails >= 8) return "gave up";
  const q = "p=flea&lid=" + encodeURIComponent(lid) + "&w=" + w;
  let show = (await call(env, "/api/show", q)).show;
  if (!show) {
    const ctx = await factsFn(); if (!ctx) return "no facts";
    const r = await call(env, "/api/show/script", q, { ctx, final: true, league: name });
    if (!r.show) { await hotPut(env, tag, { fails: (st.fails || 0) + 1, err: r.error || "script" }); return "script failed: " + (r.error || ""); }
    return "script written";
  }
  let done = show.done || 0;
  for (let k = 0; k < LINES_PER_RUN && done < show.total; k++) {
    const r = await call(env, "/api/show/line", q, { i: done });
    if (r.error) { await hotPut(env, tag, { fails: (st.fails || 0) + 1, err: r.error }); return "line " + done + " failed: " + r.error; }
    done++;
  }
  if (done < show.total) return "recorded " + done + "/" + show.total;
  await hotPut(env, tag, { done: true, at: Date.now() });
  await eachSubscriber(env, rec => (rec.leagues || []).some(L => L.p === "flea" && L.id === lid) ? [ready] : []);
  return "recorded";
}
// Live facts for the halftime episode: current scores, players left, and each team's best performer so far.
export async function halftimeFacts(lid, name) {
  const [sb, st] = await Promise.all([getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid), getJ(FF + "FetchLeagueStandings?sport=NFL&league_id=" + lid)]);
  if (!sb || !(sb.games || []).length) return null;
  const w = Number((sb.schedulePeriod || {}).ordinal || 0), rec = {};
  ((st && st.divisions) || []).forEach(d => (d.teams || []).forEach(t => { rec[String(t.id)] = (t.recordOverall || {}).wins + "-" + (t.recordOverall || {}).losses; }));
  const n = x => String(Math.round((Number(x) || 0) * 100) / 100);
  const lines = ["LEAGUE: " + name + ". HALFTIME of WEEK " + w + ": the early NFL games are over, the late games are still to come. Nothing is final.", "", "EVERY MATCHUP RIGHT NOW (leader first, current scores):"];
  const rows = await Promise.all((sb.games || []).map(async g => {
    const sa = (g.awayScore || {}), sh = (g.homeScore || {}), a = val((sa.score || {})), h = val((sh.score || {}));
    const left = s => (s.yetToPlay || 0) + (s.inPlay || 0);
    let tops = {};
    const b = await getJ(FF + "FetchLeagueBoxscore?sport=NFL&league_id=" + lid + "&fantasy_game_id=" + g.id);
    if (b) (b.lineups || []).forEach(gr => (gr.slots || []).forEach(sl => ["away", "home"].forEach(k => { const x = sl[k]; if (!x || !x.proPlayer) return; const pts = val(x.viewingActualPoints) || 0; if (!tops[k] || pts > tops[k].pts) tops[k] = { name: x.proPlayer.nameFull, pts }; })));
    const L = a >= h ? ["away", g.away, a, sa] : ["home", g.home, h, sh], T = a >= h ? ["home", g.home, h, sh] : ["away", g.away, a, sa];
    return { margin: Math.abs(a - h), text: "- " + L[1].name + " (" + (rec[L[1].id] || "") + ") leads " + T[1].name + " (" + (rec[T[1].id] || "") + ") " + n(L[2]) + " to " + n(T[2]) + ", by " + n(Math.abs(a - h)) + ". " + L[1].name + " has " + left(L[3]) + " players left to play; " + T[1].name + " has " + left(T[3]) + "." + (tops[L[0]] ? " " + L[1].name + " best so far: " + tops[L[0]].name + " " + n(tops[L[0]].pts) + "." : "") + (tops[T[0]] ? " " + T[1].name + " best so far: " + tops[T[0]].name + " " + n(tops[T[0]].pts) + "." : "") };
  }));
  rows.sort((x, y) => x.margin - y.margin).forEach(r => lines.push(r.text));
  return { w, ctx: lines.join("\n").replace(/\p{Extended_Pictographic}️?/gu, "") };
}
// Sunday 4:00 to 4:50 PM Eastern, once the 1 PM games are final.
export async function halftimeShows(env, force) {
  const et = etParts(), h = Number(et.hour) % 24;
  if (!force && !(et.weekday === "Sun" && h === 16)) return { skipped: true };
  const espn = await getJ("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard");
  const early = ((espn && espn.events) || []).filter(e => { const d = new Date(e.date); const hh = Number(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", hour12: false }).format(d)); return hh === 13 && etParts(d).weekday === "Sun"; });
  if (!force && (early.length < 3 || !early.every(e => (((e.competitions || [])[0] || {}).status || {}).type?.state === "post"))) return { waiting: true };
  const idx = (await env.SNAP.get("fleaLeagues", "json")) || {}, out = {};
  for (const [lid, name] of Object.entries(idx)) {
    const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid);
    const w = Number(((sb || {}).schedulePeriod || {}).ordinal || 0); if (!w) continue;
    const tag = "halfshow:" + lid + ":" + w;
    if (((await hotGet(env, tag)) || {}).done) { out[lid] = "done"; continue; }
    out[lid] = await produce(env, lid, name, w + "h", tag, async () => (await halftimeFacts(lid, name) || {}).ctx, { id: "half:" + lid + ":" + w, title: "🎙 The Halftime Show is ready", body: "Who’s winning, who’s sweating and who’s cooked going into the late games." });
    return out; // one league per run
  }
  return out;
}
// Awards night: once the championship game is final, hand out the league's trophies.
export async function awardsFacts(env, lid, name, W, season) {
  const S = season ? "&season=" + season : "";
  const st = await getJ(FF + "FetchLeagueStandings?sport=NFL&league_id=" + lid + S);
  const teams = {}; ((st && st.divisions) || []).forEach(d => (d.teams || []).forEach(t => { teams[String(t.id)] = { name: t.name, w: (t.recordOverall || {}).wins || 0, l: (t.recordOverall || {}).losses || 0, pf: val(t.pointsFor) || 0, pa: val(t.pointsAgainst) || 0 }; }));
  if (!Object.keys(teams).length) return null;
  const n = x => String(Math.round((Number(x) || 0) * 100) / 100), all = [];
  let champ = null, third = null;
  for (let w = 1; w <= W; w++) {
    const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&scoring_period=" + w + S);
    ((sb && sb.games) || []).forEach(g => {
      const a = val((g.awayScore || {}).score), h = val((g.homeScore || {}).score); if (!(a || h)) return;
      const x = { w, A: g.away.name, H: g.home.name, a, h, po: !!g.isPlayoffs, cons: !!g.isConsolation };
      if (g.isChampionshipGame) champ = x; if (g.isThirdPlaceGame) third = x;
      if (!g.isConsolation) all.push(x);
    });
  }
  if (!champ) return null;
  const win = x => x.a >= x.h ? [x.A, x.a, x.H, x.h] : [x.H, x.h, x.A, x.a];
  const T = Object.values(teams), by = (f, d) => T.slice().sort((p, q) => d * (f(q) - f(p)))[0];
  const scores = all.flatMap(x => [{ t: x.A, s: x.a, w: x.w }, { t: x.H, s: x.h, w: x.w }]);
  const hi = scores.slice().sort((p, q) => q.s - p.s)[0], lo = scores.slice().sort((p, q) => p.s - q.s)[0];
  const close = all.slice().sort((p, q) => Math.abs(p.a - p.h) - Math.abs(q.a - q.h))[0], blow = all.slice().sort((p, q) => Math.abs(q.a - q.h) - Math.abs(p.a - p.h))[0];
  const c = win(champ), lines = ["LEAGUE: " + name + ". AWARDS NIGHT for the season that just ended.", "",
    "CHAMPION: " + c[0] + " beat " + c[2] + " " + n(c[1]) + " to " + n(c[3]) + " in the championship game (week " + champ.w + ")."];
  if (third) { const t3 = win(third); lines.push("THIRD PLACE: " + t3[0] + " beat " + t3[2] + " " + n(t3[1]) + " to " + n(t3[3]) + "."); }
  const best = by(t => t.w * 1000 + t.pf, 1), most = by(t => t.pf, 1), lemon = by(t => -(t.w * 1000) - t.pf, 1), unlucky = by(t => t.pa, 1);
  lines.push("", "AWARDS (use exactly):",
    "- Best regular-season record: " + best.name + " at " + best.w + "-" + best.l + ".",
    "- Most points scored all season: " + most.name + " with " + n(most.pf) + ".",
    "- Highest single week: " + hi.t + " with " + n(hi.s) + " in week " + hi.w + ".",
    "- Lowest single week: " + lo.t + " with " + n(lo.s) + " in week " + lo.w + ".",
    "- Closest game of the season: " + win(close)[0] + " over " + win(close)[2] + ", " + n(win(close)[1]) + " to " + n(win(close)[3]) + " in week " + close.w + ".",
    "- Biggest blowout: " + win(blow)[0] + " over " + win(blow)[2] + ", " + n(win(blow)[1]) + " to " + n(win(blow)[3]) + " in week " + blow.w + ".",
    "- Toughest luck (most points scored against them): " + unlucky.name + ", " + n(unlucky.pa) + " against.");
  const bets = ((await hotGet(env, "bets:flea:" + lid)) || []).filter(b => b.status === "settled" && b.winner !== "push");
  if (bets.length) { const r = {}; bets.forEach(b => { const W2 = b.winner === b.from.id ? b.from.name : b.to.name; r[W2] = (r[W2] || 0) + 1; }); const top = Object.entries(r).sort((p, q) => q[1] - p[1])[0]; lines.push("- Side bet champion: " + top[0] + " with " + top[1] + " bets won."); }
  lines.push("- The Lemon (last place, roast them kindly): " + lemon.name + " at " + lemon.w + "-" + lemon.l + " with " + n(lemon.pf) + " points.");
  return { ctx: lines.join("\n").replace(/\p{Extended_Pictographic}️?/gu, ""), awards: { champ: c[0], best: best.name, most: most.name, hi: hi.t, lemon: lemon.name } };
}
export async function awardsShows(env, force) {
  const idx = (await env.SNAP.get("fleaLeagues", "json")) || {}, out = {};
  for (const [lid, name] of Object.entries(idx)) {
    const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid);
    const W = Number(((sb || {}).schedulePeriod || {}).ordinal || 0), gs = (sb && sb.games) || [];
    if (!force && !(gs.some(g => g.isChampionshipGame) && gs.every(g => g.isFinalScore))) { out[lid] = "season not over"; continue; }
    const tag = "awards:" + lid + ":" + W;
    if (((await hotGet(env, tag)) || {}).done) { out[lid] = "done"; continue; }
    out[lid] = await produce(env, lid, name, W + "a", tag, async () => { const f = await awardsFacts(env, lid, name, W); if (f) await hotPut(env, "awardsdata:" + lid, f.awards); return f && f.ctx; }, { id: "awards:" + lid + ":" + W, title: "🏆 Awards Night is here", body: "The Snap Count Show hands out " + name + "’s trophies. Grab your trophy card." });
    return out;
  }
  return out;
}

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
    return { win, lose, margin: win.act - lose.act, couldWin: lose.opt != null && lose.opt > win.act, wTop: top(win), lTop: top(lose), lDud: dud(lose), bl: blunder(lose), blW: blunder(win) }; });
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

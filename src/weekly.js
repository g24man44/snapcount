// Snap Count weekly posts: the Friday matchup preview (push + connected apps) and Tuesday power rankings (connected apps).
import { sendHook } from "./more.js";

const UA = { "User-Agent": "SnapCount/1.0 (fantasy dashboard)", "Accept": "application/json" };
const FF = "https://www.fleaflicker.com/api/";
const norm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]/g, "");
const getJ = u => fetch(u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
const f1 = n => (Math.round((n || 0) * 10) / 10).toFixed(1);
const etParts = () => Object.fromEntries(new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", weekday: "short", hour: "2-digit", minute: "2-digit", hour12: false, year: "numeric", month: "2-digit", day: "2-digit" }).formatToParts(new Date()).map(x => [x.type, x.value]));
const OUTISH = new Set(["out", "ir", "doubtful", "sus", "suspended", "pup", "na", "cov"]);
const DEFAULT_PROJ = { K: 8, "D/ST": 7, DEF: 7, DST: 7 };

function normCdf(z) { const t = 1 / (1 + 0.3275911 * Math.abs(z) / Math.SQRT2), y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z / 2); return z >= 0 ? (1 + y) / 2 : (1 - y) / 2; }
export function winProb(a, b) { const sd = Math.max(12, 0.22 * Math.sqrt(a * a + b * b)); return Math.min(0.99, Math.max(0.01, normCdf((a - b) / sd))); }

// This week's projections for every skill player from the alert snapshots: by Sleeper id and by name|pos.
async function slate(env) {
  const st = await getJ("https://api.sleeper.app/v1/state/nfl");
  if (!st || st.season_type === "off" || st.season_type === "pre") return null;
  const week = st.display_week || st.week, season = String(st.league_season || st.season), byId = {}, byName = {};
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const sn = await env.SNAP.get("snap:" + pos, "json");
    if (!sn || sn.week !== week || String(sn.season) !== season) continue;
    for (const id in sn.p) { const v = sn.p[id], x = { id, name: v[0], team: v[1], status: v[2] || "", proj: Number(v[4]) || 0, pos }; byId[id] = x; byName[norm(v[0]) + "|" + pos] = x; }
  }
  return Object.keys(byId).length ? { week, season, byId, byName } : null;
}

// Both sides of one league's matchup this week: [{ name, starters: [{ name, pos, proj, status }] }] with mine first.
async function matchupSides(lu, S) {
  if (lu.p === "flea") {
    const board = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lu.id + "&scoring_period=" + S.week);
    const g = ((board || {}).games || []).find(x => String((x.away || {}).id) === lu.t || String((x.home || {}).id) === lu.t);
    if (!g) return null;
    const meT = String(g.away.id) === lu.t ? g.away : g.home, opT = meT === g.away ? g.home : g.away;
    const side = async t => {
      const r = await getJ(FF + "FetchRoster?sport=NFL&league_id=" + lu.id + "&team_id=" + t.id + "&scoring_period=" + S.week);
      const start = (((r || {}).groups || []).find(x => x.group === "START") || {}).slots || [];
      return { name: t.name, starters: start.map(s => { const lp = s.leaguePlayer || {}, pp = lp.proPlayer; if (!pp) return null; const rg = (lp.requestedGames || [])[0] || {}, fp = rg.pointsProjected && rg.pointsProjected.value; const sx = S.byName[norm(pp.nameFull) + "|" + pp.position];
        return { name: pp.nameFull, pos: pp.position, proj: fp != null ? Number(fp) : sx ? sx.proj : (DEFAULT_PROJ[pp.position] || 0), status: (pp.injury && (pp.injury.typeAbbreviaition || pp.injury.typeFull)) || (sx ? sx.status : "") }; }).filter(Boolean) };
    };
    const [a, b] = await Promise.all([side(meT), side(opT)]);
    return [a, b];
  }
  if (lu.p === "sleeper") {
    const [ms, users, rosters] = await Promise.all(["matchups/" + S.week, "users", "rosters"].map(x => getJ("https://api.sleeper.app/v1/league/" + lu.id + "/" + x)));
    const mine = (ms || []).find(m => String(m.roster_id) === lu.t); if (!mine || !mine.matchup_id) return null;
    const opp = (ms || []).find(m => m.matchup_id === mine.matchup_id && m !== mine); if (!opp) return null;
    const uById = {}; (users || []).forEach(u => uById[u.user_id] = u);
    const tname = rid => { const ro = (rosters || []).find(r => r.roster_id === rid) || {}, u = uById[ro.owner_id] || {}; return (u.metadata && u.metadata.team_name) || u.display_name || "Team " + rid; };
    const side = m => ({ name: tname(m.roster_id), starters: (m.starters || []).filter(x => x && x !== "0").map(id => { const x = S.byId[id]; return x ? { name: x.name, pos: x.pos, proj: x.proj, status: x.status } : { name: /^[A-Z]{2,3}$/.test(id) ? id + " D/ST" : "Kicker", pos: /^[A-Z]{2,3}$/.test(id) ? "DEF" : "K", proj: /^[A-Z]{2,3}$/.test(id) ? 7 : 8, status: "" }; }) });
    return [side(mine), side(opp)];
  }
  return null;
}

export function previewText(league, me, opp) {
  const A = me.starters.reduce((s, x) => s + x.proj, 0), B = opp.starters.reduce((s, x) => s + x.proj, 0), wp = winProb(A, B);
  const top = side => side.starters.slice().sort((a, b) => b.proj - a.proj).slice(0, 2);
  const iffy = side => side.starters.filter(x => /^(q|questionable|d|doubtful|o|out|ir)$/i.test(x.status) || OUTISH.has(norm(x.status)));
  const lines = [];
  lines.push("Projected " + f1(A) + " – " + f1(B) + " (" + Math.round(wp * 100) + "% to win).");
  lines.push("Their threats: " + top(opp).map(x => x.name + " " + f1(x.proj)).join(", ") + ".");
  lines.push("Your best: " + top(me).map(x => x.name + " " + f1(x.proj)).join(", ") + ".");
  const mi = iffy(me), oi = iffy(opp);
  if (mi.length) lines.push("Watch your " + mi.map(x => x.name + " (" + x.status + ")").join(", ") + ": have a backup ready.");
  if (oi.length) lines.push("Their " + oi.map(x => x.name + " (" + x.status + ")").join(", ") + (oi.length > 1 ? " are" : " is") + " banged up.");
  const zero = me.starters.filter(x => x.proj <= 0.5 && x.pos !== "K" && x.pos !== "D/ST" && x.pos !== "DEF");
  if (zero.length) lines.push("Fix your lineup: " + zero.map(x => x.name).join(", ") + " projected for 0.");
  lines.push(wp >= 0.65 ? "You’re favored: play it safe." : wp <= 0.35 ? "You’re the underdog: lean on high-upside starters." : "Coin flip: every lineup call matters.");
  return { A, B, wp, text: lines.join("\n") };
}

// Friday 12:00-12:29 PM Eastern: one preview per person per league, a few people per minute.
export async function matchupPreviews(env, deliver, force) {
  const now = etParts();
  if (!force && (now.weekday !== "Fri" || Number(now.hour) !== 12 || Number(now.minute) >= 30)) return { skipped: true };
  const S = await slate(env); if (!S) return { skipped: "no projections" };
  const day = now.year + now.month + now.day, list = await env.SNAP.list({ prefix: "sub:" });
  let sent = 0, handled = 0;
  for (const k of list.keys) {
    if (handled >= 4) break;
    const id = k.name.slice(4), key = "pv:" + day + ":" + id;
    if (!force && await env.SNAP.get(key)) continue;
    if (!force) await env.SNAP.put(key, "1", { expirationTtl: 172800 });
    const rec = await env.SNAP.get(k.name, "json");
    if (!rec || (rec.prefs || {}).preview === false) continue;
    handled++;
    const items = [];
    for (const lu of (rec.lineups || []).filter(l => l.t && (l.p === "flea" || l.p === "sleeper")).slice(0, 3)) {
      try {
        const sides = await matchupSides(lu, S); if (!sides || !sides[0].starters.length || !sides[1].starters.length) continue;
        const pv = previewText(lu.name, sides[0], sides[1]);
        items.push({ id: "preview:" + lu.p + ":" + lu.id + ":" + S.week, title: lu.name + " · Week " + S.week + ": " + Math.round(pv.wp * 100) + "% vs " + sides[1].name, body: pv.text });
      } catch (e) {}
    }
    if (items.length) sent += await deliver(env, id, rec, items);
  }
  return { sent, handled, week: S.week };
}

/* ---------- power rankings ---------- */
export function powerTable(games) {
  const T = {}, wk = {};
  games.forEach(g => [[g.a, g.as, g.hs], [g.h, g.hs, g.as]].forEach(([t, pf, pa]) => {
    const x = T[t.id] = T[t.id] || { id: t.id, name: t.name, w: 0, l: 0, t: 0, pf: 0, g: 0, scores: [], aw: 0, al: 0 };
    x.g++; x.pf += pf; x.scores.push({ wk: g.wk, pf }); if (pf > pa) x.w++; else if (pf < pa) x.l++; else x.t++;
    (wk[g.wk] = wk[g.wk] || []).push({ id: t.id, pf });
  }));
  Object.values(wk).forEach(arr => arr.forEach(a => arr.forEach(b => { if (a !== b) { if (a.pf > b.pf) T[a.id].aw++; else if (a.pf < b.pf) T[a.id].al++; } })));
  const xs = Object.values(T); if (!xs.length) return [];
  xs.forEach(x => { x.ppg = x.pf / x.g; const l3 = x.scores.slice().sort((a, b) => b.wk - a.wk).slice(0, 3); x.last3 = l3.reduce((s, y) => s + y.pf, 0) / l3.length; x.ap = x.aw + x.al ? x.aw / (x.aw + x.al) : 0; x.luck = (x.w + x.t / 2) - x.ap * x.g; });
  const z = k => { const m = xs.reduce((s, x) => s + x[k], 0) / xs.length, sd = Math.sqrt(xs.reduce((s, x) => s + (x[k] - m) ** 2, 0) / xs.length) || 1; xs.forEach(x => x["z" + k] = (x[k] - m) / sd); };
  ["ppg", "last3", "ap"].forEach(z);
  xs.forEach(x => x.power = 0.45 * x.zppg + 0.3 * x.zlast3 + 0.25 * x.zap);
  return xs.sort((a, b) => b.power - a.power);
}
export function powerText(rows, prev) {
  const lucky = rows.slice().sort((a, b) => b.luck - a.luck)[0], unlucky = rows.slice().sort((a, b) => a.luck - b.luck)[0];
  return rows.map((x, i) => { const pi = prev.findIndex(y => y.id === x.id), mv = pi < 0 ? 0 : pi - i; return (i + 1) + ". " + x.name + " (" + x.w + "-" + x.l + (x.t ? "-" + x.t : "") + ", all-play " + x.aw + "-" + x.al + (mv ? ", " + (mv > 0 ? "▲" + mv : "▼" + (-mv)) : "") + ")"; }).join("\n") +
    "\n\nLuckiest: " + lucky.name + " (" + (lucky.luck >= 0 ? "+" : "") + lucky.luck.toFixed(1) + " wins). Unluckiest: " + unlucky.name + " (" + unlucky.luck.toFixed(1) + ").";
}
async function fleaSeasonGames(lid) {
  const cur = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid);
  if (!cur) return null;
  const cw = (cur.schedulePeriod || {}).ordinal || 1, weeks = [];
  for (let w = 1; w <= cw; w++) weeks.push(w);
  const boards = await Promise.all(weeks.map(w => w === cw ? cur : getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&scoring_period=" + w)));
  const games = [];
  boards.forEach((b, i) => (b && b.games || []).forEach(g => {
    if (!g.isFinalScore || g.isPlayoffs || g.isConsolation) return;
    const sc = x => Number(((x || {}).score || {}).value) || 0;
    games.push({ wk: weeks[i], a: { id: String(g.away.id), name: g.away.name }, h: { id: String(g.home.id), name: g.home.name }, as: sc(g.awayScore), hs: sc(g.homeScore) });
  }));
  return { games, last: Math.max(0, ...games.map(g => g.wk)) };
}
// Tuesday 11:30 AM-noon Eastern (after the AI recap): power rankings to each Fleaflicker league's connected apps, one league a minute.
export async function weeklyPower(env, force) {
  const now = etParts();
  if (!force && (now.weekday !== "Tue" || Number(now.hour) !== 11 || Number(now.minute) < 30)) return { skipped: true };
  const list = await env.SNAP.list({ prefix: "sub:" }), byLeague = {}; let origin = null;
  for (const k of list.keys) {
    const rec = await env.SNAP.get(k.name, "json");
    if (!rec || !(rec.hooks || []).length || (rec.prefs || {}).recap === false) continue;
    origin = origin || rec.origin;
    for (const L of rec.leagues || []) if (L.p === "flea") { const b = byLeague[L.id] = byLeague[L.id] || { name: L.name, hooks: new Set() }; rec.hooks.forEach(h => b.hooks.add(h)); }
  }
  for (const lid of Object.keys(byLeague)) {
    const s = await fleaSeasonGames(lid); if (!s || !s.last) continue;
    const key = "pw:" + lid + ":" + s.last;
    if (!force && await env.SNAP.get(key)) continue;
    await env.SNAP.put(key, "1", { expirationTtl: 60 * 60 * 24 * 30 });
    const rows = powerTable(s.games), prev = powerTable(s.games.filter(g => g.wk < s.last));
    if (!rows.length) continue;
    const item = { id: key, title: byLeague[lid].name + " · power rankings after week " + s.last, body: powerText(rows, prev) };
    for (const h of byLeague[lid].hooks) await sendHook(h, [item], origin || "https://www.fleaflicker.com").catch(() => 0);
    return { posted: lid, week: s.last }; // one league per minute keeps each run small
  }
  return { posted: null };
}

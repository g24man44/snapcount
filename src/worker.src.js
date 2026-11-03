// Snap Count — one Cloudflare Worker that serves the app and fetches live league data.
// Paste this whole file into a new Cloudflare Worker and deploy. Free plan is fine.

import { alertsRoute, runMinute, staticRoute, injuriesRoute } from "./src/alerts.js";
import { espnRoute, mflRoute, scoresRoute, calendarRoute, coachRoute, hookPostRoute } from "./src/more.js";

const HTML = __HTML__;

const FLEA_OK = new Set([
  "FetchUserLeagues", "FetchLeagueStandings", "FetchLeagueScoreboard", "FetchLeagueRosters",
  "FetchRoster", "FetchLeagueBoxscore", "FetchLeagueActivity", "FetchLeagueTransactions", "FetchPlayerListing", "FetchLeagueRules", "FetchTeamPicks", "FetchTrades", "FetchLeagueDraftBoard"
]);
const UA = { "User-Agent": "SnapCount/1.0 (fantasy dashboard)", "Accept": "application/json" };
const FANTASY_POS = new Set(["QB", "RB", "WR", "TE", "K", "DEF"]);

function json(data, status = 200, maxAge = 60) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + maxAge }
  });
}

// Fetch upstream with the edge cache, so many users don't hammer the league sites.
async function cached(ctx, key, ttl, produce) {
  const cache = caches.default;
  const req = new Request("https://snapcount.cache/" + key);
  const hit = await cache.match(req);
  if (hit) return hit;
  const res = await produce();
  if (res.status === 200) {
    const copy = new Response(res.clone().body, res);
    copy.headers.set("cache-control", "public, max-age=" + ttl);
    ctx.waitUntil(cache.put(req, copy));
  }
  return res;
}

async function upstream(url, ttl) {
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return json({ error: "The league site answered " + r.status + " for this request." }, r.status === 404 ? 404 : 502, 0);
  const body = await r.text();
  return new Response(body, { status: 200, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + ttl } });
}

// Sleeper's full player file is ~5 MB; slim it to what the app shows.
async function slimPlayers() {
  const r = await fetch("https://api.sleeper.app/v1/players/nfl", { headers: UA });
  if (!r.ok) return json({ error: "Sleeper player list unavailable (" + r.status + ")" }, 502, 0);
  const all = await r.json();
  const out = {};
  for (const id in all) {
    const p = all[id];
    const pos = p.position || (p.fantasy_positions || [])[0];
    if (!FANTASY_POS.has(pos)) continue;
    if (!p.active && !p.team && pos !== "DEF") continue;
    const name = p.full_name || [p.first_name, p.last_name].filter(Boolean).join(" ");
    out[id] = [name, pos, p.team || "", p.injury_status || null, p.injury_body_part || null, p.espn_id ? String(p.espn_id) : null];
  }
  return json(out, 200, 21600);
}

function decode(s) {
  return String(s || "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;|&apos;/g, "'").replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .trim();
}
function tag(block, name) {
  const m = block.match(new RegExp("<" + name + "[^>]*>([\\s\\S]*?)</" + name + ">"));
  return m ? decode(m[1]) : "";
}

const stripHtml = t => decode(String(t || "").replace(/<[^>]+>/g, " ")).replace(/\s+/g, " ").trim();
const nameKey = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]/g, "");

// Player news from ESPN: its fantasy news feed for the player, plus ESPN headlines that mention him.
async function playerNews(name, espnId) {
  const items = [];
  let ok = false;
  if (espnId) {
    try {
      const r = await fetch("https://site.api.espn.com/apis/fantasy/v2/games/ffl/news/players?limit=20&playerId=" + encodeURIComponent(espnId), { headers: UA });
      if (r.ok) {
        ok = true;
        const d = await r.json();
        for (const f of d.feed || []) {
          const link = (f.links && f.links.web && f.links.web.href) || (f.links && f.links.mobile && f.links.mobile.href) || "";
          items.push({ title: stripHtml(f.headline), body: stripHtml(f.story || f.description).slice(0, 700), date: f.published || f.lastModified || "", link: /^https?:/.test(link) ? link : "", source: "ESPN Fantasy" });
        }
      }
    } catch (e) {}
  }
  try {
    const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50", { headers: UA });
    if (r.ok) {
      ok = true;
      const key = nameKey(name), d = await r.json();
      for (const a of d.articles || []) {
        const hit = (a.categories || []).some(c => c.type === "athlete" && nameKey(c.description) === key) || nameKey(a.headline).includes(key);
        if (!hit) continue;
        const link = (a.links && a.links.web && a.links.web.href) || "";
        if (items.some(i => i.title === a.headline)) continue;
        items.push({ title: a.headline, body: a.description || "", date: a.published || "", link, source: "ESPN" });
      }
    }
  } catch (e) {}
  if (!ok) return json({ error: "ESPN news is unavailable right now. Try again in a minute." }, 502, 0);
  items.sort((a, b) => (Date.parse(b.date) || 0) - (Date.parse(a.date) || 0));
  return json({ items: items.filter(i => i.title || i.body).slice(0, 15) }, 200, 600);
}

// Redraft trade values from FantasyCalc (built from real trades), keyed by Sleeper player id.
async function tradeValues(ppr, teams, qbs, dyn) {
  const url = "https://api.fantasycalc.com/values/current?isDynasty=" + (dyn ? "true" : "false") + "&numQbs=" + qbs + "&numTeams=" + teams + "&ppr=" + ppr;
  const r = await fetch(url, { headers: UA });
  if (!r.ok) return json({ error: "FantasyCalc answered " + r.status }, 502, 0);
  const arr = await r.json();
  const out = {};
  for (const x of Array.isArray(arr) ? arr : []) {
    const p = x.player || {};
    const row = [Math.round(x.value || 0), x.overallRank || null, x.positionRank || null, Math.round(x.trend30Day || 0), p.name || "", p.position || "", p.maybeAge ? Math.round(p.maybeAge * 10) / 10 : null, Math.round(x.redraftValue || 0)];
    if (p.position === "PICK" && p.name) out["pick:" + p.name] = row;
    if (p.sleeperId) out[p.sleeperId] = row;
    if (p.fleaflickerId) out["f" + p.fleaflickerId] = row;
  }
  if (!Object.keys(out).length) return json({ error: "FantasyCalc returned no players" }, 502, 0);
  return json({ source: "FantasyCalc", ppr, teams, qbs, dynasty: !!dyn, values: out }, 200, 21600);
}

async function headlines() {
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/news?limit=50", { headers: UA });
  if (!r.ok) return json({ error: "ESPN headlines unavailable (" + r.status + ")" }, 502, 0);
  const d = await r.json();
  const items = (d.articles || []).map(a => ({
    title: a.headline,
    desc: a.description || "",
    link: (a.links && a.links.web && a.links.web.href) || "",
    date: a.published,
    athletes: (a.categories || []).filter(c => c.type === "athlete").map(c => c.description)
  })).filter(a => a.title && /^https?:\/\//.test(a.link));
  return json({ items }, 200, 600);
}

// Every NFL game this week: teams, score, quarter/clock or kickoff time.
async function scoreboard() {
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", { headers: UA });
  if (!r.ok) return json({ error: "NFL scoreboard unavailable (" + r.status + ")" }, 502, 0);
  const d = await r.json();
  const games = (d.events || []).map(e => {
    const c = (e.competitions || [])[0] || {};
    const side = k => (c.competitors || []).find(x => x.homeAway === k) || {};
    const st = (c.status || e.status || {}).type || {};
    const odds = (c.odds || [])[0] || {}, w = e.weather || c.weather || null;
    return {
      away: (side("away").team || {}).abbreviation, home: (side("home").team || {}).abbreviation,
      awayScore: side("away").score || "0", homeScore: side("home").score || "0",
      state: st.state || "pre", detail: st.shortDetail || st.detail || "",
      ou: odds.overUnder != null ? Number(odds.overUnder) : null, line: odds.details || "",
      temp: w && w.temperature != null ? w.temperature : null, sky: (w && w.displayValue) || "",
      indoor: !!(c.venue && c.venue.indoor), date: c.date || e.date || ""
    };
  }).filter(g => g.away && g.home);
  return json({ games }, 200, 30);
}

// Season fantasy points for every player: [ppr, half, std, games played].
async function seasonStats(season) {
  const r = await fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season, { headers: UA });
  if (!r.ok) return json({ error: "Season stats unavailable (" + r.status + ")" }, 502, 0);
  const all = await r.json();
  const out = {};
  for (const id in all) {
    const s = all[id] || {};
    if (!s.pts_ppr && !s.pts_std) continue;
    out[id] = [s.pts_ppr || 0, s.pts_half_ppr || 0, s.pts_std || 0, s.gp || s.gms_active || 0];
  }
  return json(out, 200, 1800);
}

// This week's projected points for every skill player: { sleeperId: [ppr, half, std] }.
async function weekProjections(season, week) {
  const out = {};
  for (const pos of ["QB", "RB", "WR", "TE"]) {
    const r = await fetch("https://api.sleeper.com/projections/nfl/" + season + "/" + week + "?season_type=regular&position[]=" + pos + "&order_by=pts_ppr", { headers: UA });
    if (!r.ok) continue;
    for (const x of await r.json()) {
      const s = x.stats || {}, id = x.player_id;
      if (!id) continue;
      out[id] = [Number(s.pts_ppr || 0), Number(s.pts_half_ppr ?? s.pts_ppr ?? 0), Number(s.pts_std ?? 0)];
    }
  }
  if (!Object.keys(out).length) return json({ error: "Projections unavailable" }, 502, 0);
  return json(out, 200, 1800);
}

// Snap share and usage for the last three weeks: { sleeperId: [snap%, prev snap%, targets, prev targets, carries, prev carries] }.
async function roles(season, week) {
  const weeks = [week - 1, week - 2, week - 3].filter(w => w >= 1);
  if (!weeks.length) return json({ week: 0, players: {} }, 200, 3600);
  const data = await Promise.all(weeks.map(w => fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season + "/" + w, { headers: UA }).then(r => r.ok ? r.json() : {}).catch(() => ({}))));
  const pct = s => s && s.tm_off_snp ? (s.off_snp || 0) / s.tm_off_snp : null;
  const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : null;
  const r1 = n => n == null ? null : Math.round(n * 10) / 10;
  const out = {};
  for (const id in data[0]) {
    const s0 = data[0][id], p0 = pct(s0);
    if (p0 == null) continue;
    const prev = data.slice(1).map(d => d[id]).filter(x => pct(x) != null);
    out[id] = [Math.round(p0 * 100), prev.length ? Math.round(avg(prev.map(pct)) * 100) : null,
      s0.rec_tgt || 0, prev.length ? r1(avg(prev.map(x => x.rec_tgt || 0))) : null,
      s0.rush_att || 0, prev.length ? r1(avg(prev.map(x => x.rush_att || 0))) : null];
  }
  return json({ week: weeks[0], players: out }, 200, 21600);
}

// Players marked as keepers on a Fleaflicker team page (pin icon), plus the league's keeper limit.
async function fleaKeepers(lid, tid) {
  const r = await fetch("https://www.fleaflicker.com/nfl/leagues/" + lid + "/teams/" + tid, { headers: { "User-Agent": UA["User-Agent"] } });
  if (!r.ok) return json({ error: "Team page unavailable" }, 502, 0);
  const h = await r.text(), kept = [];
  for (const row of h.split("<tr")) {
    const m = row.match(/\/players\/[a-z0-9-]*?-(\d+)"/);
    if (m && row.includes("fa-thumb-tack")) kept.push(m[1]);
  }
  const mx = h.match(/data-max-allowed="(\d+)"/);
  return json({ max: mx ? Number(mx[1]) : null, kept: [...new Set(kept)] }, 200, 600);
}

// Playoff format from the league's public playoffs page: first playoff week and number of playoff teams.
async function fleaPlayoffs(id) {
  const r = await fetch("https://www.fleaflicker.com/nfl/leagues/" + id + "/playoffs", { headers: { "User-Agent": UA["User-Agent"] } });
  if (!r.ok) return json({ error: "Playoff page unavailable" }, 502, 0);
  const t = (await r.text()).replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  const i = t.indexOf("Round 1 ");
  let start = null, teams = null;
  if (i >= 0) {
    const m = t.slice(i).match(/^Round 1 (\d+)/); if (m) start = Number(m[1]);
    const seeds = [...t.slice(i, i + 4000).matchAll(/#(\d+) /g)].map(x => Number(x[1]));
    if (seeds.length) teams = Math.max(...seeds);
  }
  return json({ start, teams }, 200, 86400);
}

// One page (10) of a Fleaflicker league's completed trades, slimmed to what the trade report card needs.
async function fleaTrades(lid, offset) {
  const r = await fetch("https://www.fleaflicker.com/api/FetchTrades?sport=NFL&filter=TRADES_COMPLETED&league_id=" + lid + (offset ? "&result_offset=" + offset : ""), { headers: UA });
  if (!r.ok) return json({ error: "Fleaflicker answered " + r.status + " for this league's trades." }, 502, 0);
  const d = await r.json();
  const team = t => ({ id: String((t || {}).id || ""), name: (t || {}).name || "", logo: (t || {}).logoUrl || "" });
  const trades = (d.trades || []).map(t => ({
    id: String(t.id), t: Number(t.approvedOn || t.proposedOn || 0), desc: t.description || "",
    sides: (t.teams || []).map(s => Object.assign(team(s.team), {
      players: (s.playersObtained || []).map(x => { const p = x.proPlayer || {}; return { id: String(p.id), name: p.nameFull || "", pos: p.position || "", team: p.proTeamAbbreviation || "", img: p.headshotUrl || "" }; }),
      picks: (s.picksObtained || []).map(x => { const pk = x.draftPick || x, sl = pk.slot || {}; return { season: Number(pk.season) || 0, round: Number(sl.round || pk.round) || 0, slot: Number(sl.slot) || 0, overall: Number(sl.overall) || 0, from: ((pk.originalOwner || {}).name) || "" }; })
    }))
  }));
  return json({ total: Number(d.resultTotal) || trades.length, next: d.resultOffsetNext != null ? Number(d.resultOffsetNext) : null, trades }, 200, 600);
}

// Every game of one Fleaflicker season (regular season and playoffs), for league history and rivalries.
async function fleaHistory(lid, season) {
  const get = u => fetch("https://www.fleaflicker.com/api/" + u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
  const st = await get("FetchLeagueStandings?sport=NFL&league_id=" + lid + "&season=" + season);
  if (!st) return json({ error: "Fleaflicker didn't answer for " + season + "." }, 502, 0);
  if (Number(st.season) !== Number(season)) return json({ season: Number(season), missing: true }, 200, 86400);
  const first = await get("FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&season=" + season + "&scoring_period=1");
  const periods = ((first || {}).eligibleSchedulePeriods || []).map(x => x.ordinal || x.value).filter(Boolean).slice(0, 22);
  // Fleaflicker answers a season the league didn't exist in with the current season, without a season tag.
  const low = ((first || {}).schedulePeriod || {}).low || {}, now = new Date(), curSeason = now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  if (!first || (low.season ? Number(low.season) !== Number(season) : Number(season) !== curSeason)) return json({ season: Number(season), missing: true }, 200, 86400);
  const boards = [first].concat(await Promise.all(periods.filter(w => w !== 1).map(w => get("FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&season=" + season + "&scoring_period=" + w))));
  const team = t => ({ id: String((t || {}).id || ""), name: (t || {}).name || "", logo: (t || {}).logoUrl || "" });
  const sc = x => { const v = ((x || {}).score || {}).value; return v == null ? null : Number(v); };
  const games = [];
  let live = false;
  boards.forEach((b, i) => {
    if (!b) return;
    const wk = (b.schedulePeriod || {}).ordinal || periods[i] || i + 1;
    (b.games || []).forEach(g => {
      if (!g.isFinalScore) { live = true; return; }
      games.push({ wk, a: team(g.away), h: team(g.home), as: sc(g.awayScore), hs: sc(g.homeScore), po: !!g.isPlayoffs, ch: !!g.isChampionshipGame, cons: !!g.isConsolation });
    });
  });
  const teams = [];
  (st.divisions || []).forEach(d => (d.teams || []).forEach(t => teams.push(Object.assign(team(t), { w: (t.recordOverall || {}).wins || 0, l: (t.recordOverall || {}).losses || 0, t: (t.recordOverall || {}).ties || 0, pf: Number((t.pointsFor || {}).value) || 0 }))));
  return json({ season: Number(season), teams, games, live }, 200, live ? 1800 : 604800);
}

// NFL schedule for a season: { week: { TEAM: "OPP" or "@OPP" } } (ESPN abbreviations).
async function nflSchedule(season) {
  const weeks = await Promise.all(Array.from({ length: 18 }, (_, i) => fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=" + season + "&seasontype=2&week=" + (i + 1), { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null)));
  const out = {};
  weeks.forEach((d, i) => {
    if (!d) return;
    const w = out[i + 1] = {};
    for (const e of d.events || []) {
      const c = (e.competitions || [])[0] || {}, cs = c.competitors || [];
      const home = cs.find(x => x.homeAway === "home"), away = cs.find(x => x.homeAway === "away");
      if (!home || !away) continue;
      const h = (home.team || {}).abbreviation, a = (away.team || {}).abbreviation;
      w[h] = a; w[a] = "@" + h;
    }
  });
  if (!Object.keys(out).length) return json({ error: "NFL schedule unavailable" }, 502, 0);
  return json({ season: Number(season), weeks: out }, 200, 86400);
}

// Fantasy points each defense allowed to each position in one week: { TEAM: { QB, RB, WR, TE } } (PPR, half, std).
async function allowedWeek(ctx, season, week) {
  const [statsR, boardR, plR] = await Promise.all([
    fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season + "/" + week, { headers: UA }),
    fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?dates=" + season + "&seasontype=2&week=" + week, { headers: UA }),
    cached(ctx, "players-v2", 21600, slimPlayers)
  ]);
  if (!statsR.ok || !boardR.ok || plR.status !== 200) return json({ error: "Stats unavailable for week " + week }, 502, 0);
  const [stats, board, pl] = await Promise.all([statsR.json(), boardR.json(), plR.json()]);
  const opp = {};
  for (const e of board.events || []) {
    const c = (e.competitions || [])[0] || {}, st = ((c.status || {}).type || {}).state;
    if (st !== "post") continue;
    const cs = (c.competitors || []).map(x => (x.team || {}).abbreviation);
    if (cs.length === 2) { opp[cs[0]] = cs[1]; opp[cs[1]] = cs[0]; }
  }
  const ESPN = { WAS: "WSH", LA: "LAR", JAC: "JAX" };
  const out = {};
  for (const id in stats) {
    const p = pl[id], s = stats[id];
    if (!p || !["QB", "RB", "WR", "TE"].includes(p[1]) || !s || !(s.gp || s.off_snp)) continue;
    const t = ESPN[p[2]] || p[2], o = opp[t];
    if (!o) continue;
    const a = (out[o] = out[o] || {}), v = (a[p[1]] = a[p[1]] || [0, 0, 0]);
    v[0] += s.pts_ppr || 0; v[1] += s.pts_half_ppr || 0; v[2] += s.pts_std || 0;
  }
  for (const t in out) for (const pos in out[t]) out[t][pos] = out[t][pos].map(x => Math.round(x * 10) / 10);
  const done = Object.keys(opp).length > 0;
  return json({ season: Number(season), week: Number(week), teams: out }, 200, done ? 604800 : 1800);
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const p = url.pathname;
    try {
      if (p === "/" || p === "/index.html") {
        return new Response(HTML, { headers: { "content-type": "text/html; charset=utf-8", "cache-control": "no-cache" } });
      }
      const st = staticRoute(p);
      if (st) return st;
      if (p.startsWith("/api/push/")) return alertsRoute(request, env, p, url);
      if (p === "/api/coach") return coachRoute(request, env);
      if (p === "/api/hookpost") return hookPostRoute(request);
      if (p === "/api/espn") return espnRoute(request, url, ctx);
      if (p === "/api/mfl") return mflRoute(url, ctx);
      if (p === "/api/scores") return cached(ctx, "scores/" + url.search, 30, () => scoresRoute(url));
      if (p === "/cal.ics" || p === "/api/cal.ics") return cached(ctx, "cal/" + url.search, 21600, () => calendarRoute(url));
      if (p === "/api/injuries") return cached(ctx, "injuries", 300, injuriesRoute);
      if (p.startsWith("/api/sleeper/")) {
        const rest = p.slice("/api/sleeper/".length);
        if (!/^[A-Za-z0-9_\-\/.]+$/.test(rest)) return json({ error: "Bad path" }, 400, 0);
        const ttl = rest.startsWith("state/") ? 300 : rest.includes("/matchups/") ? 45 : rest.includes("trending") ? 900 : 120;
        const target = "https://api.sleeper.app/v1/" + rest + url.search;
        return cached(ctx, "s/" + rest + url.search, ttl, () => upstream(target, ttl));
      }
      if (p === "/api/players") return cached(ctx, "players-v2", 21600, slimPlayers);
      if (p.startsWith("/api/flea/")) {
        const ep = p.slice("/api/flea/".length);
        if (!FLEA_OK.has(ep)) return json({ error: "Unsupported Fleaflicker request" }, 400, 0);
        const ttl = ep === "FetchLeagueScoreboard" || ep === "FetchLeagueBoxscore" ? 45 : 180;
        const target = "https://www.fleaflicker.com/api/" + ep + url.search;
        return cached(ctx, "f/" + ep + url.search, ttl, () => upstream(target, ttl));
      }
      if (p === "/api/scoreboard") return cached(ctx, "scoreboard", 30, scoreboard);
      if (p === "/api/sstats") {
        const season = url.searchParams.get("season") || "";
        if (!/^\d{4}$/.test(season)) return json({ error: "Bad season" }, 400, 0);
        return cached(ctx, "sstats/" + season, 1800, () => seasonStats(season));
      }
      if (p === "/api/values") {
        const ppr = ["0", "0.5", "1"].includes(url.searchParams.get("ppr")) ? url.searchParams.get("ppr") : "1";
        const t = Number(url.searchParams.get("teams")) || 12, teams = t <= 11 ? 10 : t <= 13 ? 12 : 14;
        const qbs = url.searchParams.get("qbs") === "2" ? 2 : 1;
        const dyn = url.searchParams.get("dyn") === "1";
        return cached(ctx, "values5/" + ppr + "/" + teams + "/" + qbs + "/" + (dyn ? 1 : 0), 21600, () => tradeValues(ppr, teams, qbs, dyn));
      }
      if (p === "/api/proj") {
        const season = url.searchParams.get("season") || "", week = url.searchParams.get("week") || "";
        if (!/^\d{4}$/.test(season) || !/^\d{1,2}$/.test(week)) return json({ error: "Bad season or week" }, 400, 0);
        return cached(ctx, "proj/" + season + "/" + week, 1800, () => weekProjections(season, week));
      }
      if (p === "/api/roles") {
        const season = url.searchParams.get("season") || "", week = Number(url.searchParams.get("week") || 0);
        if (!/^\d{4}$/.test(season) || !(week >= 1 && week <= 22)) return json({ error: "Bad season or week" }, 400, 0);
        return cached(ctx, "roles/" + season + "/" + week, 21600, () => roles(season, week));
      }
      if (p === "/api/flea-keepers") {
        const lid = (url.searchParams.get("league_id") || "").replace(/\D/g, ""), tid = (url.searchParams.get("team_id") || "").replace(/\D/g, "");
        if (!lid || !tid) return json({ error: "Missing league or team" }, 400, 0);
        return cached(ctx, "fkp/" + lid + "/" + tid, 600, () => fleaKeepers(lid, tid));
      }
      if (p === "/api/nflsched") {
        const season = url.searchParams.get("season") || "";
        if (!/^\d{4}$/.test(season)) return json({ error: "Bad season" }, 400, 0);
        return cached(ctx, "nflsched/" + season, 86400, () => nflSchedule(season));
      }
      if (p === "/api/allowed") {
        const season = url.searchParams.get("season") || "", week = Number(url.searchParams.get("week") || 0);
        if (!/^\d{4}$/.test(season) || !(week >= 1 && week <= 18)) return json({ error: "Bad season or week" }, 400, 0);
        return cached(ctx, "allowed/" + season + "/" + week, 21600, () => allowedWeek(ctx, season, week));
      }
      if (p === "/api/flea-history") {
        const lid = (url.searchParams.get("league_id") || "").replace(/\D/g, ""), season = (url.searchParams.get("season") || "").replace(/\D/g, "");
        if (!lid || !/^\d{4}$/.test(season)) return json({ error: "Missing league or season" }, 400, 0);
        return cached(ctx, "fhist/" + lid + "/" + season, Number(season) >= new Date().getUTCFullYear() ? 1800 : 604800, () => fleaHistory(lid, season));
      }
      if (p === "/api/flea-trades") {
        const lid = (url.searchParams.get("league_id") || "").replace(/\D/g, ""), off = Math.min(5000, Number((url.searchParams.get("offset") || "0").replace(/\D/g, "")) || 0);
        if (!lid) return json({ error: "Missing league" }, 400, 0);
        return cached(ctx, "ftr/" + lid + "/" + off, 600, () => fleaTrades(lid, off));
      }
      if (p === "/api/flea-playoffs") {
        const id = (url.searchParams.get("league_id") || "").replace(/\D/g, "");
        if (!id) return json({ error: "Missing league" }, 400, 0);
        return cached(ctx, "fpo/" + id, 86400, () => fleaPlayoffs(id));
      }
      if (p === "/api/headlines") return cached(ctx, "headlines", 600, headlines);
      if (p === "/api/news") {
        const q = (url.searchParams.get("q") || "").slice(0, 80);
        const espn = (url.searchParams.get("espn") || "").replace(/[^0-9]/g, "").slice(0, 12);
        if (!q) return json({ error: "Missing player name" }, 400, 0);
        return cached(ctx, "n2/" + espn + "/" + encodeURIComponent(q), 600, () => playerNews(q, espn));
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      return json({ error: "Something went wrong reaching the data source. Try again in a minute." }, 502, 0);
    }
  },
  async scheduled(event, env, ctx) {
    ctx.waitUntil(runMinute(env));
  }
};

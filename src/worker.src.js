// Snap Count — one Cloudflare Worker that serves the app and fetches live league data.
// Paste this whole file into a new Cloudflare Worker and deploy. Free plan is fine.

import { alertsRoute, runMinute, staticRoute, injuriesRoute } from "./src/alerts.js";

const HTML = __HTML__;

const FLEA_OK = new Set([
  "FetchUserLeagues", "FetchLeagueStandings", "FetchLeagueScoreboard", "FetchLeagueRosters",
  "FetchRoster", "FetchLeagueBoxscore", "FetchLeagueActivity", "FetchLeagueTransactions", "FetchPlayerListing", "FetchLeagueRules"
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
    const row = [Math.round(x.value || 0), x.overallRank || null, x.positionRank || null, Math.round(x.trend30Day || 0), p.name || "", p.position || ""];
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
    return {
      away: (side("away").team || {}).abbreviation, home: (side("home").team || {}).abbreviation,
      awayScore: side("away").score || "0", homeScore: side("home").score || "0",
      state: st.state || "pre", detail: st.shortDetail || st.detail || ""
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
        return cached(ctx, "values2/" + ppr + "/" + teams + "/" + qbs + "/" + (dyn ? 1 : 0), 21600, () => tradeValues(ppr, teams, qbs, dyn));
      }
      if (p === "/api/proj") {
        const season = url.searchParams.get("season") || "", week = url.searchParams.get("week") || "";
        if (!/^\d{4}$/.test(season) || !/^\d{1,2}$/.test(week)) return json({ error: "Bad season or week" }, 400, 0);
        return cached(ctx, "proj/" + season + "/" + week, 1800, () => weekProjections(season, week));
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

// More integrations: ESPN Fantasy, MyFantasyLeague, every-sport scores, calendar feed.
const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };

function out(data, status = 200, maxAge = 0) {
  return new Response(JSON.stringify(data), {
    status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": maxAge ? "public, max-age=" + maxAge : "no-store" }
  });
}

/* ---------- ESPN Fantasy ---------- */
// Public leagues work with just the league ID. Private leagues need the espn_s2 and SWID
// cookies from a signed-in browser; the app sends them in headers (never in the URL)
// and we pass them straight to ESPN without storing them.
const ESPN_VIEWS = new Set(["mTeam", "mRoster", "mMatchupScore", "mSettings", "mStatus", "mBoxscore", "kona_player_info", "mPendingTransactions", "mTransactions2"]);
export async function espnRoute(request, url, ctx) {
  const lid = url.searchParams.get("lid") || "", season = url.searchParams.get("season") || "";
  if (!/^\d{1,12}$/.test(lid) || !/^\d{4}$/.test(season)) return out({ error: "Bad ESPN league ID" }, 400);
  const views = (url.searchParams.get("view") || "mTeam").split(",").filter(v => ESPN_VIEWS.has(v));
  const q = new URLSearchParams();
  views.forEach(v => q.append("view", v));
  const wk = url.searchParams.get("wk");
  if (wk && /^\d{1,2}$/.test(wk)) q.set("scoringPeriodId", wk);
  const headers = Object.assign({}, UA);
  const s2 = request.headers.get("x-espn-s2"), swid = request.headers.get("x-espn-swid");
  if (s2 && swid) headers.Cookie = "espn_s2=" + s2.replace(/[;\r\n]/g, "") + "; SWID=" + swid.replace(/[;\r\n]/g, "");
  if (url.searchParams.get("fa") === "1") {
    const slot = url.searchParams.get("slot");
    const f = { players: { filterStatus: { value: ["FREEAGENT", "WAIVERS"] }, limit: 60, sortPercOwned: { sortPriority: 1, sortAsc: false }, filterRanksForScoringPeriodIds: { value: [Number(wk) || 1] } } };
    if (slot && /^\d{1,2}$/.test(slot)) f.players.filterSlotIds = { value: [Number(slot)] };
    headers["X-Fantasy-Filter"] = JSON.stringify(f);
  }
  const target = "https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season + "/segments/0/leagues/" + lid + "?" + q.toString();
  const go = async () => {
    const r = await fetch(target, { headers, redirect: "manual" });
    if (r.status === 401 || r.status === 403 || (r.status >= 300 && r.status < 400)) return out({ error: "This ESPN league is private. Add your espn_s2 and SWID under Accounts to load it.", private: true }, 401);
    if (r.status === 404) return out({ error: "ESPN couldn’t find league " + lid + " for " + season + "." }, 404);
    if (!r.ok) return out({ error: "ESPN answered " + r.status + "." }, 502);
    const text = await r.text();
    if (text.trim().startsWith("<")) return out({ error: "This ESPN league is private. Add your espn_s2 and SWID under Accounts to load it.", private: true }, 401);
    return new Response(text, { headers: { "content-type": "application/json; charset=utf-8", "cache-control": headers.Cookie ? "private, max-age=30" : "public, max-age=60" } });
  };
  if (headers.Cookie) return go();
  const cache = caches.default, key = new Request("https://snapcount.cache/espn/" + lid + "/" + season + "/" + q.toString() + "/" + (headers["X-Fantasy-Filter"] || ""));
  const hit = await cache.match(key); if (hit) return hit;
  const res = await go();
  if (res.status === 200) ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* ---------- MyFantasyLeague ---------- */
const MFL_TYPES = new Set(["league", "rosters", "leagueStandings", "liveScoring", "freeAgents", "players", "projectedScores", "transactions", "tradeBait", "playerScores"]);
export async function mflRoute(url, ctx) {
  const type = url.searchParams.get("type") || "", L = url.searchParams.get("L") || "", year = url.searchParams.get("year") || "";
  if (!MFL_TYPES.has(type) || !/^\d{4}$/.test(year) || (type !== "players" && !/^\d{1,8}$/.test(L))) return out({ error: "Bad MFL request" }, 400);
  const q = new URLSearchParams({ TYPE: type, JSON: "1" });
  if (type !== "players") q.set("L", L); else q.set("DETAILS", "0");
  const W = url.searchParams.get("W"); if (W && /^\d{1,2}$/.test(W)) q.set("W", W);
  if (type === "freeAgents" || type === "transactions") { const P = url.searchParams.get("POSITION"); if (P && /^[A-Z+]{1,10}$/.test(P)) q.set("POSITION", P); }
  if (type === "playerScores") q.set("WEEK", "YTD");
  const ttl = type === "players" ? 21600 : type === "liveScoring" ? 45 : 180;
  const target = "https://api.myfantasyleague.com/" + year + "/export?" + q.toString();
  const cache = caches.default, key = new Request("https://snapcount.cache/mfl/" + year + "/" + q.toString());
  const hit = await cache.match(key); if (hit) return hit;
  const r = await fetch(target, { headers: UA });
  if (!r.ok) return out({ error: "MyFantasyLeague answered " + r.status + "." }, 502);
  const text = await r.text();
  let data; try { data = JSON.parse(text); } catch (e) { return out({ error: "MyFantasyLeague didn’t return data for league " + L + "." }, 502); }
  if (data.error) return out({ error: "MyFantasyLeague: " + (data.error.$t || data.error) + (/private|login|cookie/i.test(JSON.stringify(data.error)) ? " This league is private." : "") }, 403);
  const res = new Response(JSON.stringify(data), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=" + ttl } });
  ctx.waitUntil(cache.put(key, res.clone()));
  return res;
}

/* ---------- every sport ---------- */
export const SPORTS = {
  nfl: ["football/nfl", "NFL"], cfb: ["football/college-football", "College football"],
  nba: ["basketball/nba", "NBA"], ncaam: ["basketball/mens-college-basketball", "Men’s college hoops"], wnba: ["basketball/wnba", "WNBA"], ncaaw: ["basketball/womens-college-basketball", "Women’s college hoops"],
  nhl: ["hockey/nhl", "NHL"], mlb: ["baseball/mlb", "MLB"],
  epl: ["soccer/eng.1", "Premier League"], mls: ["soccer/usa.1", "MLS"], ucl: ["soccer/uefa.champions", "Champions League"], laliga: ["soccer/esp.1", "La Liga"],
  pga: ["golf/pga", "PGA Tour"], f1: ["racing/f1", "Formula 1"], ufc: ["mma/ufc", "UFC"]
};
export async function scoresRoute(url) {
  const s = url.searchParams.get("sport") || "nfl";
  const sp = SPORTS[s]; if (!sp) return out({ error: "Unknown sport" }, 400);
  const d = url.searchParams.get("date");
  const q = new URLSearchParams({ limit: "200" });
  if (d && /^\d{8}$/.test(d)) q.set("dates", d);
  if (s === "cfb" && !d) q.set("groups", "80");
  if ((s === "ncaam" || s === "ncaaw") && !d) q.set("groups", "50");
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/" + sp[0] + "/scoreboard?" + q.toString(), { headers: UA });
  if (!r.ok) return out({ error: sp[1] + " scores unavailable (" + r.status + ")" }, 502);
  const j = await r.json();
  const individual = s === "pga" || s === "f1" || s === "ufc";
  const games = (j.events || []).map(e => {
    const c = (e.competitions || [])[0] || {};
    const st = (c.status || e.status || {}).type || {};
    const base = { id: e.id, name: e.shortName || e.name, date: e.date, state: st.state || "pre", detail: st.shortDetail || st.detail || "", link: ((e.links || []).find(l => (l.rel || []).includes("summary")) || (e.links || [])[0] || {}).href || "",
      tv: ((c.broadcasts || []).flatMap(b => b.names || []))[0] || "", venue: (c.venue || {}).fullName || "" };
    if (individual) {
      const comps = (e.competitions || []).length > 1 ? (e.competitions.find(x => ((x.status || {}).type || {}).state === "in") || e.competitions[0]) : c;
      const top = (comps.competitors || []).slice().sort((a, b) => (a.order || a.sortOrder || 99) - (b.order || b.sortOrder || 99)).slice(0, 5)
        .map(x => ({ name: (x.athlete || {}).displayName || (x.team || {}).displayName || "", score: x.score && typeof x.score === "object" ? x.score.displayValue : x.score || "", winner: !!x.winner }));
      return Object.assign(base, { title: e.name, top });
    }
    const side = k => {
      const x = (c.competitors || []).find(t => t.homeAway === k) || {}, t = x.team || {};
      return { id: t.id || "", abbr: t.abbreviation || "", name: t.shortDisplayName || t.displayName || "", logo: t.logo || "", score: x.score || "", rank: (x.curatedRank || {}).current < 99 ? x.curatedRank.current : null,
        rec: ((x.records || [])[0] || {}).summary || "", winner: !!x.winner, color: t.color || "" };
    };
    const odds = (c.odds || [])[0] || {};
    return Object.assign(base, { away: side("away"), home: side("home"), line: odds.details || "", ou: odds.overUnder || null, sit: c.situation ? { down: c.situation.shortDownDistanceText || "", poss: c.situation.possession || "", rz: !!c.situation.isRedZone, last: (c.situation.lastPlay || {}).text || "" } : null });
  });
  return out({ sport: s, label: sp[1], day: (j.day || {}).date || "", games }, 200, 30);
}

/* ---------- calendar feed (.ics) ---------- */
// t=KC~Patrick Mahomes|Travis Kelce;BUF~Josh Allen  → every game those teams play, with your players in the title.
function icsEsc(s) { return String(s || "").replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,").replace(/\r?\n/g, "\\n"); }
function icsDate(d) { return new Date(d).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""); }
function ymd(d) { return d.toISOString().slice(0, 10).replace(/-/g, ""); }
export async function calendarRoute(url) {
  const map = {};
  (url.searchParams.get("t") || "").split(";").slice(0, 40).forEach(part => {
    const [team, names] = part.split("~");
    if (/^[A-Z]{2,4}$/.test(team || "")) map[team] = (names || "").split("|").map(n => n.slice(0, 40)).filter(Boolean).slice(0, 20);
  });
  const title = (url.searchParams.get("n") || "Snap Count: my players").slice(0, 60);
  const now = new Date();
  const base = "https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard";
  const cur = await fetch(base, { headers: UA }).then(r => r.ok ? r.json() : {}).catch(() => ({}));
  const wk = (cur.week || {}).number || 1, yr = (cur.season || {}).year || now.getUTCFullYear(), type = (cur.season || {}).type || 2;
  let events = (cur.events || []).slice();
  if (type === 2) {
    const more = await Promise.all(Array.from({ length: Math.min(18, wk + 9) - wk }, (_, i) => fetch(base + "?dates=" + yr + "&seasontype=2&week=" + (wk + 1 + i), { headers: UA }).then(r => r.ok ? r.json() : {}).catch(() => ({}))));
    more.forEach(m => events = events.concat(m.events || []));
  }
  const j = { events };
  const lines = ["BEGIN:VCALENDAR", "VERSION:2.0", "PRODID:-//Snap Count//Fantasy//EN", "CALSCALE:GREGORIAN", "METHOD:PUBLISH", "X-WR-CALNAME:" + icsEsc(title), "X-PUBLISHED-TTL:PT6H", "REFRESH-INTERVAL;VALUE=DURATION:PT6H"];
  const stamp = icsDate(now);
  for (const e of j.events || []) {
    const c = (e.competitions || [])[0] || {};
    const teams = (c.competitors || []).map(x => (x.team || {}).abbreviation);
    const mine = teams.flatMap(t => map[t] || []);
    if (!teams.some(t => map[t])) continue;
    const start = new Date(e.date); if (isNaN(start)) continue;
    const end = new Date(start.getTime() + 195 * 60000);
    const tv = ((c.broadcasts || []).flatMap(b => b.names || []))[0] || "";
    const odds = (c.odds || [])[0] || {};
    const st = ((c.status || {}).type || {});
    const desc = (mine.length ? "Your players: " + mine.join(", ") + "\n" : "") + (tv ? "TV: " + tv + "\n" : "") + (odds.details ? "Line: " + odds.details + (odds.overUnder ? ", O/U " + odds.overUnder : "") + "\n" : "") + (st.state === "post" ? "Final: " + st.shortDetail + "\n" : "") + "Open Snap Count to set your lineup.";
    lines.push("BEGIN:VEVENT", "UID:snapcount-" + e.id + "@snapcount", "DTSTAMP:" + stamp, "DTSTART:" + icsDate(start), "DTEND:" + icsDate(end),
      "SUMMARY:" + icsEsc((e.shortName || e.name) + (mine.length ? " · " + (mine.length > 3 ? mine.slice(0, 3).join(", ") + " +" + (mine.length - 3) : mine.join(", ")) : "")),
      "DESCRIPTION:" + icsEsc(desc), "LOCATION:" + icsEsc(((c.venue || {}).fullName) || ""), "URL:" + url.origin + "/", "END:VEVENT");
  }
  lines.push("END:VCALENDAR");
  const body = lines.map(l => { let s = "", x = l; while (x.length > 74) { s += x.slice(0, 74) + "\r\n "; x = x.slice(74); } return s + x; }).join("\r\n") + "\r\n";
  return new Response(body, { headers: { "content-type": "text/calendar; charset=utf-8", "cache-control": "public, max-age=21600", "content-disposition": "inline; filename=snapcount.ics" } });
}

/* ---------- alert destinations: Discord, Slack, Teams, ntfy, Pushover-style webhooks ---------- */
export function hookKind(u) {
  if (/^https:\/\/(discord\.com|discordapp\.com|ptb\.discord\.com|canary\.discord\.com)\/api\/webhooks\//.test(u)) return "discord";
  if (/^https:\/\/hooks\.slack\.com\//.test(u)) return "slack";
  if (/^https:\/\/[^/]+\.webhook\.office\.com\/|^https:\/\/[^/]+\.logic\.azure\.com\//.test(u)) return "teams";
  if (/^https:\/\/ntfy\.sh\/[A-Za-z0-9_-]{1,64}$/.test(u)) return "ntfy";
  if (/^https:\/\/api\.telegram\.org\/bot[0-9]+:[A-Za-z0-9_-]+\/sendMessage\?chat_id=-?[0-9]+$/.test(u)) return "telegram";
  if (/^https:\/\/(maker\.ifttt\.com|hooks\.zapier\.com|hook\.[a-z0-9]+\.make\.com|[a-z0-9-]+\.pipedream\.net)\//.test(u)) return "generic";
  return null;
}
export async function sendHook(u, items, origin) {
  const kind = hookKind(u); if (!kind || !items.length) return 0;
  const list = items.slice(0, 8);
  const plain = list.map(a => "• " + a.title + " — " + a.body + (a.url ? " " + a.url : "")).join("\n");
  let init;
  if (kind === "discord") init = { body: JSON.stringify({ username: "Snap Count", embeds: list.map(a => ({ title: a.title.slice(0, 250), description: String(a.body || "").slice(0, 2000), url: a.url || origin + "/", color: 0xff7a3d })) }) };
  else if (kind === "slack") init = { body: JSON.stringify({ text: list.map(a => "*" + a.title + "*\n" + a.body + (a.url ? "\n<" + a.url + "|Read more>" : "")).join("\n\n") }) };
  else if (kind === "teams") init = { body: JSON.stringify({ text: list.map(a => "**" + a.title + "**  \n" + a.body).join("\n\n") }) };
  else if (kind === "telegram") init = { body: JSON.stringify({ text: plain.slice(0, 4000), disable_web_page_preview: true }) };
  else if (kind === "ntfy") return (await fetch(u, { method: "POST", headers: { Title: list.length === 1 ? list[0].title.replace(/[^\x20-\x7e]/g, "") : "Snap Count: " + list.length + " alerts", Tags: "football", Click: list[0].url || origin + "/" }, body: list.length === 1 ? list[0].body : plain })).status;
  else init = { body: JSON.stringify({ value1: list[0].title, value2: list[0].body, value3: list[0].url || origin + "/", alerts: list }) };
  const r = await fetch(u, Object.assign({ method: "POST", headers: { "content-type": "application/json" } }, init));
  return r.status;
}

/* ---------- shared roster readers (used by alerts to know who’s a free agent) ---------- */
const nrm = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b/g, "").replace(/[^a-z]/g, "");
export const ESPN_POS = { 1: "QB", 2: "RB", 3: "WR", 4: "TE", 5: "K", 16: "DEF" };
export const MFL_POS = { QB: "QB", RB: "RB", WR: "WR", TE: "TE", PK: "K", Def: "DEF", DEF: "DEF" };
export const mflName = n => { const m = String(n || "").split(", "); return m.length === 2 ? m[1] + " " + m[0] : String(n || ""); };
const arr = x => x == null ? [] : Array.isArray(x) ? x : [x];
function season() { const d = new Date(); return d.getUTCMonth() < 2 ? d.getUTCFullYear() - 1 : d.getUTCFullYear(); }
export async function espnLeagueTaken(L) {
  try {
    const r = await fetch("https://lm-api-reads.fantasy.espn.com/apis/v3/games/ffl/seasons/" + (L.season || season()) + "/segments/0/leagues/" + L.id + "?view=mRoster", { headers: UA, redirect: "manual" });
    if (!r.ok) return null;
    const j = await r.json(), set = new Set();
    for (const t of j.teams || []) for (const e of ((t.roster || {}).entries || [])) { const p = (e.playerPoolEntry || {}).player || {}; set.add("nm:" + nrm(p.fullName) + "|" + (ESPN_POS[p.defaultPositionId] || "")); }
    return set;
  } catch (e) { return null; }
}
async function mflPlayers(year) {
  const cache = caches.default, key = new Request("https://snapcount.cache/mflplayers/" + year);
  const hit = await cache.match(key); if (hit) return hit.json();
  const r = await fetch("https://api.myfantasyleague.com/" + year + "/export?TYPE=players&DETAILS=0&JSON=1", { headers: UA });
  if (!r.ok) return {};
  const j = await r.json(), m = {};
  for (const p of arr((j.players || {}).player)) m[p.id] = [mflName(p.name), MFL_POS[p.position] || p.position, p.team];
  await cache.put(key, new Response(JSON.stringify(m), { headers: { "cache-control": "public, max-age=21600" } }));
  return m;
}
export async function mflLeagueTaken(L) {
  try {
    const year = L.season || season();
    const [r, pl] = await Promise.all([fetch("https://api.myfantasyleague.com/" + year + "/export?TYPE=rosters&JSON=1&L=" + L.id, { headers: UA }), mflPlayers(year)]);
    if (!r.ok) return null;
    const j = await r.json(), set = new Set();
    for (const f of arr((j.rosters || {}).franchise)) for (const p of arr(f.player)) { const q = pl[p.id]; if (q) set.add("nm:" + nrm(q[0]) + "|" + q[1]); }
    return set;
  } catch (e) { return null; }
}

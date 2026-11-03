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
  const txt = a => String(a.full || a.body || "");
  const plain = list.map(a => "• " + a.title + " — " + txt(a) + (a.url ? " " + a.url : "")).join("\n");
  let init;
  if (kind === "discord") init = { body: JSON.stringify({ username: "Snap Count", embeds: list.map(a => ({ title: a.title.slice(0, 250), description: txt(a).slice(0, 4000), url: a.url || origin + "/", color: 0xff7a3d })) }) };
  else if (kind === "slack") init = { body: JSON.stringify({ text: list.map(a => "*" + a.title + "*\n" + txt(a) + (a.url ? "\n<" + a.url + "|Read more>" : "")).join("\n\n") }) };
  else if (kind === "teams") init = { body: JSON.stringify({ text: list.map(a => "**" + a.title + "**  \n" + txt(a).replace(/\n/g, "  \n")).join("\n\n") }) };
  else if (kind === "telegram") init = { body: JSON.stringify({ text: plain.slice(0, 4000), disable_web_page_preview: true }) };
  else if (kind === "ntfy") return (await fetch(u, { method: "POST", headers: { Title: list.length === 1 ? list[0].title.replace(/[^\x20-\x7e]/g, "") : "Snap Count: " + list.length + " alerts", Tags: "football", Click: list[0].url || origin + "/" }, body: list.length === 1 ? txt(list[0]) : plain })).status;
  else init = { body: JSON.stringify({ value1: list[0].title, value2: txt(list[0]), value3: list[0].url || origin + "/", alerts: list }) };
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

/* ---------- AI coach (Cloudflare Workers AI, free tier) ---------- */
const COACH_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast", "@cf/meta/llama-3.1-8b-instruct"];
const COACH_SYS = `You are Snap Count Coach, a sharp, confident fantasy football analyst inside the Snap Count app.
You get a LEAGUE DATA block with the user's real roster, projections, injuries, opponent, standings, free agents and trade values. Treat it as the truth.
Rules:
- Base every recommendation on LEAGUE DATA. Name specific players and numbers from it (projections, values, records).
- Never invent players, stats, injuries or news that are not in LEAGUE DATA. If something you need is missing, say what's missing in one short line and still give your best call.
- Respect the league format in LEAGUE DATA (superflex/2QB means QBs are worth far more; dynasty means age and future value matter; keepers matter if listed).
- Lead with the answer in one sentence, then 2-5 short bullet reasons. Under 170 words unless asked for more. No preamble, no disclaimers.
- Only a player in a FREE AGENTS list can be picked up. Only players on other rosters can be traded for.
- You can't make moves in the league yourself; tell the user what to do in their league app.`;
const RECAP_SYS = `You write a punchy, funny weekly fantasy football league recap for a league group chat, like a sports columnist roasting friends.
Use ONLY the matchups, scores, standings and player points in LEAGUE DATA. Never invent stats or events.
Format: a headline line, then one short paragraph per matchup (winner, score, the star or the dud from the data), then a "Power rankings" list of every team (one line each with a quip), then one closing line. Under 380 words. No emojis overload: at most one per section.`;
const NEGO_SYS = `You role-play the other manager in a fantasy football trade negotiation over text. The user is pitching you a trade.
Stay in character as that manager: casual, competitive, a little stubborn, protective of your best players, like a real league-mate in a group chat. Never say you are an AI.
Use ONLY the facts in TRADE DATA (your roster, your record and needs, the offer, values). Never invent players, picks, stats or injuries.
Judge every offer from YOUR team's point of view: does it fill your needs, fit contending or rebuilding, and is the value fair to you? Lowball offers get pushback; good arguments that match your real needs make you more open.
Reply in 1 to 4 short sentences. You can reject, ask for more, or counter by naming specific players or picks from the user's roster in TRADE DATA.
When you agree to a deal, start the reply with "DEAL:" and then restate the exact final trade (who gets what). Only do that when you truly accept.`;
export async function coachRoute(request, env) {
  if (request.method !== "POST") return out({ error: "POST only" }, 405);
  if (!env.AI) return out({ error: "The AI coach isn't switched on for this app yet." }, 503);
  const b = await request.json().catch(() => ({}));
  const mode = b.mode === "recap" ? "recap" : b.mode === "negotiate" ? "negotiate" : "coach";
  const ctx = String(b.ctx || "").slice(0, 14000);
  const q = String(b.q || "").slice(0, 600);
  if (mode !== "recap" && !q.trim()) return out({ error: "Ask a question." }, 400);
  const hist = (Array.isArray(b.history) ? b.history : []).slice(mode === "negotiate" ? -12 : -6).map(m => ({ role: m.role === "assistant" ? "assistant" : "user", content: String(m.content || "").slice(0, 1500) }));
  const messages = [{ role: "system", content: mode === "negotiate" ? NEGO_SYS + "\n\nTRADE DATA:\n" + ctx : (mode === "recap" ? RECAP_SYS : COACH_SYS) + "\n\nLEAGUE DATA:\n" + ctx }]
    .concat(hist).concat([{ role: "user", content: mode === "recap" ? "Write this week's recap." : q }]);
  let lastErr = null;
  for (const model of COACH_MODELS) {
    try {
      const stream = await env.AI.run(model, { messages, stream: true, max_tokens: mode === "recap" ? 900 : mode === "negotiate" ? 260 : 600, temperature: mode === "recap" ? 0.8 : mode === "negotiate" ? 0.7 : 0.4 });
      return new Response(stream, { headers: { "content-type": "text/event-stream; charset=utf-8", "cache-control": "no-store", "x-model": model } });
    } catch (e) { lastErr = e; }
  }
  return out({ error: "The AI coach is busy right now. Try again in a minute. (" + String(lastErr && lastErr.message || lastErr).slice(0, 120) + ")" }, 502);
}

// One-shot AI text (no streaming) with model fallback; returns "" if the AI is unavailable.
export async function aiComplete(env, system, user, maxTokens, temperature) {
  if (!env.AI) return "";
  for (const model of COACH_MODELS) {
    try {
      const ai = await env.AI.run(model, { messages: [{ role: "system", content: system }, { role: "user", content: user }], max_tokens: maxTokens || 600, temperature: temperature ?? 0.4 });
      const text = String((ai && (ai.response || (ai.choices && ai.choices[0] && ai.choices[0].message && ai.choices[0].message.content))) || "").replace(/\*\*/g, "").trim();
      if (text) return text;
    } catch (e) {}
  }
  return "";
}

/* ---------- post a message to the user's connected apps (recaps, shares) ---------- */
export async function hookPostRoute(request) {
  if (request.method !== "POST") return out({ error: "POST only" }, 405);
  const b = await request.json().catch(() => ({}));
  const hooks = (Array.isArray(b.hooks) ? b.hooks : []).map(String).filter(u => hookKind(u)).slice(0, 5);
  if (!hooks.length) return out({ error: "Connect Discord, Slack or another app under Alerts first." }, 400);
  const title = String(b.title || "Snap Count").slice(0, 200), body = String(b.body || "").slice(0, 3800);
  const origin = new URL(request.url).origin;
  const res = await Promise.all(hooks.map(u => sendHook(u, [{ id: "post", title, body }], origin).catch(() => 0)));
  return res.some(s => s >= 200 && s < 300) ? out({ ok: true, sent: res.filter(s => s >= 200 && s < 300).length }) : out({ error: "Your connected app didn’t accept the message (" + res.join(", ") + ")." }, 502);
}

/* ---------- automatic weekly recap: Tuesdays, written by AI, posted to each league's connected Discord/Slack ---------- */
const FF = "https://www.fleaflicker.com/api/";
const fv = x => x == null ? null : typeof x !== "object" ? Number(x) : x.value != null ? Number(x.value) : x.formatted != null && !isNaN(Number(String(x.formatted).replace(/,/g, ""))) ? Number(String(x.formatted).replace(/,/g, "")) : null;
const f2 = n => n == null ? "0" : Number(n).toFixed(2);
export async function fleaRecapCtx(lid) {
  const j = u => fetch(FF + u, { headers: UA }).then(r => r.ok ? r.json() : {});
  const [board, stand] = await Promise.all([j("FetchLeagueScoreboard?sport=NFL&league_id=" + lid), j("FetchLeagueStandings?sport=NFL&league_id=" + lid)]);
  const week = (board.schedulePeriod || {}).ordinal || (board.schedulePeriod || {}).value || "?";
  const out = ["League: " + ((stand.league || {}).name || lid) + ", week " + week + "."];
  if ((board.games || []).some(g => g.isInProgress)) out.push("Note: some games are still being played.");
  out.push("MATCHUPS:");
  const lines = await Promise.all((board.games || []).map(async g => {
    const b = await j("FetchLeagueBoxscore?sport=NFL&league_id=" + lid + "&fantasy_game_id=" + g.id + "&scoring_period=" + week).catch(() => ({}));
    const st = ((b.lineups || []).find(x => x.group === "START") || {}).slots || [];
    const side = (k, pts, name, tot) => {
      const ps = st.map(s => s[k] && s[k].proPlayer ? { n: s[k].proPlayer.nameFull, p: fv(s[k].viewingActualPoints) || 0 } : null).filter(Boolean).sort((a, b) => b.p - a.p);
      const t = (tot || {}).total || {}, lost = fv(t.optimum) != null && fv(t.value) != null ? fv(t.optimum) - fv(t.value) : null;
      return name + " " + f2(pts) + (ps.length ? " (best: " + ps.slice(0, 2).map(x => x.n + " " + f2(x.p)).join(", ") + "; worst starter: " + ps[ps.length - 1].n + " " + f2(ps[ps.length - 1].p) + (lost > 5 ? "; left " + f2(lost) + " points on the bench" : "") + ")" : "");
    };
    return "- " + side("away", fv((g.awayScore || {}).score), (g.away || {}).name, b.pointsAway) + " vs " + side("home", fv((g.homeScore || {}).score), (g.home || {}).name, b.pointsHome);
  }));
  out.push(...lines);
  out.push("STANDINGS:");
  const ts = []; (stand.divisions || []).forEach(d => (d.teams || []).forEach(t => ts.push({ n: t.name, w: (t.recordOverall || {}).wins || 0, l: (t.recordOverall || {}).losses || 0, pf: fv(t.pointsFor) || 0 })));
  ts.sort((a, b) => b.w - a.w || b.pf - a.pf).forEach((t, i) => out.push((i + 1) + ". " + t.n + " " + t.w + "-" + t.l + ", PF " + f2(t.pf)));
  return { week, ctx: out.join("\n"), name: (stand.league || {}).name || "Your league", final: !(board.games || []).some(g => g.isInProgress) };
}
export async function weeklyRecaps(env, force) {
  const now = new Date();
  // Tuesday 10:07 AM Eastern (15:07 UTC), after Monday night is final.
  if (!force && !(now.getUTCDay() === 2 && now.getUTCHours() === 15 && now.getUTCMinutes() === 7)) return { skipped: true };
  if (!env.AI) return { error: "no AI" };
  const list = await env.SNAP.list({ prefix: "sub:" });
  const byLeague = {}; let origin = env.HOST ? "https://" + env.HOST : null;
  for (const k of list.keys) {
    const rec = await env.SNAP.get(k.name, "json");
    if (!rec || !(rec.hooks || []).length || (rec.prefs || {}).recap === false) continue;
    origin = origin || rec.origin;
    for (const L of rec.leagues || []) if (L.p === "flea") { const b = byLeague[L.id] = byLeague[L.id] || new Set(); rec.hooks.forEach(h => b.add(h)); }
  }
  const done = [];
  for (const lid of Object.keys(byLeague).slice(0, 20)) {
    try {
      const r = await fleaRecapCtx(lid);
      const key = "recap:" + lid + ":" + r.week;
      if (!force && await env.SNAP.get(key)) continue;
      const ai = await env.AI.run(COACH_MODELS[0], { messages: [{ role: "system", content: RECAP_SYS + "\n\nLEAGUE DATA:\n" + r.ctx }, { role: "user", content: "Write this week's recap." }], max_tokens: 900, temperature: 0.8 });
      const text = String((ai && (ai.response || (ai.choices && ai.choices[0] && ai.choices[0].message && ai.choices[0].message.content))) || "").replace(/\*\*/g, "").trim();
      if (!text) continue;
      for (const h of byLeague[lid]) await sendHook(h, [{ id: key, title: r.name + " · Week " + r.week + " recap", body: text }], origin || "https://www.fleaflicker.com").catch(() => 0);
      await env.SNAP.put(key, "1", { expirationTtl: 60 * 60 * 24 * 30 });
      done.push(lid);
    } catch (e) {}
  }
  return { posted: done };
}

/* ---------- set lineups from the app ---------- */
// ESPN: one atomic ROSTER transaction of LINEUP moves, sent with the user's own espn_s2/SWID (passed through, never stored).
const ESPN_LINEUP_ERR = { TRAN_LINEUP_LOCKED: "One of those players’ games has already started, so ESPN locked him.", TRAN_INVALID_SCORINGPERIOD_NOT_CURRENT: "ESPN only takes lineup changes for the current week.", TRAN_ROSTER_SAME_SLOT: "A player was already in that spot.", AUTH_MISSING_CREDENTIALS: "ESPN didn’t accept your sign-in cookies. Copy fresh espn_s2 and SWID values under Accounts." };
export async function espnLineupRoute(request) {
  if (request.method !== "POST") return out({ error: "POST only" }, 405);
  const b = await request.json().catch(() => ({}));
  const s2 = request.headers.get("x-espn-s2"), swid = request.headers.get("x-espn-swid");
  if (!s2 || !swid) return out({ error: "Add your espn_s2 and SWID under Accounts to change lineups from here." }, 401);
  const lid = String(b.lid || ""), season = String(b.season || ""), teamId = Number(b.teamId), sp = Number(b.sp);
  if (!/^\d{1,12}$/.test(lid) || !/^\d{4}$/.test(season) || !(teamId > 0) || !(sp > 0)) return out({ error: "Bad lineup request" }, 400);
  const SLOTS = new Set([0, 2, 3, 4, 5, 6, 7, 16, 17, 20, 23]);
  const items = (Array.isArray(b.items) ? b.items : []).slice(0, 40).map(x => ({ playerId: Number(x.playerId), type: "LINEUP", fromLineupSlotId: Number(x.from), toLineupSlotId: Number(x.to) }))
    .filter(x => x.playerId > 0 && SLOTS.has(x.fromLineupSlotId) && SLOTS.has(x.toLineupSlotId) && x.fromLineupSlotId !== x.toLineupSlotId);
  if (!items.length) return out({ error: "No changes to make." }, 400);
  const body = { isLeagueManager: false, teamId, type: "ROSTER", memberId: swid.replace(/[\r\n]/g, ""), scoringPeriodId: sp, executionType: "EXECUTE", items };
  const r = await fetch("https://lm-api-writes.fantasy.espn.com/apis/v3/games/ffl/seasons/" + season + "/segments/0/leagues/" + lid + "/transactions/", {
    method: "POST", headers: { "content-type": "application/json", "Accept": "application/json", "User-Agent": UA["User-Agent"], Cookie: "espn_s2=" + s2.replace(/[;\r\n]/g, "") + "; SWID=" + swid.replace(/[;\r\n]/g, "") }, body: JSON.stringify(body) });
  const text = await r.text(); let j = {}; try { j = JSON.parse(text); } catch (e) {}
  if (r.ok && (!j.status || /EXECUTED|PENDING/.test(j.status))) return out({ ok: true, status: j.status || "EXECUTED", moved: items.length });
  const code = (((j.details || [])[0] || {}).type) || j.messages && j.messages[0] || (text.match(/TRAN_[A-Z_]+|AUTH_[A-Z_]+/) || [])[0] || "";
  return out({ error: ESPN_LINEUP_ERR[code] || "ESPN said no (" + r.status + (code ? " " + code : "") + ").", code }, r.status === 401 ? 401 : 409);
}

// MyFantasyLeague: sign in once (the password goes to MFL and is never stored), then import the starters list.
const mflHostOk = h => /^https:\/\/(www\d*|api)\.myfantasyleague\.com$/.test(h);
export async function mflLoginRoute(request) {
  if (request.method !== "POST") return out({ error: "POST only" }, 405);
  const b = await request.json().catch(() => ({}));
  const year = String(b.year || ""), user = String(b.username || "").slice(0, 80), pass = String(b.password || "").slice(0, 120);
  if (!/^\d{4}$/.test(year) || !user || !pass) return out({ error: "Enter your MyFantasyLeague username and password." }, 400);
  const r = await fetch("https://api.myfantasyleague.com/" + year + "/login?USERNAME=" + encodeURIComponent(user) + "&PASSWORD=" + encodeURIComponent(pass) + "&XML=1", { headers: { "User-Agent": UA["User-Agent"] } });
  const t = await r.text();
  const m = t.match(/MFL_USER_ID="([^"]+)"/) || t.match(/cookie_value="([^"]+)"/);
  if (!m) return out({ error: /invalid|incorrect|error/i.test(t) ? "MyFantasyLeague didn’t accept that username and password." : "MyFantasyLeague sign-in failed (" + r.status + ")." }, 401);
  return out({ ok: true, cookie: m[1] });
}
export async function mflLineupRoute(request) {
  if (request.method !== "POST") return out({ error: "POST only" }, 405);
  const b = await request.json().catch(() => ({}));
  const year = String(b.year || ""), L = String(b.L || ""), W = String(b.W || ""), host = String(b.host || "https://api.myfantasyleague.com").replace(/\/+$/, "");
  const cookie = request.headers.get("x-mfl-cookie") || "";
  const starters = (Array.isArray(b.starters) ? b.starters : []).map(String).filter(x => /^\d{1,6}$/.test(x)).slice(0, 40);
  if (!/^\d{4}$/.test(year) || !/^\d{1,8}$/.test(L) || !/^\d{1,2}$/.test(W) || !mflHostOk(host)) return out({ error: "Bad lineup request" }, 400);
  if (!cookie) return out({ error: "Sign in to MyFantasyLeague first.", login: true }, 401);
  if (!starters.length) return out({ error: "No starters to set." }, 400);
  const u = host + "/" + year + "/import?TYPE=lineup&L=" + L + "&W=" + W + "&STARTERS=" + starters.join(",") + "&XML=1";
  let r = await fetch(u, { headers: { "User-Agent": UA["User-Agent"], Cookie: "MFL_USER_ID=" + cookie.replace(/[;\r\n]/g, "") }, redirect: "manual" });
  if (r.status >= 300 && r.status < 400 && r.headers.get("location")) {
    const loc = new URL(r.headers.get("location"), u);
    if (!mflHostOk(loc.origin)) return out({ error: "MyFantasyLeague redirected somewhere unexpected." }, 502);
    r = await fetch(loc.toString(), { headers: { "User-Agent": UA["User-Agent"], Cookie: "MFL_USER_ID=" + cookie.replace(/[;\r\n]/g, "") } });
  }
  const t = await r.text();
  if (/<status>\s*OK\s*<\/status>|"status"\s*:\s*"OK"/i.test(t)) return out({ ok: true });
  const err = (t.match(/<error[^>]*>([\s\S]*?)<\/error>/i) || [])[1] || t.replace(/<[^>]+>/g, " ").trim().slice(0, 160);
  return out({ error: /login|cookie|not logged|permission/i.test(err) ? "MyFantasyLeague needs you to sign in again." : "MyFantasyLeague said: " + err, login: /login|cookie|not logged/i.test(err) }, r.ok ? 409 : r.status);
}

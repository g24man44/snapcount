// Snap Count — one Cloudflare Worker that serves the app and fetches live league data.
// Paste this whole file into a new Cloudflare Worker and deploy. Free plan is fine.

import { alertsRoute, runMinute, staticRoute, injuriesRoute, readInjuries } from "./src/alerts.js";
import { PROSPECTS } from "./src/prospects.js";
import { gameWeather } from "./src/weather.js";
import { ttsRoute, marketRoute, pickemRoute, syncRoute, transcribeRoute, espnRoute, mflRoute, scoresRoute, calendarRoute, coachRoute, hookPostRoute, espnLineupRoute, mflLoginRoute, mflLineupRoute } from "./src/more.js";

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
// Snap Count value: a blend of three independent views, so no single source's quirks drive a trade.
//  - Market: FantasyCalc, built from real trades in thousands of leagues like this one.
//  - Experts: DynastyProcess's feed of FantasyPros expert consensus rankings (dynasty only).
//  - Production: this season's points per game above a replacement starter at his position for
//    this league size, aged forward for dynasty.
// The other two are put on the market's scale by rank (the Nth best by experts gets the market's
// Nth best value), then blended. Row: [value, overallRank, posRank, trend30, name, pos, age, redraft,
// market, experts, production, ppg, games].
const nkey = s => String(s || "").toLowerCase().replace(/\b(jr|sr|ii|iii|iv|v)\b\.?/g, "").replace(/[^a-z]/g, "");
function csvRows(text) {
  const lines = text.split(/\r?\n/).filter(Boolean), head = lines.shift().split(",").map(h => h.replace(/"/g, ""));
  return lines.map(l => { const c = l.match(/("([^"]|"")*"|[^,]*)(,|$)/g).map(x => x.replace(/,$/, "").replace(/^"|"$/g, "")); const o = {}; head.forEach((h, i) => o[h] = c[i]); return o; });
}
function ageCurve(pos, age) {
  if (!age) return 1;
  const peak = { QB: 30, RB: 25, WR: 27, TE: 28 }[pos] || 27, drop = { QB: 0.04, RB: 0.12, WR: 0.07, TE: 0.07 }[pos] || 0.07;
  return age <= peak ? 1 + Math.min(0.15, (peak - age) * 0.03) : Math.max(0.3, 1 - (age - peak) * drop);
}
async function tradeValues(ppr, teams, qbs, dyn, realTeams, env) {
  const url = "https://api.fantasycalc.com/values/current?isDynasty=" + (dyn ? "true" : "false") + "&numQbs=" + qbs + "&numTeams=" + teams + "&ppr=" + ppr;
  const now = new Date(), season = now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const fmtKey = ppr + "/" + (realTeams || teams) + "/" + qbs + "/" + (dyn ? 1 : 0);
  const day = d => new Date(Date.now() - d * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const [inj, snap1, snap7] = await Promise.all([
    readInjuries().catch(() => ({})),
    env && env.SNAP ? env.SNAP.get("vsnap:" + fmtKey + ":" + day(1), "json").catch(() => null) : null,
    env && env.SNAP ? env.SNAP.get("vsnap:" + fmtKey + ":" + day(7), "json").catch(() => null) : null
  ]);
  const [r, dpText, stats] = await Promise.all([
    fetch(url, { headers: UA }),
    dyn ? fetch("https://raw.githubusercontent.com/dynastyprocess/data/master/files/values-players.csv", { headers: { "User-Agent": UA["User-Agent"] } }).then(x => x.ok ? x.text() : "").catch(() => "") : Promise.resolve(""),
    fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season, { headers: UA }).then(x => x.ok ? x.json() : {}).catch(() => ({}))
  ]);
  if (!r.ok) return json({ error: "FantasyCalc answered " + r.status }, 502, 0);
  // Recent role matters most: pull the last 4 weeks so a new starter (or a benched one) shows up now.
  const st = await fetch("https://api.sleeper.app/v1/state/nfl", { headers: UA }).then(x => x.ok ? x.json() : {}).catch(() => ({}));
  const lastWk = Math.max(0, (Number(st.week) || 0) - (st.season_type === "regular" ? 1 : 0));
  const recentWeeks = [];
  for (let w = lastWk; w >= 1 && recentWeeks.length < 4; w--) recentWeeks.push(w);
  const weekly = await Promise.all(recentWeeks.map(w => fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season + "/" + w, { headers: UA }).then(x => x.ok ? x.json() : {}).catch(() => ({}))));
  const arr = await r.json();
  const rows = [], picks = [];
  for (const x of Array.isArray(arr) ? arr : []) {
    const p = x.player || {};
    const row = [Math.round(x.value || 0), x.overallRank || null, x.positionRank || null, Math.round(x.trend30Day || 0), p.name || "", p.position || "", p.maybeAge ? Math.round(p.maybeAge * 10) / 10 : null, Math.round(x.redraftValue || 0)];
    if (p.position === "PICK") { if (p.name) picks.push(["pick:" + p.name, row]); continue; }
    rows.push({ fc: p.id || null, row, sid: p.sleeperId, fid: p.fleaflickerId, pos: p.position, age: p.maybeAge, team: p.maybeTeam || null, key: nkey(p.name) + "|" + p.position, market: row[0], freq: x.maybeTradeFrequency || 0 });
  }
  if (!rows.length) return json({ error: "FantasyCalc returned no players" }, 502, 0);
  const scale = rows.map(x => x.market).sort((a, b) => b - a);
  const mapByRank = (list, getScore, setter) => {
    const xs = list.filter(x => getScore(x) != null).sort((a, b) => getScore(b) - getScore(a));
    xs.forEach((x, i) => setter(x, scale[Math.min(i, scale.length - 1)]));
  };
  // Experts
  let haveExperts = false;
  if (dpText) {
    const dp = {}; for (const o of csvRows(dpText)) { const v = Number(qbs === 2 ? o.value_2qb : o.value_1qb); if (o.player && v > 0) dp[nkey(o.player) + "|" + o.pos] = v; }
    rows.forEach(x => { x.dp = dp[x.key] != null ? dp[x.key] : null; });
    haveExperts = rows.some(x => x.dp != null);
    mapByRank(rows, x => x.dp, (x, v) => x.experts = v);
  }
  // Production: points per game over a replacement-level starter, for this league size and scoring.
  const col = ppr === "1" ? "pts_ppr" : ppr === "0.5" ? "pts_half_ppr" : "pts_std";
  const T = realTeams || teams, repRank = { QB: Math.round(T * (qbs === 2 ? 2 : 1.1)), RB: Math.round(T * 2.4), WR: Math.round(T * 3), TE: Math.round(T * 1.2) };
  const byPos = {};
  rows.forEach(x => {
    const s = (x.sid && stats[x.sid]) || null, gp = s ? (s.gp || s.gms_active || 0) : 0;
    x.gp = gp; x.ppg = gp ? (s[col] || 0) / gp : null;
    // Per-game catches and carries let the app price TE premium and per-carry scoring.
    x.rpg = gp ? Math.round((s.rec || 0) / gp * 10) / 10 : null; x.cpg = gp ? Math.round((s.rush_att || 0) / gp * 10) / 10 : null;
    x.tdpg = gp ? Math.round((s.pass_td || 0) / gp * 100) / 100 : null;
    // Last 4 weeks he actually played (counts only games with real snaps).
    const rec = weekly.map(wk => (x.sid && wk[x.sid]) || null).filter(w => w && (w.off_snp || 0) >= 5);
    if (rec.length >= 2 && x.ppg != null) { x.recent = rec.reduce((a, w) => a + (w[col] || 0), 0) / rec.length; x.ppg = 0.6 * x.recent + 0.4 * x.ppg; }
    if (x.ppg != null && gp >= 3 && repRank[x.pos]) (byPos[x.pos] = byPos[x.pos] || []).push(x.ppg);
  });
  const rep = {}; for (const pos in byPos) { const a = byPos[pos].sort((p, q) => q - p); rep[pos] = a[Math.min(repRank[pos], a.length - 1)] || 0; }
  rows.forEach(x => { if (x.ppg != null && x.gp >= 3 && rep[x.pos] != null) x.vorp = (x.ppg - rep[x.pos]) * (dyn ? (0.55 + 0.45 * ageCurve(x.pos, x.age ? x.age + 1 : null)) : 1); });
  mapByRank(rows, x => x.vorp != null ? x.vorp : null, (x, v) => x.production = v);
  // Blend: in-season production matters more for redraft.
  const W = dyn ? { market: 0.5, experts: 0.25, production: 0.25 } : { market: 0.6, experts: 0, production: 0.4 };
  // Today's injury report: a season-ending injury hurts a redraft value far more than a dynasty one.
  // The market often lags the news by a day or two, so this keeps values honest in the meantime.
  const seasonEnd = (i) => /injured reserve|season/i.test(i.status + " " + i.short + " " + i.long) && !(i.ret && new Date(i.ret) < new Date(new Date().getFullYear() + "-12-20"));
  rows.forEach(x => {
    const i = inj[nkey(x.row[4]) + "|" + x.pos] || inj[String(x.row[4] || "").toLowerCase().replace(/[^a-z]/g, "") + "|" + x.pos];
    if (!i || /^active$/i.test(String(i.status || "").trim()) || !i.status) return;
    const st = String(i.status || "");
    let f = 1, tag = st;
    if (seasonEnd(i)) { f = dyn ? 0.94 : 0.45; tag = /injured reserve/i.test(st) ? "IR" : st; }
    else if (/out/i.test(st)) f = dyn ? 0.99 : 0.94;
    else if (/doubtful/i.test(st)) f = dyn ? 1 : 0.97;
    x.injF = f; x.inj = tag + (i.part ? " (" + i.part + ")" : "");
  });
  const out = {};
  for (const x of rows) {
    let sum = W.market * x.market, w = W.market;
    if (x.experts != null && W.experts) { sum += W.experts * x.experts; w += W.experts; }
    if (x.production != null) { sum += W.production * x.production; w += W.production; }
    const row = x.row.slice();
    row[0] = Math.round(sum / w * (x.injF || 1));
    row.push(x.market, x.experts != null ? Math.round(x.experts) : null, x.production != null ? Math.round(x.production) : null, x.ppg != null ? Math.round(x.ppg * 10) / 10 : null, x.gp || 0, x.recent != null ? Math.round(x.recent * 10) / 10 : null, null, x.team, x.inj || null);
    row[23] = x.fc;
    row[19] = x.rpg != null ? x.rpg : null; row[20] = x.cpg != null ? x.cpg : null; row[21] = x.tdpg != null ? x.tdpg : null; row[22] = Math.round((x.freq || 0) * 10000) / 10000;
    if (x.sid) out[x.sid] = row;
    if (x.fid) out["f" + x.fid] = row;
  }
  // Re-rank on the blended value.
  const uniq = rows.map(x => out[x.sid] || out["f" + x.fid]).filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).sort((a, b) => b[0] - a[0]);
  const pr = {}; uniq.forEach((row, i) => { row[1] = i + 1; pr[row[5]] = (pr[row[5]] || 0) + 1; row[2] = pr[row[5]]; });
  for (const [k, row] of picks) out[k] = row;
  smoothPicks(out);
  // Day-over-day and week-over-week change, from the daily snapshots.
  if (snap1 || snap7) uniq.forEach(row => {
    const id = rows.find(x => (out[x.sid] || out["f" + x.fid]) === row); if (!id) return;
    const k = id.sid || "f" + id.fid;
    const sv = x => Array.isArray(x) ? x[0] : x;
    row[17] = snap1 && snap1[k] != null ? row[0] - sv(snap1[k]) : null;
    row[18] = snap7 && snap7[k] != null ? row[0] - sv(snap7[k]) : null;
  });
  return json({ source: "Snap Count value", asOf: new Date().toISOString(), fmt: fmtKey, hasDaily: !!(snap1 || snap7), blend: { market: "FantasyCalc", experts: haveExperts ? "FantasyPros consensus via DynastyProcess" : null, production: "Sleeper season stats" }, weights: W, ppr, teams, qbs, dynasty: !!dyn, values: out }, 200, 10800);
}

// IDP (defensive players): no public trade market exists, so values come from production —
// Sleeper's standard IDP scoring per game over a replacement starter, aged for dynasty — placed on the
// same scale as offense: the best defender is worth about what the ~60th best offensive asset is.
const IDP_GROUP = { DL: "DL", DE: "DL", DT: "DL", LB: "LB", ILB: "LB", OLB: "LB", DB: "DB", CB: "DB", S: "DB", SS: "DB", FS: "DB" };
async function idpValues(teams, dyn, scaleFrom) {
  const now = new Date(), season = now.getUTCMonth() < 2 ? now.getUTCFullYear() - 1 : now.getUTCFullYear();
  const [pl, st] = await Promise.all([
    fetch("https://api.sleeper.app/v1/players/nfl", { headers: UA }).then(x => x.json()),
    fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season, { headers: UA }).then(x => x.ok ? x.json() : {}).catch(() => ({}))
  ]);
  const rows = [];
  for (const id in st) {
    const p = pl[id], s = st[id]; if (!p) continue;
    const g = IDP_GROUP[p.position] || IDP_GROUP[(p.fantasy_positions || [])[0]]; if (!g) continue;
    const gp = s.gp || 0; if (gp < 3 || !s.pts_idp) continue;
    rows.push({ id, name: p.full_name || "", g, pos: p.position, team: p.team || "", age: p.age || null, ppg: s.pts_idp / gp, gp });
  }
  const rep = {}, T = teams;
  for (const g of ["DL", "LB", "DB"]) { const a = rows.filter(r => r.g === g).map(r => r.ppg).sort((x, y) => y - x); rep[g] = a[Math.min(a.length - 1, Math.round(T * (g === "DB" ? 3 : 2.5)))] || 0; }
  const peak = { DL: 27, LB: 26, DB: 26 };
  rows.forEach(r => { const af = !dyn || !r.age ? 1 : r.age <= peak[r.g] ? 1 + Math.min(0.12, (peak[r.g] - r.age) * 0.03) : Math.max(0.35, 1 - (r.age - peak[r.g]) * 0.09); r.vorp = Math.max(0, r.ppg - rep[r.g]) * af; });
  rows.sort((a, b) => b.vorp - a.vorp);
  const out = {};
  rows.forEach((r, i) => {
    const v = r.vorp > 0 ? Math.round(scaleFrom[Math.min(scaleFrom.length - 1, 60 + Math.round(i * 2.2))] || 0) : Math.round(80 * Math.max(0, r.ppg / Math.max(1, rep[r.g])));
    out[r.id] = [v, null, null, 0, r.name, r.g, r.age, v, null, null, v, Math.round(r.ppg * 10) / 10, r.gp, null, null, r.team, null];
  });
  const pr = {}; Object.values(out).sort((a, b) => b[0] - a[0]).forEach((row, i) => { row[1] = i + 1; pr[row[5]] = (pr[row[5]] || 0) + 1; row[2] = pr[row[5]]; });
  return json({ values: out, season, note: "IDP values are production-based estimates." }, 200, 10800);
}

// Snap Count pick values. FantasyCalc's pick prices are the base, with three fixes:
// 1) a pick with no projected slot is worth the average of its Early/Mid/Late prices (the market's plain price runs low);
// 2) later years blend the market (thin: few trades that far out) half-and-half with a steady 15%-a-year discount
//    from the nearest year with full prices, so far-out picks don't fall off a cliff on thin trading;
// 3) later years get Early/Mid/Late too, with the gap between them shrinking each year out, since a pick's slot
//    gets harder to predict the further away the draft is.
function smoothPicks(out) {
  const R = ["1st", "2nd", "3rd", "4th", "5th"], T = ["Early", "Mid", "Late"];
  const years = [...new Set(Object.keys(out).filter(k => k.startsWith("pick:")).map(k => +k.slice(5, 9)))].sort();
  if (!years.length) return;
  const get = k => out[k] && out[k][0], mk = (base, v) => { const r = base.slice(); r[0] = r[7] = Math.round(v); return r; };
  const baseY = years.find(y => T.every(t => get("pick:" + y + " 1st (" + t + ")"))) || years[0];
  for (const rd of R) {
    const tiers = T.map(t => get("pick:" + baseY + " " + rd + " (" + t + ")"));
    const avg = tiers.every(Boolean) ? tiers.reduce((a, b) => a + b, 0) / 3 : get("pick:" + baseY + " " + rd);
    if (!avg) continue;
    const plainK = "pick:" + baseY + " " + rd; if (out[plainK] && tiers.every(Boolean)) out[plainK] = mk(out[plainK], avg);
    for (const y of years) {
      if (y <= baseY) continue;
      const n = y - baseY, k = "pick:" + y + " " + rd, row = out[k]; if (!row) continue;
      const model = avg * Math.pow(0.85, n), v = 0.5 * (row[0] || model) + 0.5 * model;
      out[k] = mk(row, v);
      if (tiers.every(Boolean)) T.forEach((t, i) => { const spread = (tiers[i] / avg - 1) * Math.pow(0.6, n); out[k + " (" + t + ")"] = mk(row, v * (1 + spread)); });
    }
  }
}

// One player's story: daily market price over the season (FantasyCalc), Snap Count's own daily values
// (our snapshots), and his most recent real trades with what he was worth in each.
async function playerHistory(env, fc, fmt, sid, dyn, qbs, teams, ppr) {
  const q = "?isDynasty=" + (dyn ? "true" : "false") + "&numQbs=" + qbs + "&numTeams=" + teams + "&ppr=" + ppr;
  const fcData = fc ? await fetch("https://api.fantasycalc.com/trades/implied/" + fc + q, { headers: UA }).then(r => r.ok ? r.json() : {}).catch(() => ({})) : {};
  const md = s => { const [m, d, y] = String(s).split("/"); return y + "-" + m + "-" + d; };
  const market = (fcData.historicalValues || []).map(h => [md(h.date), h.value]).filter(x => x[0] >= new Date(Date.now() - 200 * 864e5).toISOString().slice(0, 10));
  const trades = (fcData.impliedValues || []).slice().sort((a, b) => md(b.date) < md(a.date) ? -1 : 1).slice(0, 12)
    .map(t => ({ date: md(t.date), value: t.value, a: String(t.side1 || "").replace(/<br>/g, " "), b: String(t.side2 || "").replace(/<br>/g, " ") }));
  const ours = [];
  if (env.SNAP && sid && /^[\d./]+$/.test(fmt)) {
    const days = Array.from({ length: 30 }, (_, i) => new Date(Date.now() - i * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
    const got = await Promise.all(days.map(d => env.SNAP.get("vsnap:" + fmt + ":" + d, "json").catch(() => null)));
    got.forEach((snap, i) => { const x = snap && snap[sid]; if (x != null) ours.push([days[i], Array.isArray(x) ? x[0] : x]); });
    ours.reverse();
  }
  return json({ market, ours, trades }, 200, 21600);
}

// How right were the values? Take a saved daily snapshot from at least a week ago and check
// (1) whether players valued higher went on to score more in the NFL weeks since, against the simple
//     guess of "same points per game as before", and
// (2) where Snap Count disagreed with the trade market by 10% or more, whether the price then moved our way.
function spearman(xs, ys) {
  const rk = a => { const idx = a.map((v, i) => [v, i]).sort((p, q) => p[0] - q[0]), r = new Array(a.length); idx.forEach(([, i], j) => r[i] = j); return r; };
  const n = xs.length; if (n < 5) return null; const rx = rk(xs), ry = rk(ys); let d = 0; for (let i = 0; i < n; i++) d += (rx[i] - ry[i]) ** 2; return 1 - 6 * d / (n * (n * n - 1));
}
async function accuracy(env, fmt) {
  const st = await fetch("https://api.sleeper.app/v1/state/nfl", { headers: UA }).then(r => r.json());
  const season = st.league_season || st.season, start = new Date((st.season_start_date || season + "-09-09") + "T12:00:00Z");
  const lastDone = st.season_type === "regular" ? (Number(st.week) || 1) - 1 : 18;
  // Snapshots from 7 to 45 days ago; use the oldest one that has finished NFL weeks after it.
  const days = Array.from({ length: 39 }, (_, i) => new Date(Date.now() - (45 - i) * 864e5).toLocaleDateString("en-CA", { timeZone: "America/New_York" }));
  let snapDay = null, snap = null;
  for (const d of days) { const x = await env.SNAP.get("vsnap:" + fmt + ":" + d, "json").catch(() => null); if (x) { snapDay = d; snap = x; break; } }
  if (!snap) return json({ ready: false, reason: "no-snapshot", fmt }, 200, 3600);
  const weekOf = d => Math.floor((new Date(d + "T12:00:00Z") - start) / (7 * 864e5)) + 1;
  const firstAfter = weekOf(snapDay) + 1, after = []; for (let w = firstAfter; w <= lastDone; w++) after.push(w);
  if (!after.length) return json({ ready: false, reason: "no-weeks", since: snapDay, firstAfter, fmt }, 200, 3600);
  const ppr = fmt.split("/")[0], col = ppr === "1" ? "pts_ppr" : ppr === "0.5" ? "pts_half_ppr" : "pts_std";
  const [seasonSt, ...weekly] = await Promise.all([fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season, { headers: UA }).then(r => r.json())].concat(after.map(w => fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season + "/" + w, { headers: UA }).then(r => r.json()).catch(() => ({})))));
  const pl = await fetch("https://api.sleeper.app/v1/players/nfl", { headers: UA }).then(r => r.json()).catch(() => ({}));
  const res = {}, groups = { QB: 32, RB: 48, WR: 60, TE: 24 };
  for (const pos of Object.keys(groups)) {
    const rows = Object.keys(snap).filter(k => pl[k] && pl[k].position === pos).map(k => {
      const v = Array.isArray(snap[k]) ? snap[k][0] : snap[k];
      let pa = 0, ga = 0; weekly.forEach(wk => { const s = wk[k]; if (s && (s.off_snp || 0) >= 5) { pa += s[col] || 0; ga++; } });
      const s = seasonSt[k] || {}, gT = s.gp || 0, before = gT - ga >= 2 ? ((s[col] || 0) - pa) / (gT - ga) : null;
      return { k, v, after: ga ? pa / ga : null, before };
    }).sort((a, b) => b.v - a.v).slice(0, groups[pos]).filter(r => r.after != null && r.before != null);
    res[pos] = { n: rows.length, ours: spearman(rows.map(r => r.v), rows.map(r => r.after)), naive: spearman(rows.map(r => r.before), rows.map(r => r.after)) };
  }
  // Market test (snapshots saved with the market price, from mid-November 2026 on).
  let market = null;
  const withMkt = Object.keys(snap).filter(k => Array.isArray(snap[k]) && snap[k][1]);
  if (withMkt.length) {
    const [p2, t2, q2, d2] = fmt.split("/"), t = Number(t2), cur = await tradeValues(p2, t <= 11 ? 10 : t <= 13 ? 12 : 14, Number(q2), d2 === "1", t, env).then(r => r.json()).catch(() => ({ values: {} }));
    let calls = 0, right = 0;
    withMkt.forEach(k => { const [ours, mk] = snap[k], now = cur.values && cur.values[k] && cur.values[k][8]; if (!now || mk < 800) return; const lean = (ours - mk) / mk; if (Math.abs(lean) < 0.1) return; const moved = now - mk; if (Math.abs(moved) < mk * 0.02) return; calls++; if (Math.sign(moved) === Math.sign(lean)) right++; });
    market = { calls, right };
  }
  return json({ ready: true, since: snapDay, weeks: after, fmt, production: res, market }, 200, 43200);
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

// One week of box scores for every offensive player, kicker and defense: { season, week, players: { sleeperId: [
//   ppr, half, std, played, snap%, targets, rec, recYd, recTd, rushAtt, rushYd, rushTd, cmp, att, passYd, passTd, int, rank ppr, rank half, rank std ] } }.
async function weekStats(season, week) {
  const r = await fetch("https://api.sleeper.app/v1/stats/nfl/regular/" + season + "/" + week, { headers: UA });
  if (!r.ok) return json({ error: "Stats unavailable for week " + week + " (" + r.status + ")" }, 502, 0);
  const all = await r.json(), out = {};
  const n = v => Math.round((Number(v) || 0) * 100) / 100, rk = v => v && v < 999 ? v : null;
  for (const id in all) {
    const s = all[id] || {};
    if (s.pts_ppr == null && !s.off_snp) continue;
    const played = s.gp || s.off_snp ? 1 : 0;
    out[id] = [n(s.pts_ppr), n(s.pts_half_ppr ?? s.pts_ppr), n(s.pts_std ?? s.pts_ppr), played,
      s.tm_off_snp && s.off_snp ? Math.round(s.off_snp / s.tm_off_snp * 100) : null,
      s.rec_tgt || 0, s.rec || 0, s.rec_yd || 0, s.rec_td || 0, s.rush_att || 0, s.rush_yd || 0, s.rush_td || 0,
      s.pass_cmp || 0, s.pass_att || 0, s.pass_yd || 0, s.pass_td || 0, s.pass_int || 0,
      rk(s.pos_rank_ppr), rk(s.pos_rank_half_ppr), rk(s.pos_rank_std)];
  }
  return json({ season: Number(season), week: Number(week), players: out }, 200, 1800);
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

// Formats people actually use, so the daily job knows what to refresh.
async function noteValueFormat(env, fmt) {
  if (!env.SNAP) return;
  const m = (await env.SNAP.get("vfmts", "json").catch(() => null)) || {};
  const today = new Date().toISOString().slice(0, 10);
  if (m[fmt] === today) return;
  m[fmt] = today;
  for (const k of Object.keys(m)) if (Date.now() - Date.parse(m[k]) > 21 * 864e5) delete m[k];
  await env.SNAP.put("vfmts", JSON.stringify(m));
}
// Every morning at 5:11 AM Eastern: recompute values for every format in use, save a snapshot
// (for "today" and "this week" changes), and put the fresh numbers in the edge cache.
export async function dailyValues(env, force) {
  const now = new Date();
  if (!force && !(now.getUTCHours() === 10 && now.getUTCMinutes() === 11)) return { skipped: true };
  if (!env.SNAP) return { error: "no KV" };
  const m = (await env.SNAP.get("vfmts", "json").catch(() => null)) || { "1/16/2/1": "x", "1/12/1/0": "x", "1/12/2/1": "x" };
  const day = now.toLocaleDateString("en-CA", { timeZone: "America/New_York" });
  const done = [];
  for (const fmt of Object.keys(m).slice(0, 10)) {
    const [ppr, real, qbs, dyn] = fmt.split("/"), t = Number(real), teams = t <= 11 ? 10 : t <= 13 ? 12 : 14;
    try {
      const res = await tradeValues(ppr, teams, Number(qbs), dyn === "1", t, env);
      if (res.status !== 200) continue;
      const body = await res.clone().json(), snap = {};
      // [Snap Count value, trade-market price]: the market half lets the accuracy report check later whether prices moved our way.
      for (const k in body.values) if (k[0] !== "f" && !k.startsWith("pick:")) snap[k] = [body.values[k][0], body.values[k][8]];
      await env.SNAP.put("vsnap:" + fmt + ":" + day, JSON.stringify(snap), { expirationTtl: 45 * 864e5 / 1000 });
      const copy = new Response(res.body, res); copy.headers.set("cache-control", "public, max-age=10800");
      await caches.default.put(new Request("https://snapcount.cache/values12/" + fmt), copy);
      done.push(fmt);
    } catch (e) {}
  }
  return { day, done };
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
      if (p === "/api/tts") return ttsRoute(request, env);
      if (p === "/api/market") return marketRoute(request, url, env);
      if (p === "/api/pickem") return pickemRoute(request, url, env);
      if (p === "/api/sync") return syncRoute(request, url, env);
      if (p === "/api/prospects") return json(PROSPECTS, 200, 3600);
      if (p === "/api/transcribe") return transcribeRoute(request, env);
      if (p === "/api/hookpost") return hookPostRoute(request);
      if (p === "/api/espn-lineup") return espnLineupRoute(request);
      if (p === "/api/mfl-login") return mflLoginRoute(request);
      if (p === "/api/mfl-lineup") return mflLineupRoute(request);
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
      if (p === "/api/weather") return cached(ctx, "weather1", 1800, async () => { const w = await gameWeather(); return json(w, w.source || !w.games.some(g => !g.indoor) ? 200 : 203, w.source ? 1800 : 60); }); // 203 = forecast missing, not cached
      if (p === "/api/sstats") {
        const season = url.searchParams.get("season") || "";
        if (!/^\d{4}$/.test(season)) return json({ error: "Bad season" }, 400, 0);
        return cached(ctx, "sstats/" + season, 1800, () => seasonStats(season));
      }
      if (p === "/api/values/refresh") {
        const last = Number(await env.SNAP.get("vref").catch(() => 0)) || 0;
        if (Date.now() - last < 15 * 60000) return json({ error: "Values were refreshed in the last 15 minutes." }, 429, 0);
        await env.SNAP.put("vref", String(Date.now()));
        return json(await dailyValues(env, true), 200, 0);
      }
      if (p === "/api/values") {
        const ppr = ["0", "0.5", "1"].includes(url.searchParams.get("ppr")) ? url.searchParams.get("ppr") : "1";
        const t = Number(url.searchParams.get("teams")) || 12, teams = t <= 11 ? 10 : t <= 13 ? 12 : 14;
        const qbs = url.searchParams.get("qbs") === "2" ? 2 : 1;
        const dyn = url.searchParams.get("dyn") === "1";
        const real = Math.min(32, Math.max(4, t));
        ctx.waitUntil(noteValueFormat(env, ppr + "/" + real + "/" + qbs + "/" + (dyn ? 1 : 0)));
        return cached(ctx, "values12/" + ppr + "/" + real + "/" + qbs + "/" + (dyn ? 1 : 0), 10800, () => tradeValues(ppr, teams, qbs, dyn, real, env));
      }
      if (p === "/api/phist") {
        const fc = /^\d{1,7}$/.test(url.searchParams.get("fc") || "") ? url.searchParams.get("fc") : null, sid = /^[\w-]{1,20}$/.test(url.searchParams.get("sid") || "") ? url.searchParams.get("sid") : null;
        const ppr = ["0", "0.5", "1"].includes(url.searchParams.get("ppr")) ? url.searchParams.get("ppr") : "1", t = Math.min(32, Math.max(4, Number(url.searchParams.get("teams")) || 12));
        const qbs = url.searchParams.get("qbs") === "2" ? 2 : 1, dyn = url.searchParams.get("dyn") === "1", fmt = ppr + "/" + t + "/" + qbs + "/" + (dyn ? 1 : 0);
        return cached(ctx, "phist1/" + fmt + "/" + fc + "/" + sid, 21600, () => playerHistory(env, fc, fmt, sid, dyn, qbs, t <= 11 ? 10 : t <= 13 ? 12 : 14, ppr));
      }
      if (p === "/api/accuracy") {
        const ppr = ["0", "0.5", "1"].includes(url.searchParams.get("ppr")) ? url.searchParams.get("ppr") : "1", t = Math.min(32, Math.max(4, Number(url.searchParams.get("teams")) || 12));
        const qbs = url.searchParams.get("qbs") === "2" ? 2 : 1, dyn = url.searchParams.get("dyn") === "1";
        if (!env.SNAP) return json({ ready: false, reason: "no-storage" }, 200, 0);
        // Use this exact format's snapshots, or the nearest format that has them (same QBs and dynasty/redraft).
        let fmt = ppr + "/" + t + "/" + qbs + "/" + (dyn ? 1 : 0);
        const known = (await env.SNAP.get("vfmts", "json").catch(() => null)) || {};
        if (!known[fmt]) { const alt = Object.keys(known).filter(f => f.endsWith("/" + qbs + "/" + (dyn ? 1 : 0))).sort((a, b) => Math.abs(+a.split("/")[1] - t) - Math.abs(+b.split("/")[1] - t))[0]; if (alt) fmt = alt; }
        return cached(ctx, "acc1/" + fmt, 43200, () => accuracy(env, fmt));
      }
      if (p === "/api/idpvalues") {
        const t = Math.min(32, Math.max(4, Number(url.searchParams.get("teams")) || 12)), dyn = url.searchParams.get("dyn") === "1";
        return cached(ctx, "idp2/" + t + "/" + (dyn ? 1 : 0), 10800, async () => {
          // Borrow the offensive value curve so a defender's number means the same thing as a receiver's.
          const base = await tradeValues("1", t <= 11 ? 10 : t <= 13 ? 12 : 14, 1, dyn, t, env).then(r => r.json()).catch(() => ({ values: {} }));
          const scale = [...new Set(Object.entries(base.values || {}).filter(([k]) => !k.startsWith("pick:") && k[0] !== "f").map(([, r]) => r[0]))].sort((a, b) => b - a);
          return idpValues(t, dyn, scale.length ? scale : [6000]);
        });
      }
      if (p === "/api/wstats") {
        const season = url.searchParams.get("season") || "", week = Number(url.searchParams.get("week") || 0), fresh = url.searchParams.get("fresh") === "1";
        if (!/^\d{4}$/.test(season) || !(week >= 1 && week <= 18)) return json({ error: "Bad season or week" }, 400, 0);
        return cached(ctx, "wstats/" + season + "/" + week + "/" + (fresh ? 1 : 0), fresh ? 600 : 43200, () => weekStats(season, week));
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
    ctx.waitUntil(dailyValues(env).catch(() => {}));
  }
};

// Manager IQ: how close each lineup came to its best possible score (Fleaflicker reports the optimum in every box score).
// Finished weeks are computed once and kept in live state; a call fills at most 3 missing weeks (Workers free plan
// allows 50 outside requests per call), so the app asks again until the season is complete.
import { hotGet, hotPut } from "./alerts.js";
const UA = { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)", "Accept": "application/json" };
const FF = "https://www.fleaflicker.com/api/";
const val = x => x == null ? null : typeof x === "object" ? Number(x.value ?? x.formatted ?? 0) : Number(x);
const getJ = u => fetch(u, { headers: UA }).then(r => r.ok ? r.json() : null).catch(() => null);
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

async function weekIQ(lid, w) {
  const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid + "&scoring_period=" + w);
  const games = (sb && sb.games) || [];
  if (!games.length || !games.every(g => g.isFinalScore)) return null;
  const rows = {};
  await Promise.all(games.map(async g => {
    const b = await getJ(FF + "FetchLeagueBoxscore?sport=NFL&league_id=" + lid + "&fantasy_game_id=" + g.id + "&scoring_period=" + w);
    if (!b) return;
    [["away", b.pointsAway], ["home", b.pointsHome]].forEach(([k, p]) => {
      const t = (p || {}).total || {}, act = val(t.value) || 0, opt = val(t.optimum) || act, team = g[k] || {};
      rows[String(team.id)] = { name: team.name, act, opt, po: !!g.isPlayoffs, cons: !!g.isConsolation };
    });
  }));
  return Object.keys(rows).length ? rows : null;
}
export async function iqRoute(env, url) {
  const lid = url.searchParams.get("lid") || "";
  if (!/^\d{1,10}$/.test(lid)) return out({ error: "Bad league" }, 400);
  const sb = await getJ(FF + "FetchLeagueScoreboard?sport=NFL&league_id=" + lid);
  const W = Number(((sb || {}).schedulePeriod || {}).ordinal || 0); if (!W) return out({ error: "Couldn’t read the league" }, 502);
  const k = "iq:" + lid, st = (await hotGet(env, k)) || { weeks: {} };
  const want = []; for (let w = 1; w <= W; w++) if (!st.weeks[w]) want.push(w);
  let filled = 0;
  for (const w of want.slice(0, 3)) { const r = await weekIQ(lid, w); if (r) { st.weeks[w] = r; filled++; } }
  if (filled) await hotPut(env, k, st);
  const missing = want.slice(3).length + want.slice(0, 3).filter(w => !st.weeks[w]).filter(w => w < W).length;
  return out({ weeks: st.weeks, current: W, more: want.length > 3 });
}

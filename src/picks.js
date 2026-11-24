// Beat the Bot: everyone picks the winner of each fantasy matchup; Snap Count's model picks too.
// Picks lock when the NFL week's first game kicks off. Stored in live state (no KV writes).
import { hotGet, hotPut } from "./alerts.js";
import { asTeam } from "./claims.js";
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
async function locked(env, w) {
  if ((await hotGet(env, "picklock:" + w)) === true) return true;
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard?seasontype=2&week=" + w, { headers: { "User-Agent": "Mozilla/5.0 (SnapCount)" } }).catch(() => null);
  const d = r && r.ok ? await r.json().catch(() => null) : null;
  const on = !!(d && (d.events || []).some(e => (((e.competitions || [])[0] || {}).status || e.status || {}).type?.state !== "pre"));
  if (on) await hotPut(env, "picklock:" + w, true);
  return on;
}
export async function picksRoute(request, env, url) {
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad league" }, 400);
  const k = "picks:" + p + ":" + lid, all = (await hotGet(env, k)) || {};
  if (request.method === "GET") {
    const w = url.searchParams.get("w");
    return out({ weeks: all, locked: w && /^\d{1,2}$/.test(w) ? await locked(env, w) : null });
  }
  const b = await request.json().catch(() => ({}));
  const w = String(b.w || ""); if (!/^\d{1,2}$/.test(w)) return out({ error: "Bad week" }, 400);
  const who = await asTeam(env, p, lid, b.team, b.dev, b.teamName); if (who.error) return out({ error: who.error }, who.status);
  if (await locked(env, w)) return out({ error: "Picks locked when week " + w + "’s first game kicked off." }, 409);
  const W = all[w] = all[w] || { picks: {}, bot: null };
  const clean = o => Object.fromEntries(Object.entries(o || {}).slice(0, 20).filter(([g, t]) => /^[\w-]{1,40}$/.test(g) && /^[\w-]{1,40}$/.test(String(t))).map(([g, t]) => [g, String(t)]));
  W.picks[String(b.team)] = { n: who.name, g: clean(b.picks), at: Date.now() };
  if (!W.bot && b.bot) W.bot = { g: clean(b.bot.g), p: Object.fromEntries(Object.entries(b.bot.p || {}).slice(0, 20).map(([g, x]) => [g, Math.max(0, Math.min(1, Number(x) || 0.5))])) };
  Object.keys(all).map(Number).sort((a, c) => a - c).slice(0, -20).forEach(x => delete all[x]);
  await hotPut(env, k, all);
  return out({ ok: true });
}

// Highlight clips from the NFL's YouTube channel. Its feed lists only the newest 15 videos, so the minute cron
// checks it every 10 minutes and keeps four days of clips in live state (no KV writes).
import { hotGet, hotPut } from "./alerts.js";

const FEED = "https://www.youtube.com/feeds/videos.xml?channel_id=UCDVYQ4Zhbm3S2dlz7P1GBDg";
const KEEP_MS = 4 * 864e5;
const unxml = s => String(s || "").replace(/&amp;/g, "&").replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, "<").replace(/&gt;/g, ">");
async function readFeed() {
  const r = await fetch(FEED, { headers: { "User-Agent": "Mozilla/5.0 (SnapCount fantasy dashboard)" } }).catch(() => null);
  if (!r || !r.ok) return [];
  const xml = await r.text();
  return [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map(m => {
    const e = m[1], id = (e.match(/<yt:videoId>([^<]+)/) || [])[1], title = unxml((e.match(/<title>([^<]*)/) || [])[1]), t = Date.parse((e.match(/<published>([^<]+)/) || [])[1] || "");
    const desc = unxml((e.match(/<media:description>([\s\S]*?)<\/media:description>/) || [])[1] || "").slice(0, 300);
    return id && title ? { id, title, desc, t } : null;
  }).filter(Boolean);
}
export async function collectHighlights(env) {
  const fresh = await readFeed(); if (!fresh.length) return 0;
  const old = (await hotGet(env, "hl:yt")) || [], seen = new Set(old.map(x => x.id)), now = Date.now();
  const add = fresh.filter(x => !seen.has(x.id));
  const all = add.concat(old).filter(x => now - (x.t || now) < KEEP_MS).slice(0, 300);
  if (add.length || all.length !== old.length) await hotPut(env, "hl:yt", all);
  return add.length;
}
export async function highlightsRoute(env) {
  let list = (await hotGet(env, "hl:yt")) || [];
  if (!list.length) { await collectHighlights(env).catch(() => {}); list = (await hotGet(env, "hl:yt")) || []; }
  return new Response(JSON.stringify({ clips: list }), { headers: { "content-type": "application/json; charset=utf-8", "cache-control": "public, max-age=300" } });
}

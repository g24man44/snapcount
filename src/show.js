// The league show: a weekly two-host audio recap of one league, written from the league's real results and
// read by two free Cloudflare voices. Made once per league per week and shared by everyone in the league:
// the script is written in one request, then the phone asks for each spoken line in turn (so no single request
// runs too long), each line is stored once, and /api/show/mp3 plays the whole episode back as one file.
// Cost on the free plan: ~400 neurons for the script and ~1.4 per spoken character (~5,000 for an episode).

const okLid = (p, l) => ["flea", "sleeper", "espn", "mfl"].includes(p) && /^[A-Za-z0-9_-]{1,40}$/.test(l);
const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
export const HOSTS = { DEZ: { voice: "orion", name: "Dez" }, SAM: { voice: "luna", name: "Sam" } };
const SCRIPT_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];

const SHOW_SYS = `You write the script for "The Snap Count Show", a weekly fantasy football podcast about ONE private league, hosted by two friends:
- DEZ: numbers guy, dry and sarcastic, loves pointing out bench points left on the table.
- SAM: loud, funny, emotional, hot takes, defends the underdog, roasts the bad decisions.

Make it sound like a real podcast, not a report:
- Short turns (1 to 3 sentences). Hosts react to each other: "Oh come on.", "Wait, wait.", "Okay, fair.", laughter written as "Ha!", interruptions, disagreement, callbacks to earlier jokes.
- Contractions and casual speech. No lists, no headings, no stage directions, no sound effects, no emojis.
- Say numbers the way people talk ("one-forty-two" is fine, or "142 points").
- Use ONLY the facts in the league data. Never invent players, scores, trades or records. Team names exactly as given.
- Good-natured roasting only: about fantasy decisions, never about real people's lives.

Flow:
1. SAM opens: "This is The Snap Count Show, an AI-made recap of [league name], week [N]." Then quick banter.
2. Results: hit every matchup briefly, spend more time on the closest game, the biggest blowout and the highest score.
3. Blunder of the week: the worst lineup decision (most bench points left or worst starter).
4. Standings: who's rising, who's in trouble.
5. One spicy disagreement about who's the real contender.
6. Sign off with a joke.

Length: 600 to 750 words total.
Format: every line starts with DEZ: or SAM: and nothing else. No other text before or after.`;

const keyOf = (p, lid, w) => "show:" + p + ":" + lid + ":" + w;
function parseScript(text) {
  const lines = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const m = raw.replace(/\*\*/g, "").match(/^\s*(DEZ|SAM)\s*:\s*(.+)$/i);
    if (!m) { if (lines.length && raw.trim() && !/^\s*[\[(]/.test(raw)) lines[lines.length - 1].t += " " + raw.trim(); continue; }
    const t = m[2].replace(/\[[^\]]*\]|\([^)]*(laugh|music|sfx|pause)[^)]*\)/gi, "").replace(/[*_#`]/g, "").trim();
    if (t) lines.push({ s: m[1].toUpperCase(), t: t.slice(0, 600) });
  }
  // Merge back-to-back turns by the same host so each spoken part sounds continuous.
  const merged = [];
  lines.forEach(l => { const last = merged[merged.length - 1]; if (last && last.s === l.s && (last.t + " " + l.t).length < 600) last.t += " " + l.t; else merged.push(l); });
  return merged.slice(0, 60);
}

async function speak(env, line) {
  const voice = (HOSTS[line.s] || HOSTS.DEZ).voice;
  try {
    const r = await env.AI.run("@cf/deepgram/aura-1", { text: line.t, speaker: voice }, { returnRawResponse: true });
    if (r && r.ok !== false && r.body) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length > 500) return b; }
  } catch (e) {}
  // Out of free voice credit for today (or Aura down): the backup voice keeps the episode going.
  try {
    const r = await env.AI.run("@cf/myshell-ai/melotts", { prompt: line.t, lang: "en" });
    if (r instanceof ReadableStream) return new Uint8Array(await new Response(r).arrayBuffer());
    if (r && typeof r.audio === "string") { const bin = atob(r.audio), u = new Uint8Array(bin.length); for (let i = 0; i < bin.length; i++) u[i] = bin.charCodeAt(i); return u; }
  } catch (e) {}
  return null;
}

export async function showRoute(request, url, env, ctx, groupmeSay) {
  if (!env.SNAP || !env.AI) return out({ error: "The show isn't available on this server." }, 503);
  const path = url.pathname;
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "", w = String(url.searchParams.get("w") || "");
  if (!okLid(p, lid) || !/^\d{1,2}$/.test(w)) return out({ error: "Bad league or week" }, 400);
  const key = keyOf(p, lid, w);

  if (path === "/api/show/mp3") {
    const show = await env.SNAP.get(key, "json");
    if (!show) return new Response("No episode yet", { status: 404 });
    const parts = [];
    for (let i = 0; i < show.lines.length; i++) { const b = await env.SNAP.get(key + ":a" + i, "arrayBuffer"); if (b) parts.push(new Uint8Array(b)); }
    if (!parts.length) return new Response("Episode is still being recorded", { status: 404 });
    const total = parts.reduce((s, b) => s + b.length, 0), all = new Uint8Array(total); let o = 0; parts.forEach(b => { all.set(b, o); o += b.length; });
    const head = { "content-type": "audio/mpeg", "accept-ranges": "bytes", "cache-control": "public, max-age=300", "content-disposition": 'inline; filename="snap-count-show-week-' + w + '.mp3"' };
    // iPhones play audio with byte-range requests, so answer those with just the slice asked for.
    const m = (request.headers.get("range") || "").match(/^bytes=(\d*)-(\d*)$/);
    if (m && (m[1] || m[2])) {
      let start = m[1] ? Number(m[1]) : Math.max(0, total - Number(m[2])), end = m[1] && m[2] ? Math.min(Number(m[2]), total - 1) : total - 1;
      if (start >= total || start > end) return new Response(null, { status: 416, headers: { "content-range": "bytes */" + total } });
      return new Response(all.slice(start, end + 1), { status: 206, headers: Object.assign({}, head, { "content-range": "bytes " + start + "-" + end + "/" + total, "content-length": String(end - start + 1) }) });
    }
    return new Response(all, { headers: Object.assign({}, head, { "content-length": String(total) }) });
  }

  if (request.method === "GET") {
    const show = await env.SNAP.get(key, "json");
    if (!show) return out({ show: null });
    const done = (await env.SNAP.list({ prefix: key + ":a" })).keys.length;
    return out({ show: { lines: show.lines, final: show.final, at: show.at, done, total: show.lines.length, league: show.league, remade: !!show.remade } });
  }

  const b = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{16,64}$/.test(String(b.dev || ""))) return out({ error: "Bad request" }, 400);

  if (path === "/api/show/script") {
    const old = await env.SNAP.get(key, "json");
    // One episode per league per week; it can be remade once if it was made while games were still going.
    if (old && !(old.final === false && b.final === true && !old.remade)) return out({ show: { lines: old.lines, final: old.final, at: old.at, total: old.lines.length } });
    const data = String(b.ctx || "").slice(0, 14000);
    if (data.length < 80) return out({ error: "Not enough league data to make a show." }, 400);
    let text = "";
    for (const model of SCRIPT_MODELS) {
      try { const r = await env.AI.run(model, { messages: [{ role: "system", content: SHOW_SYS }, { role: "user", content: "LEAGUE DATA:\n" + data + "\n\nWrite the script now." }], max_tokens: 1800, temperature: 0.85 }); text = (r && r.response) || ""; if (parseScript(text).length >= 12) break; } catch (e) {}
    }
    const lines = parseScript(text);
    if (lines.length < 12) return out({ error: "The script writer came back short. Try again in a minute." }, 502);
    if (old) { for (let i = 0; i < old.lines.length; i++) await env.SNAP.delete(key + ":a" + i); }
    const show = { lines, final: !!b.final, at: Date.now(), league: String(b.league || "").slice(0, 80), remade: !!old, posted: false };
    await env.SNAP.put(key, JSON.stringify(show), { expirationTtl: 120 * 86400 });
    return out({ show: { lines, final: show.final, at: show.at, total: lines.length } });
  }

  if (path === "/api/show/line") {
    const show = await env.SNAP.get(key, "json");
    if (!show) return out({ error: "No script yet" }, 404);
    const i = Number(b.i);
    if (!Number.isInteger(i) || i < 0 || i >= show.lines.length) return out({ error: "Bad line" }, 400);
    const ak = key + ":a" + i;
    if (!(await env.SNAP.get(ak, "arrayBuffer"))) {
      const audio = await speak(env, show.lines[i]);
      if (!audio) return out({ error: "The voices are out for today. Try again tomorrow." }, 503);
      await env.SNAP.put(ak, audio, { expirationTtl: 120 * 86400 });
    }
    // Last line recorded: drop the episode into the league's GroupMe once.
    if (i === show.lines.length - 1 && !show.posted && groupmeSay) {
      const all = (await env.SNAP.list({ prefix: key + ":a" })).keys.length;
      if (all >= show.lines.length) {
        show.posted = true; await env.SNAP.put(key, JSON.stringify(show), { expirationTtl: 120 * 86400 });
        ctx.waitUntil(groupmeSay(env, p, lid, "🎙 The Snap Count Show, week " + w + " is out: " + url.origin + "/api/show/mp3?p=" + p + "&lid=" + encodeURIComponent(lid) + "&w=" + w).catch(() => {}));
      }
    }
    return out({ ok: true });
  }
  return out({ error: "Not found" }, 404);
}

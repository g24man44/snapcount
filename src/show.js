// The league show: a weekly two-host audio recap of one league, written from the league's real results and
// read by two free Cloudflare voices (Aura-2). Made once per league per week and shared in the app (not posted anywhere):
// the script is written in one request, then the phone asks for each spoken line in turn (so no single request
// runs too long), each line is stored once, and /api/show/mp3 plays the whole episode back as one file.
// Cost on the free plan: ~400 neurons for the script and ~2.7 per spoken character (~8,000 for an episode).

const okLid = (p, l) => ["flea", "sleeper", "espn", "mfl"].includes(p) && /^[A-Za-z0-9_-]{1,40}$/.test(l);
const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
// Deepgram Aura-2: the most expressive voices on Workers AI (pacing, emphasis and filler words follow the text).
export const HOSTS = { DEZ: { voice: "apollo", name: "Dez" }, SAM: { voice: "thalia", name: "Sam" } };
const SCRIPT_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];

const SHOW_SYS = `You write the script for "The Snap Count Show", a weekly fantasy football podcast about ONE private league, hosted by two friends who genuinely love this league:
- DEZ: numbers guy, dry, deadpan, sarcastic. Gets quietly outraged about bench points left on the table.
- SAM: big energy, emotional, hot takes, gets fired up, laughs easily, roasts the bad decisions, roots for the underdog.

It has to sound like two real people talking, with real emotion. The voices read your words literally, so write the emotion INTO the words:
- Exclamations when excited ("Are you kidding me?!", "No way!", "Oh, that's brutal."), questions, trailing off with "..." when stunned, short punchy fragments.
- Natural speech: contractions, "I mean", "honestly", "look", "okay okay okay", "wait, wait, wait", an occasional "uh" or "um". Laughter written as "Ha!" or "Hahaha".
- Hosts react to each other constantly: interrupt, agree, push back, tease each other, call back to earlier jokes.
- Short turns, mostly one or two sentences. Vary rhythm: some one-word reactions ("Brutal." "Wow." "Nope.").
- No lists, headings, stage directions, sound effects, asterisks or emojis.
- Use ONLY the facts in the league data. Never invent players, scores, trades or records. Team names exactly as given.
- Good-natured roasting only: about fantasy decisions, never about real people's lives.

Flow:
1. SAM opens: "This is The Snap Count Show, an AI-made recap of [league name], week [N]." Then a quick fun exchange.
2. Results: every matchup quickly, more time and emotion on the closest game, the biggest blowout and the highest score.
3. Blunder of the week, with Dez outraged and Sam roasting.
4. Who's rising and who's in trouble in the standings.
5. One real disagreement about the true contender, both fired up.
6. Sign off with a laugh.

Length: 450 to 550 words total (about three and a half minutes).
Format: every line starts with DEZ: or SAM: and nothing else. No other text before or after.`;

const keyOf = (p, lid, w) => "show2:" + p + ":" + lid + ":" + w;
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

// No fallback to a flatter voice: if today's free voice credit runs out, the episode waits and finishes after
// the daily reset (midnight UTC) in the same voices.
async function speak(env, line) {
  const voice = (HOSTS[line.s] || HOSTS.DEZ).voice;
  try {
    const r = await env.AI.run("@cf/deepgram/aura-2-en", { text: line.t, speaker: voice, encoding: "mp3" }, { returnRawResponse: true });
    if (r && r.ok !== false && r.body) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length > 500) return b; }
  } catch (e) {}
  return null;
}

export async function showRoute(request, url, env) {
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
    const show = { lines, final: !!b.final, at: Date.now(), league: String(b.league || "").slice(0, 80), remade: !!old };
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
      if (!audio) return out({ error: "Today’s free voice time is used up. Open this again after 7 PM Eastern and it picks up right where it stopped.", wait: true }, 503);
      await env.SNAP.put(ak, audio, { expirationTtl: 120 * 86400 });
    }
    return out({ ok: true });
  }
  return out({ error: "Not found" }, 404);
}

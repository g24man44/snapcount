// The league show: a weekly two-host audio recap of one league, written from the league's real results and
// read by two free Cloudflare voices (Aura-2). Made once per league per week and shared in the app (not posted anywhere):
// the script is written in one request, then the phone asks for each spoken line in turn (so no single request
// runs too long), each line is stored once, and /api/show/mp3 plays the whole episode back as one file.
// Cost on the free plan: ~400 neurons for the script and ~2.7 per spoken character (~8,000 for an episode).

const okLid = (p, l) => ["flea", "sleeper", "espn", "mfl"].includes(p) && /^[A-Za-z0-9_-]{1,40}$/.test(l);
const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
// Deepgram Aura-2: the most expressive voices on Workers AI (pacing, emphasis and filler words follow the text).
// Dez was too flat on "apollo"; "atlas" is Deepgram's enthusiastic male voice.
export const HOSTS = { DEZ: { voice: "atlas", name: "Dez" }, SAM: { voice: "thalia", name: "Sam" } };
const SCRIPT_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-3.1-8b-instruct-fast"];

const SHOW_SYS = `You write the script for "The Snap Count Show", a weekly fantasy football podcast about ONE private league, hosted by two best friends who are both genuinely, loudly passionate about this league. It must sound like a real, high-energy sports podcast between friends.

The hosts:
- DEZ: the stats guy, but NOT calm. He gets worked up about numbers: incredulous, exasperated, gleeful when the math backs him up. He rants ("Do you know how many points were sitting on that bench?! Twenty-three! Twenty-three!"), he gloats, he groans. Think excitable analyst, not a robot.
- SAM: pure emotion. Hypes, screams, mocks, gasps, laughs at everyone, takes everything personally, roots for the underdog, loves drama.

The voices read your words literally, so ALL emotion has to be in the words and punctuation:
- Use lots of exclamation points, "?!", repeated words for emphasis ("No. No no no."), stretched reactions ("Ohhh!", "Nooo!", "Come ON!"), and "..." for stunned pauses.
- Reactions are short and constant: "Wow.", "Brutal!", "Stop it!", "You're kidding!", "Hahaha!", "Okay, okay, okay!"
- Natural speech: contractions, "I mean", "honestly", "look", "dude", an occasional "uh" or "um". Hosts interrupt, finish each other's sentences, tease each other, and argue.
- Most turns are one or two short sentences. Never a speech.
- No lists, headings, stage directions, brackets, sound effects, asterisks or emojis.

ACCURACY RULES (most important):
- Use ONLY the facts in the league data, exactly as written. Every score, player and team name must match the data. Never invent or estimate a number, player, trade or record.
- Say scores the way they appear in the data (for example "142.5"). Do not add up or compute anything yourself; the HEADLINES section already has the closest game, blowout, high, low and blunder.
- The episode covers only the week named in the data.
- Good-natured roasting only, about fantasy decisions, never about real people's lives.

Flow:
1. SAM opens with: "This is The Snap Count Show, an AI-made recap of [league name], week [N]!" then a quick fired-up exchange.
2. Results: every game briefly, with big reactions for the closest game, the biggest blowout and the highest score.
3. Blunder of the week: DEZ loses his mind over the bench points, SAM piles on.
4. Standings: who's rising, who's in trouble.
5. A heated disagreement about who the real contender is.
6. Sign off laughing.

Length: 450 to 550 words total.
Format: every line starts with DEZ: or SAM: and nothing else. No other text before or after.`;

const keyOf = (p, lid, w) => "show3:" + p + ":" + lid + ":" + w;
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
export async function deepgramSpeak(env, text, voice) {
  if (!env.DEEPGRAM_KEY || !text) return null;
  try {
    const r = await fetch("https://api.deepgram.com/v1/speak?model=aura-2-" + voice + "-en&encoding=mp3", { method: "POST", headers: { Authorization: "Token " + String(env.DEEPGRAM_KEY).trim(), "Content-Type": "application/json" }, body: JSON.stringify({ text: text.slice(0, 1900) }) });
    if (!r.ok) return null;
    const b = new Uint8Array(await r.arrayBuffer());
    return b.length > 500 ? b : null;
  } catch (e) { return null; }
}
async function speak(env, line) {
  const voice = (HOSTS[line.s] || HOSTS.DEZ).voice;
  const text = line.t.replace(/\p{Extended_Pictographic}\uFE0F?/gu, "").replace(/ +/g, " ").trim();
  // Owner's own Deepgram account (free signup credit) first, so the show doesn't use the Cloudflare AI allowance.
  const dg = await deepgramSpeak(env, text, voice);
  if (dg) return dg;
  try {
    const r = await env.AI.run("@cf/deepgram/aura-2-en", { text, speaker: voice, encoding: "mp3" }, { returnRawResponse: true });
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
    // Fact check: every number spoken must appear in the league data (small counts like weeks and records
    // aside). A script that invents a number is rewritten, up to three tries; the cleanest one is kept.
    const allowed = new Set();
    for (const m of data.matchAll(/\d+(?:\.\d+)?/g)) { const x = Number(m[0]); allowed.add(m[0]); allowed.add(String(Math.round(x))); allowed.add(String(Math.floor(x))); allowed.add(x.toFixed(1)); }
    const badNums = ls => ls.flatMap(l => (l.t.match(/\d+(?:\.\d+)?/g) || []).filter(n => Number(n) > 20 && !allowed.has(n)));
    let best = null, lastErr = null;
    for (let tries = 0; tries < 3 && !(best && !best.bad.length); tries++) {
      const model = SCRIPT_MODELS[tries === 2 ? 1 : 0];
      const fix = best && best.bad.length ? "\n\nYour last draft used numbers that are NOT in the data: " + [...new Set(best.bad)].slice(0, 8).join(", ") + ". Use only numbers that appear in the data." : "";
      try {
        const r = await env.AI.run(model, { messages: [{ role: "system", content: SHOW_SYS }, { role: "user", content: "LEAGUE DATA:\n" + data + "\n\nWrite the script now." + fix }], max_tokens: 1800, temperature: 0.8 });
        const txt = String((r && (r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) ?? "");
        const ls = parseScript(txt);
        if (ls.length >= 12) { const bad = badNums(ls); if (!best || bad.length < best.bad.length) best = { lines: ls, bad }; }
        else lastErr = new Error("short script (" + ls.length + " lines)");
      } catch (e) { lastErr = e; if (/4006|neuron|allocation|quota|limit/i.test(String(e && e.message))) break; }
    }
    const lines = best ? best.lines : [];
    if (lines.length < 12) {
      const m = String(lastErr && lastErr.message || "");
      if (/4006|neuron|allocation|quota|limit/i.test(m)) return out({ error: "Today’s free AI allowance is used up. Try again after 7 PM Eastern, when it resets.", wait: true }, 503);
      return out({ error: "The script writer came back short. Try again in a minute. (" + m.slice(0, 100) + ")" }, 502);
    }
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

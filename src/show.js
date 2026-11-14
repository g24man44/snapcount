// The league show: a weekly two-host audio recap of one league, written from the league's real results.
// Made once per league per week and shared in the app (not posted anywhere).
// Engines, best first:
//  - Gemini (owner's GEMINI_KEY, free tier): writes the script and reads it as a real two-person conversation,
//    with a style note per line ("yelling", "laughing") and vocal tags (<laugh>, <gasp>, <shout>). Recorded in a
//    few chunks; each chunk is stored as Gemini returned it and the phone stitches them into one WAV.
//  - Deepgram (owner's DEEPGRAM_KEY): Flux voices at max expressivity, one request per line, stored as MP3.
//  - Cloudflare Workers AI as the last resort for the script (uses the daily neuron allowance).
const okLid = (p, l) => ["flea", "sleeper", "espn", "mfl"].includes(p) && /^[A-Za-z0-9_-]{1,40}$/.test(l);
const out = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
// Deepgram Aura-2: the most expressive voices on Workers AI (pacing, emphasis and filler words follow the text).
// Dez was too flat on "apollo"; "atlas" is Deepgram's enthusiastic male voice.
export const HOSTS = { DEZ: { voice: "atlas", name: "Dez" }, SAM: { voice: "thalia", name: "Sam" } };
const SCRIPT_MODELS = ["@cf/meta/llama-3.3-70b-instruct-fp8-fast", "@cf/meta/llama-4-scout-17b-16e-instruct"];

const SHOW_SYS = `You write the script for "The Snap Count Show", a weekly fantasy football podcast about ONE private league, hosted by two best friends who love this league. It must sound like two real people talking, not a radio ad.

The hosts:
- DEZ: the numbers guy. Dry wit, then genuinely worked up when the stats are absurd. Gloats when the math backs him up.
- SAM: big personality, quick to laugh, roasts bad decisions, roots for the underdog, loves drama.

Make it sound like a REAL podcast, not a performance:
- Mostly normal conversation. Energy rises and falls: calm, then excited at the big moments, then laughing. Not every line is loud.
- Real speech: contractions, "I mean", "like", "honestly", "wait", "okay so", trailing off with "...", restarting a sentence, an occasional "uh". Hosts interrupt, agree, push back, tease, and call back to earlier jokes.
- Quick back-and-forth. Many turns are short reactions ("No way.", "Stop.", "Oh, that's bad.", "Right?!").
- Laughter as <laugh>, never "Hahaha". Use <gasp> or <sigh> sparingly. Exclamation points only for real peaks. Capitals for one stressed word at most, rarely.
- Each line gets a short acting note in parentheses after the host's name, saying HOW it's said, e.g. "(amused)", "(can't believe it)", "(laughing)", "(getting fired up)", "(deadpan)", "(groaning)". Vary them.
- No lists, headings, square brackets, sound effects, asterisks or emojis.

ACCURACY RULES (most important):
- Use ONLY the facts in the league data, exactly as written. Every score, player and team name must match the data. Never invent or estimate a number, player, trade or record.
- Say scores the way they appear in the data (for example "142.5"). Do not add up or compute anything yourself; the HEADLINES section already has the closest game, blowout, high, low and blunder.
- The episode covers only the week named in the data.
- Good-natured roasting only, about fantasy decisions, never about real people's lives.

Flow:
1. SAM opens with: "This is The Snap Count Show, an AI-made recap of [league name], week [N]!" then a quick, easy back-and-forth.
2. Results: every game briefly, with big reactions for the closest game, the biggest blowout and the highest score.
3. Blunder of the week: DEZ gets worked up over the bench points, SAM can't stop laughing.
4. Standings: who's rising, who's in trouble.
5. A real disagreement about who the true contender is.
6. Sign off laughing.

Length: 450 to 550 words total.
Format: every line is DEZ (acting note): text  or  SAM (acting note): text. No other text before or after.`;

const keyOf = (p, lid, w) => "show5:" + p + ":" + lid + ":" + w;
function parseScript(text) {
  const lines = [];
  for (const raw of String(text || "").split(/\n+/)) {
    const m = raw.replace(/\*\*/g, "").match(/^\s*(DEZ|SAM)\s*(?:\(([^)]{1,80})\))?\s*:\s*(?:\(([^)]{1,80})\)\s*)?(.+)$/i);
    if (!m) { if (lines.length && raw.trim() && !/^\s*[\[(]/.test(raw)) lines[lines.length - 1].t += " " + raw.trim(); continue; }
    const t = m[4].replace(/\[[^\]]*\]/g, "").replace(/[*_#`]/g, "").trim();
    if (t) lines.push({ s: m[1].toUpperCase(), st: String(m[2] || m[3] || "").trim().slice(0, 80), t: t.slice(0, 600) });
  }
  return lines.slice(0, 70);
}

// No fallback to a flatter voice: if today's free voice credit runs out, the episode waits and finishes after
// the daily reset (midnight UTC) in the same voices.
// Deepgram Flux TTS: the most animated delivery Deepgram offers (expressivity -2 calm .. 2 animated, plus speed).
// Aura-2 was too flat and slow for a sports show. Aura-2 stays as the backup if Flux is unavailable.
export const FLUX = { DEZ: "flux-cole-en", SAM: "flux-brooke-en" }, FLUX_EXPRESSIVITY = 2, FLUX_SPEED = 1.15;
export async function deepgramSpeak(env, text, voice, host) {
  if (!env.DEEPGRAM_KEY || !text) return null;
  const key = "Token " + String(env.DEEPGRAM_KEY).trim(), body = JSON.stringify({ text: text.slice(0, 1900) });
  const get = async u => { try { const r = await fetch(u, { method: "POST", headers: { Authorization: key, "Content-Type": "application/json" }, body }); if (!r.ok) return null; const b = new Uint8Array(await r.arrayBuffer()); return b.length > 500 ? b : null; } catch (e) { return null; } };
  if (host && FLUX[host]) { const f = await get("https://api.deepgram.com/v2/speak?model=" + FLUX[host] + "&expressivity=" + FLUX_EXPRESSIVITY + "&speed=" + FLUX_SPEED); if (f) return f; }
  return get("https://api.deepgram.com/v1/speak?model=aura-2-" + voice + "-en&encoding=mp3&speed=1.15");
}
// Deepgram reads tags literally, so it gets the line without them.
const plain = t => String(t).replace(/<[^>]{1,20}>/g, "").replace(/\|([^|]{1,60})\|/g, "$1").replace(/\p{Extended_Pictographic}\uFE0F?/gu, "").replace(/ +/g, " ").trim();

/* ---------- Gemini ---------- */
const GEM = "https://generativelanguage.googleapis.com/v1beta/models/";
// 2.5 Flash with thinking off writes a script in ~10 s; the slow "thinking" pass pushed requests past the
// ~100 s a phone connection stays open ("Failed to fetch").
// Model names change; ask Google which ones this key can use (cached a day) and rank them.
let gemModelsMem = null;
export async function gemModels(env) {
  if (gemModelsMem && Date.now() - gemModelsMem.at < 6 * 3600e3) return gemModelsMem;
  let c = env.SNAP ? await env.SNAP.get("gem:models2", "json").catch(() => null) : null;
  if (!c || Date.now() - c.at > 86400e3) {
    const r = await fetch(GEM.replace(/\/$/, "") + "?pageSize=300", { headers: { "x-goog-api-key": gemKey(env) } });
    if (!r.ok) { const e = new Error("Gemini model list " + r.status); e.status = r.status; throw e; }
    const ms = ((await r.json()).models || []).filter(m => (m.supportedGenerationMethods || []).includes("generateContent")).map(m => m.name.replace("models/", ""));
    const ver = n => Number((n.match(/gemini-(\d+(?:\.\d+)?)/) || [])[1] || 0);
    const rank = (a, b) => (ver(b) - ver(a)) || (/preview|exp/.test(a) - /preview|exp/.test(b)) || (a.length - b.length);
    const text = ms.filter(n => /^gemini-[\d.]+-flash(-preview[-\d]*)?$/.test(n) || /^gemini-flash-latest$/.test(n)).sort(rank);
    const lite = ms.filter(n => /^gemini-[\d.]+-flash-lite(-preview[-\d]*)?$/.test(n)).sort(rank);
    const tts = ms.filter(n => /tts/.test(n)).sort((a, b) => (/pro/.test(b) - /pro/.test(a)) || rank(a, b));
    // 2.5 Flash first when the key has it: with thinking off it answers in seconds (newer flashes think first).
    const fast = text.filter(n => n === "gemini-2.5-flash");
    c = { at: Date.now(), text: fast.concat(text.filter(n => !fast.includes(n)), lite).slice(0, 4), tts: tts.slice(0, 4) };
    if (env.SNAP && c.text.length) await env.SNAP.put("gem:models2", JSON.stringify(c)).catch(() => {});
  }
  return (gemModelsMem = c);
}
const thinkOff = model => /2\.5-flash/.test(model) ? { thinkingConfig: { thinkingBudget: 0 } } : /gemini-3/.test(model) ? { thinkingConfig: { thinkingLevel: "low" } } : {};
export const GEM_VOICES = { DEZ: "Fenrir", SAM: "Zephyr" }; // Fenrir: "excitable"; Zephyr: "bright"
const NAME = { DEZ: "Dez", SAM: "Sam" };
const gemKey = env => String(env.GEMINI_KEY || "").trim();
async function gemFetch(env, model, body, ms) {
  let r;
  try { r = await fetch(GEM + model + ":generateContent", { method: "POST", headers: { "x-goog-api-key": gemKey(env), "content-type": "application/json" }, body: JSON.stringify(body), signal: AbortSignal.timeout(ms || 45000) }); }
  catch (e) { const err = new Error(model + " didn’t answer in " + Math.round((ms || 45000) / 1000) + " s"); err.status = 504; throw err; }
  if (!r.ok) { let m = ""; try { const j = await r.json(); m = (j.error && j.error.message) || ""; } catch (e) {} const err = new Error("Gemini " + r.status + (m ? ": " + m.slice(0, 160) : "")); err.status = r.status; throw err; }
  return r;
}
async function gemWrite(env, sys, user) {
  let last = null;
  for (const model of (await gemModels(env)).text) {
    try {
      let res;
      try { res = await gemFetch(env, model, { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: Object.assign({ temperature: 0.9, maxOutputTokens: 3000 }, thinkOff(model)) }); }
      catch (e) { if (e.status !== 400) throw e; res = await gemFetch(env, model, { systemInstruction: { parts: [{ text: sys }] }, contents: [{ role: "user", parts: [{ text: user }] }], generationConfig: { temperature: 0.9, maxOutputTokens: 6000 } }); }
      const j = await res.json();
      const t = ((j.candidates || [])[0] || {}).content; const txt = ((t && t.parts) || []).filter(x => !x.thought && x.text).map(x => x.text).join("\n");
      if (txt) return txt;
    } catch (e) { last = e; if (e.status === 401 || e.status === 403) break; }
  }
  throw last || new Error("Gemini wrote nothing");
}
// Chat-style text for the app's AI features (coach, briefing, recaps…), on the owner's free Gemini key.
// Flash 2.5 first (biggest free daily quota, thinking off for speed), then the newer flash.
// For the health check: try each writing model separately and report exactly what happened.
export async function gemProbe(env) {
  const m = await gemModels(env);
  const one = async model => { const t = Date.now(); try { const j = await (await gemFetch(env, model, { contents: [{ role: "user", parts: [{ text: "Reply with OK." }] }], generationConfig: Object.assign({ maxOutputTokens: 20 }, thinkOff(model)) }, 12000)).json(); const ok = (((j.candidates || [])[0] || {}).content || {}).parts; return { model, ok: !!ok, ms: Date.now() - t, note: ok ? "" : "empty answer" }; } catch (e) { return { model, ok: false, ms: Date.now() - t, note: String(e.message).slice(0, 110) }; } };
  return { models: m, results: await Promise.all(m.text.slice(0, 3).map(one)) };
}
export async function gemChat(env, messages, maxTokens, temperature) {
  if (!gemKey(env)) return "";
  const sys = messages.filter(m => m.role === "system").map(m => m.content).join("\n\n");
  const contents = messages.filter(m => m.role !== "system").map(m => ({ role: m.role === "assistant" ? "model" : "user", parts: [{ text: String(m.content || "") }] }));
  let models = []; try { models = (await gemModels(env)).text; } catch (e) { return ""; }
  for (const model of models) {
    try {
      const gc = Object.assign({ temperature: temperature ?? 0.5, maxOutputTokens: Math.max(400, (maxTokens || 600) + 200) }, thinkOff(model));
      const body = { systemInstruction: sys ? { parts: [{ text: sys }] } : undefined, contents, generationConfig: gc };
      let res; try { res = await gemFetch(env, model, body); } catch (e) { if (e.status !== 400) throw e; delete gc.thinkingConfig; gc.maxOutputTokens = Math.max(2000, gc.maxOutputTokens * 3); res = await gemFetch(env, model, body); }
      const j = await res.json();
      const c = ((j.candidates || [])[0] || {}).content, txt = ((c && c.parts) || []).filter(x => !x.thought && x.text).map(x => x.text).join("").trim();
      if (txt) return txt;
    } catch (e) { if (e.status === 401 || e.status === 403) break; }
  }
  return "";
}

// One chunk of the conversation, read in one go so the two voices play off each other.
// Three voice pairs the owner can compare in the app; the pick is stored once ("showvoice").
// As different from each other as Gemini allows: upbeat/young, gravelly/firm, deep/youthful.
export const GEM_PAIRS = { a: { DEZ: "Puck", SAM: "Laomedeia" }, b: { DEZ: "Algenib", SAM: "Kore" }, c: { DEZ: "Charon", SAM: "Leda" } };
const DIRECTION = "Two best friends recording their weekly fantasy football podcast. Relaxed and natural like a real conversation: they laugh for real, react, interrupt, speed up when excited and get loud only at the big moments. Never like reading a script or an announcer.";
async function gemSpeak(env, lines, pairKey) {
  const pair = GEM_PAIRS[pairKey] || GEM_PAIRS[(env.SNAP && await env.SNAP.get("showvoice")) || "a"] || GEM_PAIRS.a;
  const cfg = { responseModalities: ["AUDIO"], speechConfig: { multiSpeakerVoiceConfig: { speakerVoiceConfigs: ["DEZ", "SAM"].map(h => ({ speaker: NAME[h], voiceConfig: { prebuiltVoiceConfig: { voiceName: pair[h] } } })) } } };
  let last = null;
  for (const model of (await gemModels(env)).tts) {
    try {
      const contents = model.startsWith("gemini-3.8")
        ? [{ role: "user", parts: lines.map(l => ({ text: l.t, speech_metadata: { speaker: NAME[l.s], style: l.st || "natural, casual" } })) }]
        : [{ role: "user", parts: [{ text: DIRECTION + "\n\n" + lines.map(l => NAME[l.s] + (l.st ? " (" + l.st + ")" : "") + ": " + l.t).join("\n") }] }];
      const r = await gemFetch(env, model, { contents, generationConfig: cfg });
      // The answer is a few MB of base64; pull it out with string search instead of parsing the whole thing.
      const txt = await r.text(), mm = txt.match(/"mimeType"\s*:\s*"([^"]+)"/), at = txt.search(/"data"\s*:\s*"/);
      if (at < 0) throw new Error("Gemini sent no audio");
      const start = txt.indexOf('"', txt.indexOf(":", at) + 1) + 1, end = txt.indexOf('"', start);
      if (end - start < 2000) throw new Error("Gemini audio too short");
      return '{"x":' + JSON.stringify(model) + ',"m":' + JSON.stringify(mm ? mm[1] : "audio/L16;rate=24000") + ',"d":"' + txt.slice(start, end) + '"}';
    } catch (e) { last = e; if (e.status === 429 || e.status === 401 || e.status === 403) break; }
  }
  throw last || new Error("Gemini voices failed");
}
// Groups of turns, about 30 seconds each, so every chunk is one natural stretch of conversation.
function chunk(lines) { const out = []; let cur = [], n = 0; lines.forEach((l, i) => { if (cur.length && (n + l.t.length > 650 || cur.length >= 8)) { out.push(cur); cur = []; n = 0; } cur.push(i); n += l.t.length; }); if (cur.length) out.push(cur); return out; }

/* ---------- ElevenLabs (owner's free account: 10,000 characters a month, must credit elevenlabs.io) ---------- */
const EL = "https://api.elevenlabs.io";
const elKey = env => String(env.ELEVENLABS_KEY || "").trim();
async function elGet(env, path) { const r = await fetch(EL + path, { headers: { "xi-api-key": elKey(env) } }); if (!r.ok) { const e = new Error("ElevenLabs " + r.status + ": " + (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 140)); e.status = r.status; throw e; } return r.json(); }
// Best model the account can use, and two voices: an easygoing guy for Dez, a bright, playful voice for Sam.
const EL_DEZ = ["Chris", "Liam", "Will", "Charlie", "Brian", "Eric", "Adam"], EL_SAM = ["Jessica", "Laura", "Sarah", "Alice", "Matilda", "Rachel"];
export async function elSetup(env) {
  const c = env.SNAP && await env.SNAP.get("el:setup", "json"); if (c && Date.now() - c.at < 7 * 864e5) return c;
  const models = await elGet(env, "/v1/models").catch(() => []), ids = (models || []).filter(m => m.can_do_text_to_speech !== false).map(m => m.model_id);
  const model = ["eleven_v4", "eleven_v3", "eleven_multilingual_v2", "eleven_turbo_v2_5"].find(m => ids.includes(m)) || "eleven_multilingual_v2";
  const voices = ((await elGet(env, "/v1/voices")).voices || []);
  const by = list => list.map(n => voices.find(v => String(v.name || "").split(/[ -]/)[0].toLowerCase() === n.toLowerCase())).find(Boolean);
  const dez = by(EL_DEZ) || voices.find(v => (v.labels || {}).gender === "male") || voices[0], sam = by(EL_SAM) || voices.find(v => (v.labels || {}).gender === "female" && v !== dez) || voices[1];
  if (!dez || !sam) throw new Error("No ElevenLabs voices found on this account");
  const setup = { at: Date.now(), model, DEZ: dez.voice_id, SAM: sam.voice_id, names: [dez.name, sam.name] };
  if (env.SNAP) await env.SNAP.put("el:setup", JSON.stringify(setup));
  return setup;
}
// Eleven v3/v4 act out bracketed audio tags ([excited], [laughs]); older models get plain text.
function elText(line, model) {
  const tags = /v3|v4/.test(model);
  let t = String(line.t).replace(/\|([^|]{1,60})\|/g, "$1").replace(/\p{Extended_Pictographic}\uFE0F?/gu, "");
  const map = { laugh: "[laughs]", gasp: "[gasps]", sigh: "[sighs]", shout: "[shouting]", scream: "[screams]", whisper: "[whispers]", breath: "", "short pause": "...", "long pause": "... ..." };
  t = t.replace(/<([a-z ]{1,20})>/gi, (m, k) => tags ? (map[k.toLowerCase()] ?? "") : (/pause/.test(k) ? "..." : ""));
  if (tags && line.st) t = "[" + line.st.replace(/[\[\]]/g, "").slice(0, 40) + "] " + t;
  return t.replace(/ +/g, " ").trim();
}
async function elSpeak(env, line) {
  const set = await elSetup(env), v3 = /v3|v4/.test(set.model);
  const call = settings => fetch(EL + "/v1/text-to-speech/" + set[line.s] + "?output_format=mp3_44100_128", { method: "POST", headers: { "xi-api-key": elKey(env), "content-type": "application/json" }, body: JSON.stringify(Object.assign({ text: elText(line, set.model), model_id: set.model }, settings ? { voice_settings: settings } : {})) });
  let r = await call(v3 ? { stability: 0.0, similarity_boost: 0.75 } : { stability: 0.3, similarity_boost: 0.75, style: 0.6, use_speaker_boost: true });
  if (r.status === 400 || r.status === 422) r = await call(null);
  if (!r.ok) { const e = new Error("ElevenLabs " + r.status + ": " + (await r.text().catch(() => "")).replace(/\s+/g, " ").slice(0, 160)); e.status = r.status; throw e; }
  return new Uint8Array(await r.arrayBuffer());
}
export async function elUsage(env) { const s = await elGet(env, "/v1/user/subscription"); return { used: s.character_count, limit: s.character_limit, resets: s.next_character_count_reset_unix }; }

async function speak(env, line) {
  const voice = (HOSTS[line.s] || HOSTS.DEZ).voice;
  const text = plain(line.t);
  // Owner's own Deepgram account (free signup credit) first, so the show doesn't use the Cloudflare AI allowance.
  const dg = await deepgramSpeak(env, text, voice, line.s);
  if (dg) return dg;
  try {
    const r = await env.AI.run("@cf/deepgram/aura-2-en", { text, speaker: voice, encoding: "mp3" }, { returnRawResponse: true });
    if (r && r.ok !== false && r.body) { const b = new Uint8Array(await r.arrayBuffer()); if (b.length > 500) return b; }
  } catch (e) {}
  return null;
}

// A 25-second taste of the hosts, recorded once with the real week-9 facts and kept.
const SAMPLE = [
  ["SAM", "This is The Snap Count Show! Dez. Dez! Did you SEE Lemon Drops this week?!"],
  ["DEZ", "Did I see it? I can't UNSEE it! They started the Cardinals defense. Negative one point seven!"],
  ["SAM", "Nooo! Stop it!"],
  ["DEZ", "And the Bucs defense is just sitting there on the bench with eighteen point three. They would have WON, Sam. They would have won!"],
  ["SAM", "Hahaha! Oh, that's brutal. Oh-and-nine, baby. Oh-and-nine!"],
  ["DEZ", "Meanwhile, To Infinity And Bijan drops a hundred seventy-six. Are you kidding me?!"],
  ["SAM", "Come ON! That team is on fire!"]
];
// How real hosts talk: mostly conversational, quick reactions, real laughs, one big moment.
const NATURAL_SAMPLE = [
  ["SAM", "warm, amused, easing in", "Alright, we're back. Dez... I have to ask. Did you see Lemon Drops this week?"],
  ["DEZ", "half laughing, can't believe it", "Did I see it? Sam, I can't stop seeing it. They started the Cardinals defense. Negative one point seven."],
  ["SAM", "groaning", "Oh no. Oh, no no no."],
  ["DEZ", "building up, getting louder", "And the Bucs defense is just sitting on their bench with eighteen point three. Which, by the way... would have won them the game."],
  ["SAM", "cracking up", "<laugh> Stop. That's so bad. They're oh-and-nine, man."],
  ["DEZ", "dry, then genuinely excited", "Meanwhile, To Infinity And Bijan puts up a hundred seventy-six. Like... come on."],
  ["SAM", "hyped", "That team is on fire right now. Somebody's gotta stop them."]
];
export async function showRoute(request, url, env) {
  const path = url.pathname;
  if (path === "/api/show/voice" && request.method === "POST" && env.SNAP) {
    const b = await request.json().catch(() => ({})); if (!GEM_PAIRS[b.pair]) return out({ error: "Unknown voice pair" }, 400);
    await env.SNAP.put("showvoice", b.pair); return out({ ok: true });
  }
  if (path === "/api/show/sample" && elKey(env)) {
    let bytes = env.SNAP ? await env.SNAP.get("showsample:el1", "arrayBuffer") : null;
    if (!bytes) {
      const parts = [];
      try { for (const [h, st, t] of NATURAL_SAMPLE) parts.push(await elSpeak(env, { s: h, st, t })); }
      catch (e) { return out({ error: e.message }, 502); }
      const all = new Uint8Array(parts.reduce((a, b) => a + b.length, 0)); let o = 0; parts.forEach(b => { all.set(b, o); o += b.length; });
      if (env.SNAP) await env.SNAP.put("showsample:el1", all);
      bytes = all.buffer;
    }
    return new Response(bytes, { headers: { "content-type": "audio/mpeg", "x-engine": "eleven", "cache-control": "no-store" } });
  }
  if (path === "/api/show/sample" && gemKey(env)) {
    const pk = GEM_PAIRS[url.searchParams.get("pair")] ? url.searchParams.get("pair") : "a", ck = "showsample:g3:" + pk;
    let j = env.SNAP ? await env.SNAP.get(ck) : null;
    if (!j) {
      try { j = await gemSpeak(env, NATURAL_SAMPLE.map(([s2, st, t]) => ({ s: s2, st, t })), pk); }
      catch (e) { return out({ error: e.message }, e.status === 429 ? 429 : 502); }
      if (env.SNAP) await env.SNAP.put(ck, j);
    }
    const chosen = env.SNAP ? (await env.SNAP.get("showvoice")) || "a" : "a";
    return new Response(j.replace(/^\{/, '{"chosen":"' + chosen + '",'), { headers: { "content-type": "application/json", "cache-control": "no-store" } });
  }
  if (path === "/api/show/sample") {
    let bytes = env.SNAP ? await env.SNAP.get("showsample:v2", "arrayBuffer") : null;
    if (!bytes) {
      const parts = [];
      for (const [h, t] of SAMPLE) { const b = await deepgramSpeak(env, t, HOSTS[h].voice, h); if (!b) return new Response("The sample needs the Deepgram key to be set.", { status: 503 }); parts.push(b); }
      const all = new Uint8Array(parts.reduce((s, b) => s + b.length, 0)); let o = 0; parts.forEach(b => { all.set(b, o); o += b.length; });
      if (env.SNAP) await env.SNAP.put("showsample:v2", all);
      bytes = all.buffer;
    }
    return new Response(bytes, { headers: { "content-type": "audio/mpeg", "cache-control": "public, max-age=3600" } });
  }
  if (!env.SNAP || !env.AI) return out({ error: "The show isn't available on this server." }, 503);
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

  if (path === "/api/show/part") {
    const i = Number(url.searchParams.get("i")), j = await env.SNAP.get(key + ":g" + i);
    return j ? new Response(j, { headers: { "content-type": "application/json", "cache-control": "public, max-age=86400" } }) : out({ error: "Not recorded yet" }, 404);
  }
  const view = async show => {
    const gem = show.engine === "gemini", done = (await env.SNAP.list({ prefix: key + (gem ? ":g" : ":a") })).keys.length;
    return { lines: show.lines, engine: show.engine || "deepgram", final: show.final, at: show.at, done, total: gem ? show.parts.length : show.lines.length, league: show.league, remade: !!show.remade };
  };
  if (request.method === "GET") {
    const show = await env.SNAP.get(key, "json");
    return out({ show: show ? await view(show) : null });
  }

  const b = await request.json().catch(() => ({}));
  if (!/^[a-f0-9]{16,64}$/.test(String(b.dev || ""))) return out({ error: "Bad request" }, 400);

  if (path === "/api/show/script") {
    const old = await env.SNAP.get(key, "json");
    // One episode per league per week; it can be remade once if it was made while games were still going.
    if (old && !(old.final === false && b.final === true && !old.remade)) return out({ show: await view(old) });
    const data = String(b.ctx || "").slice(0, 14000);
    if (data.length < 80) return out({ error: "Not enough league data to make a show." }, 400);
    // Fact check: every number spoken must appear in the league data (small counts like weeks and records
    // aside). A script that invents a number is rewritten, up to three tries; the cleanest one is kept.
    const allowed = new Set();
    for (const m of data.matchAll(/\d+(?:\.\d+)?/g)) { const x = Number(m[0]); allowed.add(m[0]); allowed.add(String(Math.round(x))); allowed.add(String(Math.floor(x))); allowed.add(x.toFixed(1)); }
    const badNums = ls => ls.flatMap(l => (l.t.match(/\d+(?:\.\d+)?/g) || []).filter(n => Number(n) > 20 && !allowed.has(n)));
    let best = null, lastErr = null, useCf = false, gemErr = null;
    const t0 = Date.now();
    for (let tries = 0; tries < 3 && !(best && !best.bad.length) && !(best && Date.now() - t0 > 35000); tries++) {
      const model = SCRIPT_MODELS[tries === 2 ? 1 : 0];
      const fix = best && best.bad.length ? "\n\nYour last draft used numbers that are NOT in the data: " + [...new Set(best.bad)].slice(0, 8).join(", ") + ". Use only numbers that appear in the data." : "";
      try {
        let txt = "";
        const len = elKey(env) ? "\n\nKeep it SHORT this time: 330 to 400 words total (the voice budget is tight). Fewer games in detail; still mention the closest game, the blowout, the high score and the blunder." : "";
        if (gemKey(env) && !useCf) { try { txt = await gemWrite(env, SHOW_SYS, "LEAGUE DATA:\n" + data + "\n\nWrite the script now." + len + fix); } catch (e) { lastErr = e; gemErr = e; useCf = true; } }
        if (!txt) {
          const r = await env.AI.run(model, { messages: [{ role: "system", content: SHOW_SYS }, { role: "user", content: "LEAGUE DATA:\n" + data + "\n\nWrite the script now." + len + fix }], max_tokens: 1800, temperature: 0.8 });
          txt = String((r && (r.response ?? (r.choices && r.choices[0] && r.choices[0].message && r.choices[0].message.content))) ?? "");
        }
        const ls = parseScript(txt);
        if (ls.length >= 12) { const bad = badNums(ls); if (!best || bad.length < best.bad.length) best = { lines: ls, bad }; }
        else lastErr = new Error("short script (" + ls.length + " lines)");
      } catch (e) { lastErr = e; if (/4006|neuron|allocation|quota|limit/i.test(String(e && e.message))) break; }
    }
    const lines = best ? best.lines : [];
    if (lines.length < 12) {
      const m = String(lastErr && lastErr.message || "");
      if (gemErr) return out({ error: "Gemini couldn’t write the script: " + String(gemErr.message).slice(0, 200) }, 502);
      if (/4006|neuron|allocation|quota|limit/i.test(m)) return out({ error: "Today’s free AI allowance is used up. Try again after 7 PM Eastern, when it resets.", wait: true }, 503);
      return out({ error: "The script writer came back short. Try again in a minute. (" + m.slice(0, 100) + ")" }, 502);
    }
    if (elKey(env) && lines[0]) lines[0].t = lines[0].t.replace(/(an AI-made recap)/i, "$1, with voices by ElevenLabs dot io,");
    if (old) { for (let i = 0; i < old.lines.length; i++) { await env.SNAP.delete(key + ":a" + i); await env.SNAP.delete(key + ":g" + i); } }
    const engine = elKey(env) ? "eleven" : gemKey(env) ? "gemini" : "deepgram";
    const show = { lines, engine, parts: engine === "gemini" ? chunk(lines) : null, final: !!b.final, at: Date.now(), league: String(b.league || "").slice(0, 80), remade: !!old };
    await env.SNAP.put(key, JSON.stringify(show), { expirationTtl: 120 * 86400 });
    return out({ show: Object.assign(await view(show), { done: 0 }) });
  }

  if (path === "/api/show/line") {
    const show = await env.SNAP.get(key, "json");
    if (!show) return out({ error: "No script yet" }, 404);
    const i = Number(b.i);
    if (show.engine === "gemini") {
      if (!Number.isInteger(i) || i < 0 || i >= show.parts.length) return out({ error: "Bad part" }, 400);
      const gk = key + ":g" + i;
      if (!(await env.SNAP.get(gk))) {
        let j;
        try { j = await gemSpeak(env, show.parts[i].map(n => show.lines[n])); }
        catch (e) { return out({ error: e.status === 429 ? "Gemini’s free voice limit for today is used up. Open this again tomorrow and it picks up where it stopped." : "Gemini voices: " + e.message, wait: e.status === 429 }, e.status === 429 ? 429 : 502); }
        await env.SNAP.put(gk, j, { expirationTtl: 120 * 86400 });
      }
      return out({ ok: true });
    }
    if (!Number.isInteger(i) || i < 0 || i >= show.lines.length) return out({ error: "Bad line" }, 400);
    const ak = key + ":a" + i;
    if (!(await env.SNAP.get(ak, "arrayBuffer")) && show.engine === "eleven") {
      let audio;
      try { audio = await elSpeak(env, show.lines[i]); }
      catch (e) { return out({ error: /quota|credits|limit/i.test(e.message) || e.status === 401 && /quota/i.test(e.message) ? "This month’s free ElevenLabs characters are used up. The rest records after your monthly reset." : e.message, wait: true }, 503); }
      await env.SNAP.put(ak, audio, { expirationTtl: 120 * 86400 });
    }
    if (!(await env.SNAP.get(ak, "arrayBuffer"))) {
      const audio = await speak(env, show.lines[i]);
      if (!audio) return out({ error: "Today’s free voice time is used up. Open this again after 7 PM Eastern and it picks up right where it stopped.", wait: true }, 503);
      await env.SNAP.put(ak, audio, { expirationTtl: 120 * 86400 });
    }
    return out({ ok: true });
  }
  return out({ error: "Not found" }, 404);
}

// Trade offers inside Snap Count: send, accept, decline or counter, then one tap makes it official on the league site.
// Stored in the live-state Durable Object (no KV writes).
import { hotGet, hotPut } from "./alerts.js";
import { notifyTeam } from "./bets.js";

const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const keyOf = (p, lid) => "offers:" + p + ":" + lid;
const nm = s => String(s || "").slice(0, 60);
const items = a => (Array.isArray(a) ? a : []).slice(0, 12).map(x => ({ id: String(x.id || "").slice(0, 40), name: nm(x.name), pos: String(x.pos || "").slice(0, 6) })).filter(x => x.id);
const list2 = a => a.map(x => x.name).join(" + ") || "nothing";

export async function offersRoute(request, env, url) {
  if (request.method === "GET") {
    const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
    if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad request" }, 400);
    return out({ offers: (await hotGet(env, keyOf(p, lid))) || [] });
  }
  if (request.method !== "POST") return out({ error: "GET or POST" }, 405);
  const b = await request.json().catch(() => ({}));
  const p = String(b.p || ""), lid = String(b.lid || "");
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad request" }, 400);
  const k = keyOf(p, lid), list = (await hotGet(env, k)) || [], link = "/?offers=" + p + ":" + lid, tag = "offer:" + lid;
  if (b.action === "send") {
    const from = b.from || {}, to = b.to || {}, give = items(b.give), get = items(b.get);
    if (!from.id || !to.id || from.id === to.id || !(give.length + get.length)) return out({ error: "Add players to both sides first." }, 400);
    if (list.filter(x => x.status === "offered" && x.from.id === String(from.id)).length >= 10) return out({ error: "You have 10 offers waiting. Withdraw a few first." }, 429);
    const o = { id: Date.now().toString(36) + Math.random().toString(36).slice(2, 6), from: { id: String(from.id), name: nm(from.name) }, to: { id: String(to.id), name: nm(to.name) }, give, get,
      givePk: (b.givePk || []).slice(0, 8).map(String), getPk: (b.getPk || []).slice(0, 8).map(String), note: String(b.note || "").slice(0, 280), grade: Number(b.grade) || null, status: "offered", at: Date.now(), parent: b.parent ? String(b.parent) : null };
    if (o.parent) { const par = list.find(x => x.id === o.parent); if (par && par.status === "offered" && par.to.id === o.from.id) { par.status = "countered"; par.answered = Date.now(); } }
    list.unshift(o); await hotPut(env, k, list.slice(0, 120));
    const sent = await notifyTeam(env, p, lid, o.to.id, { show: 1, tag, title: (o.parent ? "↩️ " + o.from.name + " countered your offer" : "📨 Trade offer from " + o.from.name), body: "You get " + list2(o.give) + ". You send " + list2(o.get) + ".", url: link });
    return out({ ok: true, offer: o, sent });
  }
  const o = list.find(x => x.id === b.id);
  if (!o) return out({ error: "That offer is gone." }, 404);
  const team = String(b.team || "");
  if (b.action === "accept" || b.action === "decline") {
    if (team !== o.to.id || o.status !== "offered") return out({ error: "Only " + o.to.name + " can answer this offer." }, 403);
    o.status = b.action === "accept" ? "accepted" : "declined"; o.answered = Date.now();
    await hotPut(env, k, list);
    await notifyTeam(env, p, lid, o.from.id, b.action === "accept"
      ? { show: 1, tag, title: "✅ " + o.to.name + " accepted your trade", body: "Tap to make it official: " + list2(o.give) + " for " + list2(o.get) + ".", url: link }
      : { show: 1, tag, title: o.to.name + " declined your trade", body: list2(o.give) + " for " + list2(o.get) + ".", url: link });
    return out({ ok: true, offer: o });
  }
  if (b.action === "withdraw") {
    if (team !== o.from.id || o.status !== "offered") return out({ error: "Only an unanswered offer can be withdrawn." }, 403);
    o.status = "withdrawn"; await hotPut(env, k, list); return out({ ok: true, offer: o });
  }
  if (b.action === "official") { // the sender opened the league site to make it official
    if (team !== o.from.id || o.status !== "accepted") return out({ error: "Not ready yet." }, 403);
    o.official = Date.now(); await hotPut(env, k, list);
    await notifyTeam(env, p, lid, o.to.id, { show: 1, tag, title: "📨 " + o.from.name + " sent your deal through", body: "Accept it on the league site to finish the trade.", url: link });
    return out({ ok: true, offer: o });
  }
  return out({ error: "Unknown action" }, 400);
}

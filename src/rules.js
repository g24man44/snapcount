// Rule-change votes: a manager proposes, every team gets one vote, it passes with a majority of votes cast once at
// least half the league has voted. Passed rules go into the league rulebook. Live state only (no KV writes).
import { hotGet, hotPut, eachSubscriber } from "./alerts.js";
import { asTeam } from "./claims.js";
const out = (d, s = 200) => new Response(JSON.stringify(d), { status: s, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const tally = pr => { const v = Object.values(pr.votes || {}); return { yes: v.filter(x => x === "yes").length, no: v.filter(x => x === "no").length }; };
function settle(R, now) {
  let changed = false;
  for (const pr of R.props) {
    if (pr.status !== "open") continue;
    const t = tally(pr), quorum = Math.ceil((pr.size || 10) / 2), all = t.yes + t.no >= (pr.size || 99);
    if (now < pr.until && !all) continue;
    pr.status = t.yes + t.no >= quorum && t.yes > t.no ? "passed" : "failed"; pr.closed = now; changed = true;
    if (pr.status === "passed") R.book.push({ id: pr.id, text: pr.text, at: now, vote: t.yes + "-" + t.no });
  }
  return changed;
}
async function tellLeague(env, p, lid, item) {
  await eachSubscriber(env, rec => (rec.leagues || []).some(L => L.p === p && String(L.id) === String(lid)) ? [item] : []);
}
export async function rulesRoute(request, env, url) {
  const p = url.searchParams.get("p") || "", lid = url.searchParams.get("lid") || "";
  if (!/^(flea|sleeper|espn|mfl)$/.test(p) || !/^[\w-]{1,40}$/.test(lid)) return out({ error: "Bad league" }, 400);
  const k = "rules:" + p + ":" + lid, R = (await hotGet(env, k)) || { props: [], book: [] }, now = Date.now();
  const before = R.props.filter(x => x.status === "open").map(x => x.id);
  if (settle(R, now)) {
    await hotPut(env, k, R);
    for (const pr of R.props.filter(x => before.includes(x.id) && x.status !== "open")) { const t = tally(pr); await tellLeague(env, p, lid, { id: "rule:" + pr.id, title: pr.status === "passed" ? "📜 Rule change passed, " + t.yes + "-" + t.no : "📜 Rule change failed, " + t.yes + "-" + t.no, body: pr.text, url: "/?rules=" + p + ":" + lid }); }
  }
  if (request.method === "GET") return out(R);
  const b = await request.json().catch(() => ({}));
  const who = await asTeam(env, p, lid, b.team, b.dev, b.teamName); if (who.error) return out({ error: who.error }, who.status);
  const team = String(b.team);
  if (b.action === "propose") {
    const text = String(b.text || "").trim().slice(0, 300), days = [2, 3, 5, 7].includes(Number(b.days)) ? Number(b.days) : 3;
    if (text.length < 8) return out({ error: "Describe the rule change." }, 400);
    if (R.props.filter(x => x.status === "open" && x.by.team === team).length >= 3) return out({ error: "You have 3 open proposals. Let those finish first." }, 429);
    const pr = { id: now.toString(36), text, by: { team, name: who.name }, at: now, until: now + days * 864e5, size: Math.max(2, Math.min(40, Number(b.size) || 10)), votes: { [team]: "yes" }, status: "open" };
    R.props.unshift(pr); R.props = R.props.slice(0, 60); await hotPut(env, k, R);
    await tellLeague(env, p, lid, { id: "rule:" + pr.id, title: "📜 " + who.name + " proposed a rule change", body: text + " Vote in Snap Count by " + new Date(pr.until).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "America/New_York" }) + ".", url: "/?rules=" + p + ":" + lid });
    return out({ ok: true, prop: pr });
  }
  const pr = R.props.find(x => x.id === String(b.id)); if (!pr) return out({ error: "That proposal is gone." }, 404);
  if (b.action === "vote") {
    if (pr.status !== "open") return out({ error: "Voting on this one has closed." }, 409);
    if (!["yes", "no"].includes(b.vote)) return out({ error: "Vote yes or no." }, 400);
    pr.votes[team] = b.vote; settle(R, Date.now()); await hotPut(env, k, R); return out({ ok: true, prop: pr });
  }
  if (b.action === "withdraw") {
    if (pr.by.team !== team || pr.status !== "open") return out({ error: "Only the proposer can withdraw an open proposal." }, 403);
    pr.status = "withdrawn"; pr.closed = now; await hotPut(env, k, R); return out({ ok: true });
  }
  return out({ error: "Unknown action" }, 400);
}

# Snap Count roadmap

The owner wants the best fantasy football app there is and doesn't want to have to ask for each improvement.
An automatic build session picks the top unchecked item, ships it, and checks it off.

## How to ship
- App: `src/index.html` (single page), Worker: `src/worker.src.js`, alerts/cron: `src/alerts.js`, integrations/AI: `src/more.js`.
- Build with `node build.js && node --check worker.js`. Also syntax-check the inline `<script>` in `src/index.html`.
- Push to `main` on github.com/g24man44/snapcount; Cloudflare Workers Builds deploys it. Confirm the check run passes.
- Owner's real league: Fleaflicker league 183120, team 1245245 ("Bumblebee tuna"), 16 teams, dynasty superflex, 18 keepers.
- Never break what works. Test in a headless browser against real Fleaflicker data before pushing. If tests fail, don't push.

## Next up (top first)
- [ ] Accessibility and light-theme polish pass.

## Blocked (needs the owner)
- [ ] Yahoo leagues: needs a Yahoo developer app (client ID and secret) for sign-in.
- [ ] Draft picks in "Send in Fleaflicker": needs a sample trade-builder link that includes a pick.

## Done
- [x] Sleeper, Fleaflicker, ESPN, MyFantasyLeague leagues
- [x] Push alerts, Discord/Slack/Teams/Telegram/ntfy/IFTTT/Zapier/Make webhooks, calendar feed
- [x] Trade grader, acceptance odds, trade finder, price finder, share-image cards
- [x] Edge tab (start/sit, waivers, playoff odds, dynasty, keepers)
- [x] AI coach (voice, streaming), AI weekly recap (manual + Tuesday auto-post)
- [x] Live win probability, every-sport scores, offline mode, app shortcuts, app badge
- [x] Sunday 11:00 ET AI pregame briefing: push + Discord/Slack post with start/sit calls, risky starters, best pickup (Alerts › Sunday pregame briefing, with preview)
- [x] League trade report card: every trade in the league graded A+ to F for each side, best/worst traders, most lopsided deals, all-time history (Leagues › your league › Trades)
- [x] Waiver bids: FAAB bid and range for the top free agents (your budget, rivals' budgets, value, week), or claim-vs-wait advice in waiver-priority leagues (Edge › Waivers)
- [x] League history & rivalries: every season's games, head-to-head for any team (nemesis, favorite victim, fiercest rivalry), champions, all-time standings, record book (Leagues › League › League history)
- [x] Player comparison: 2–4 players side by side (projection, matchup, team total, points per game, snaps, usage, dynasty and season values, rank, trend, age, who owns him) with an AI verdict (Trade tab, or Compare on any player)
- [x] Rest-of-season strength of schedule: week-by-week matchup difficulty for each starter (points allowed to his position), playoff weeks flagged, plus your remaining fantasy opponents (Edge › League)
- [x] Draft center: every league draft graded with hindsight (team grades, steals, busts, top-12 re-draft) (Edge › Dynasty); traded picks in trade grades now resolve to the player drafted, including this season's draft
- [x] Negotiate mode: practice a trade pitch against an AI playing the other manager (their roster, record, needs, values), then send the deal (Trade › Grade › Practice the pitch)

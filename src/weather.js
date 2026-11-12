// Game-day weather for every NFL game this week: wind, gusts, rain, snow and cold at the stadium during
// the game's hours (Open-Meteo forecast, no key needed), with a fantasy impact rating per position.

const UA = { "User-Agent": "SnapCount/1.0 (fantasy dashboard)", "Accept": "application/json" };
const ALIAS = { WSH: "WAS", JAC: "JAX", LA: "LAR", OAK: "LV", SD: "LAC" };
const tn = t => { t = String(t || "").toUpperCase(); return ALIAS[t] || t; };

// Home stadiums: [lat, lon, roof] — roof: "dome" (fixed), "retract" (retractable, usually closed in bad weather), "open".
const STADIUMS = {
  ARI: [33.5276, -112.2626, "retract"], ATL: [33.7554, -84.4008, "retract"], BAL: [39.2780, -76.6227, "open"], BUF: [42.7738, -78.7870, "open"],
  CAR: [35.2258, -80.8528, "open"], CHI: [41.8623, -87.6167, "open"], CIN: [39.0954, -84.5160, "open"], CLE: [41.5061, -81.6995, "open"],
  DAL: [32.7473, -97.0945, "retract"], DEN: [39.7439, -105.0201, "open"], DET: [42.3400, -83.0456, "dome"], GB: [44.5013, -88.0622, "open"],
  HOU: [29.6847, -95.4107, "retract"], IND: [39.7601, -86.1639, "retract"], JAX: [30.3239, -81.6373, "open"], KC: [39.0489, -94.4839, "open"],
  LV: [36.0909, -115.1833, "dome"], LAC: [33.9535, -118.3392, "dome"], LAR: [33.9535, -118.3392, "dome"], MIA: [25.9580, -80.2389, "open"],
  MIN: [44.9737, -93.2577, "dome"], NE: [42.0909, -71.2643, "open"], NO: [29.9511, -90.0812, "dome"], NYG: [40.8135, -74.0745, "open"],
  NYJ: [40.8135, -74.0745, "open"], PHI: [39.9008, -75.1675, "open"], PIT: [40.4468, -80.0158, "open"], SF: [37.4030, -121.9700, "open"],
  SEA: [47.5952, -122.3316, "open"], TB: [27.9759, -82.5033, "open"], TEN: [36.1665, -86.7713, "open"], WAS: [38.9076, -76.8645, "open"]
};
// Neutral-site and international venues, matched on the venue's city.
const CITIES = {
  "munich": [48.2188, 11.6247], "london": [51.5560, -0.2796], "frankfurt": [50.0686, 8.6455], "berlin": [52.5147, 13.2395],
  "madrid": [40.4531, -3.6883], "mexico city": [19.3029, -99.1505], "sao paulo": [-23.5453, -46.4742], "são paulo": [-23.5453, -46.4742],
  "dublin": [53.3607, -6.2511], "melbourne": [-37.8200, 144.9834], "rio de janeiro": [-22.9122, -43.2302], "paris": [48.8414, 2.2530]
};

// Rough rule-of-thumb changes to fantasy output by position, in percent.
const FX = {
  wind: [null, { QB: -2, WR: -2, TE: -1, K: -4 }, { QB: -6, WR: -5, TE: -4, K: -9, RB: 1, DEF: 4 }, { QB: -12, WR: -10, TE: -7, K: -16, RB: 3, DEF: 8 }],
  rain: [null, { QB: -2, WR: -2, TE: -1, K: -2, DEF: 1 }, { QB: -5, WR: -5, TE: -3, K: -6, RB: 0, DEF: 4 }, { QB: -8, WR: -8, TE: -5, K: -10, RB: 1, DEF: 6 }],
  snow: [null, { QB: -2, WR: -2, TE: -1, K: -3, DEF: 1 }, { QB: -5, WR: -5, TE: -3, K: -7, RB: 1, DEF: 3 }, { QB: -10, WR: -10, TE: -6, K: -12, RB: 3, DEF: 6 }],
  cold: [null, { QB: -1, WR: -1, K: -2 }, { QB: -3, WR: -3, TE: -1, K: -5, DEF: 1 }],
  heat: [null, {}]
};

export function rateWeather(w) {
  // w: { wind, gust, rain (in, game total), rainHr (max in/hr), prob (%), snow (in), feels (°F, coldest), temp (°F) }
  const causes = [];
  const wl = w.wind >= 20 || w.gust >= 35 ? 3 : w.wind >= 15 || w.gust >= 28 ? 2 : w.wind >= 12 || w.gust >= 24 ? 1 : 0;
  if (wl) causes.push({ k: "wind", l: wl, t: wl === 3 ? "Strong wind: deep passes and field goals suffer" : wl === 2 ? "Windy: long passes and long field goals get harder" : "Breezy: small hit to kicking" });
  const sl = w.snow >= 2 ? 3 : w.snow >= 0.5 ? 2 : w.snow >= 0.1 ? 1 : 0;
  if (sl) causes.push({ k: "snow", l: sl, t: sl === 3 ? "Heavy snow: slow game, more running, sloppy footing" : sl === 2 ? "Snow: slick ball and footing, fewer deep shots" : "Flurries possible" });
  const rl = sl >= 2 ? 0 : (w.rain >= 0.6 || w.rainHr >= 0.25) ? 3 : (w.rain >= 0.2 || w.rainHr >= 0.1) ? 2 : (w.rain >= 0.04 && (w.prob == null || w.prob >= 40)) ? 1 : 0;
  if (rl) causes.push({ k: "rain", l: rl, t: rl === 3 ? "Downpour: fumbles, drops and a run-heavy game plan" : rl === 2 ? "Steady rain: wet ball, a little less passing" : "Light rain possible" });
  const cl = w.feels != null && w.feels <= 10 ? 2 : w.feels != null && w.feels <= 22 ? 1 : 0;
  if (cl) causes.push({ k: "cold", l: cl, t: cl === 2 ? "Bitter cold: hard on kickers and passers" : "Cold: slight dip for kickers" });
  if (w.temp != null && w.temp >= 90) causes.push({ k: "heat", l: 1, t: "Hot: more rotation, fatigue late" });
  const fx = {};
  for (const c of causes) { const t = (FX[c.k] || [])[c.l] || {}; for (const pos in t) fx[pos] = (fx[pos] || 0) + t[pos]; }
  for (const pos in fx) fx[pos] = Math.max(-25, Math.min(12, fx[pos]));
  const level = causes.reduce((m, c) => Math.max(m, c.l), 0);
  return { level, causes, fx };
}

async function forecast(points) {
  // One request for every stadium. Hourly, US units, UTC times.
  if (!points.length) return [];
  const q = new URLSearchParams({
    latitude: points.map(p => p[0]).join(","), longitude: points.map(p => p[1]).join(","),
    hourly: "temperature_2m,apparent_temperature,precipitation,precipitation_probability,snowfall,wind_speed_10m,wind_gusts_10m",
    wind_speed_unit: "mph", temperature_unit: "fahrenheit", precipitation_unit: "inch", timezone: "GMT", forecast_days: "10"
  });
  const r = await fetch("https://api.open-meteo.com/v1/forecast?" + q.toString(), { headers: UA });
  if (!r.ok) throw new Error("forecast " + r.status);
  const d = await r.json();
  return Array.isArray(d) ? d : [d];
}

function gameHours(h, kickIso) {
  const k = Date.parse(kickIso); if (!h || !h.time || !k) return null;
  const start = Math.floor(k / 3600000) * 3600000, idx = [];
  h.time.forEach((t, i) => { const ms = Date.parse(t + ":00Z"); if (ms >= start && ms < start + 4 * 3600000) idx.push(i); });
  if (!idx.length) return null;
  const col = n => idx.map(i => (h[n] || [])[i]).filter(v => v != null);
  const sum = a => a.reduce((s, v) => s + v, 0), max = a => a.length ? Math.max(...a) : null, min = a => a.length ? Math.min(...a) : null;
  const wind = col("wind_speed_10m"), first3 = wind.slice(0, 3);
  return {
    wind: Math.round(first3.length ? sum(first3) / first3.length : 0), windMax: Math.round(max(wind) || 0), gust: Math.round(max(col("wind_gusts_10m")) || 0),
    rain: Math.round(sum(col("precipitation")) * 100) / 100, rainHr: Math.round((max(col("precipitation")) || 0) * 100) / 100,
    prob: max(col("precipitation_probability")), snow: Math.round(sum(col("snowfall")) * 10) / 10,
    temp: col("temperature_2m").length ? Math.round(col("temperature_2m")[0]) : null, feels: min(col("apparent_temperature")) != null ? Math.round(min(col("apparent_temperature"))) : null
  };
}

// Every game this week with its weather. Domes and closed roofs are marked and skipped.
export async function gameWeather() {
  const r = await fetch("https://site.api.espn.com/apis/site/v2/sports/football/nfl/scoreboard", { headers: UA });
  if (!r.ok) throw new Error("NFL scoreboard unavailable (" + r.status + ")");
  const sb = await r.json();
  const games = (sb.events || []).map(e => {
    const c = (e.competitions || [])[0] || {}, side = k => (c.competitors || []).find(x => x.homeAway === k) || {};
    const home = tn((side("home").team || {}).abbreviation), away = tn((side("away").team || {}).abbreviation);
    const v = c.venue || {}, city = String((v.address || {}).city || "").toLowerCase(), st = (c.status || e.status || {}).type || {};
    const homeSt = STADIUMS[home], neutral = !!c.neutralSite || (homeSt && CITIES[city]);
    const at = neutral && CITIES[city] ? CITIES[city] : homeSt ? homeSt.slice(0, 2) : null;
    const roof = neutral ? (v.indoor ? "dome" : "open") : homeSt ? homeSt[2] : (v.indoor ? "dome" : "open");
    const w = e.weather || c.weather || null;
    return { id: e.id, home, away, kick: c.date || e.date || "", state: st.state || "pre", venue: v.fullName || "", city: (v.address || {}).city || "",
      indoor: roof === "dome" || (roof === "retract" && !!v.indoor), roof, at, sky: (w && w.displayValue) || "", espnTemp: w && w.temperature != null ? w.temperature : null };
  }).filter(g => g.home && g.away);
  const need = games.filter(g => !g.indoor && g.at && g.state !== "post");
  let fc = [];
  try { fc = await forecast(need.map(g => g.at)); } catch (e) { fc = []; }
  const now = Date.now();
  need.forEach((g, i) => {
    const w = gameHours((fc[i] || {}).hourly, g.kick);
    if (!w) return;
    g.wx = w; Object.assign(g, rateWeather(w));
    g.early = Date.parse(g.kick) - now > 4 * 86400000;
  });
  games.forEach(g => { if (g.level == null) { g.level = 0; g.causes = []; g.fx = {}; } });
  games.sort((a, b) => b.level - a.level || (b.wx ? b.wx.wind : -1) - (a.wx ? a.wx.wind : -1) || Date.parse(a.kick) - Date.parse(b.kick));
  return { games, week: (sb.week || {}).number || null, at: new Date().toISOString(), source: fc.length ? "Open-Meteo" : null };
}

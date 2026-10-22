/**
 * Proxy del SMN para la app "Tiempo SMN" — Cloudflare Worker.
 *
 * Fuente de datos: archivos de datos abiertos del SMN (no requieren token):
 *   https://ssl.smn.gob.ar/dpd/descarga_opendata.php?file=...
 *     observaciones/tiepreYYYYMMDD.txt  -> última observación de cada estación
 *     pron5d/pronYYYYMMDD.txt           -> pronóstico de modelo a 5 días, cada 3 h
 *
 * Qué hace:
 *   - Descarga y parsea esos archivos (fecha de Argentina, UTC-3; si el de hoy no está, usa el de ayer).
 *   - Guarda el resultado ya parseado en la caché de Cloudflare (observaciones 10 min, pronóstico 60 min).
 *   - Elige la estación (por WMO, o la más cercana a lat/lon con ese dato) y responde JSON con CORS.
 *
 * Rutas (todas GET):
 *   /weather?wmo=&lat=&lon=   -> tiempo actual de la estación
 *   /forecast?wmo=&lat=&lon=  -> pronóstico 5 días (resumen por día + franjas de 6 h)
 *   /coord?lat=&lon=          -> estación con observación más cercana (fila tipo búsqueda del SMN)
 *   /search?q=texto           -> localidades (pasa directo a la búsqueda abierta del SMN)
 *   /health                   -> fechas de los archivos en uso
 *
 * La tabla de estaciones (src/stations.js) se genera con: node proxy/scripts/build-stations.mjs
 */

import { decodeText, argentinaYmd, parseObservations, parseForecast, daySummary } from "./opendata.js";
import { pickStation } from "./pick.js";
import { STATIONS } from "./stations.js";

const OPEN_DATA = "https://ssl.smn.gob.ar/dpd/descarga_opendata.php?file=";
const SMN_API = "https://ws1.smn.gob.ar/v1";
const SMN_WEB = "https://www.smn.gob.ar/";
const MISSING_TTL = 300; // segundos que se recuerda que el archivo de hoy todavía no existe
const MAX_OBS_AGE_MS = 6 * 3600 * 1000; // una observación más vieja se usa solo si no hay otra

const SOURCES = {
  obs: { dir: "observaciones", prefix: "tiepre", ttl: 600, parse: parseObservations, isEmpty: (d) => d.length === 0 },
  fc: { dir: "pron5d", prefix: "pron", ttl: 3600, parse: parseForecast, isEmpty: (d) => Object.keys(d).length === 0 },
};
const CLIENT_TTL = { weather: 300, forecast: 900, coord: 3600, search: 86400 };

class UpstreamError extends Error {}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
    if (request.method !== "GET") return json({ error: "Método no permitido" }, 405, cors);

    try {
      switch (url.pathname) {
        case "/health": return await health(ctx, cors);
        case "/search": return await search(url, ctx, cors);
        case "/weather": return await weather(url, ctx, cors);
        case "/forecast": return await forecast(url, ctx, cors);
        case "/coord": return await coord(url, ctx, cors);
        default: return json({ error: "Ruta inexistente" }, 404, cors);
      }
    } catch (err) {
      if (err instanceof UpstreamError) return json({ error: "smn", message: err.message }, 502, cors);
      return json({ error: "Error interno del proxy", detail: String((err && err.message) || err) }, 500, cors);
    }
  },
};

// ---------- Rutas ----------

async function weather(url, ctx, cors) {
  const q = readLocation(url);
  if (q.error) return json({ error: q.error }, 400, cors);

  const { date, data } = await loadDaily("obs", ctx);
  const picked = pickObserved(data, q);
  if (!picked) return json({ error: "station", message: "No hay una estación con datos para esa ubicación." }, 404, cors);

  const { station, distance_km, row } = picked;
  return json({
    date: row.date,
    temperature: row.temperature,
    feels_like: row.feels_like,
    humidity: row.humidity,
    pressure: row.pressure,
    visibility: row.visibility_km,
    weather: { description: row.description },
    wind: row.wind,
    station: { wmo: station.wmo, name: row.name, distance_km },
    location: { name: row.name, distance: distance_km },
    source_date: date,
  }, 200, { ...cors, "Cache-Control": `public, max-age=${CLIENT_TTL.weather}` });
}

async function forecast(url, ctx, cors) {
  const q = readLocation(url);
  if (q.error) return json({ error: q.error }, 400, cors);

  const { date, data } = await loadDaily("fc", ctx);
  const picked = pickStation(STATIONS.map((s) => ({ ...s, fc: data[s.fc] ? s.fc : null })), "fc", q);
  if (!picked) return json({ error: "station", message: "No hay pronóstico para esa ubicación." }, 404, cors);

  const { station, distance_km } = picked;
  const today = isoDate(argentinaYmd(new Date()));
  const days = daySummary(data[station.fc]).filter((d) => d.date >= today).slice(0, 5);
  return json({
    updated: isoDate(date),
    station: { wmo: station.wmo, name: station.obs || titleCase(station.name), distance_km },
    forecast: days,
  }, 200, { ...cors, "Cache-Control": `public, max-age=${CLIENT_TTL.forecast}` });
}

async function coord(url, ctx, cors) {
  const q = readLocation(url);
  if (q.error || q.lat == null) return json({ error: q.error || "lat/lon inválidos" }, 400, cors);

  const { data } = await loadDaily("obs", ctx);
  const picked = pickObserved(data, { lat: q.lat, lon: q.lon });
  if (!picked) return json({ error: "station", message: "No hay una estación cercana." }, 404, cors);

  const { station, distance_km, row } = picked;
  return json([
    "st-" + station.wmo, row.name, "", provinceName(station.province), station.wmo, null,
    station.lon, station.lat, distance_km, row.name,
  ], 200, { ...cors, "Cache-Control": `public, max-age=${CLIENT_TTL.coord}` });
}

async function search(url, ctx, cors) {
  const q = (url.searchParams.get("q") || "").trim();
  if (q.length < 2) return json([], 200, cors);

  const cache = caches.default;
  const key = new Request("https://cache.tiempo-smn/search?q=" + encodeURIComponent(q.toLowerCase()));
  const hit = await cache.match(key);
  if (hit) return withHeaders(hit, { ...cors, "X-Cache": "HIT" });

  let res;
  try {
    res = await fetch(`${SMN_API}/georef/location/search?name=${encodeURIComponent(q)}`, {
      headers: { Accept: "application/json", Origin: "https://www.smn.gob.ar", Referer: SMN_WEB },
    });
  } catch {
    throw new UpstreamError("No se pudo conectar con el SMN.");
  }
  if (!res.ok) throw new UpstreamError("El SMN respondió con error " + res.status + ".");

  const out = new Response(await res.text(), {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${CLIENT_TTL.search}` },
  });
  ctx.waitUntil(cache.put(key, out.clone()));
  return withHeaders(out, { ...cors, "X-Cache": "MISS" });
}

async function health(ctx, cors) {
  const [obs, fc] = await Promise.all([loadDaily("obs", ctx), loadDaily("fc", ctx)]);
  return json({
    ok: true,
    source: "smn-opendata",
    observations_date: isoDate(obs.date),
    forecast_date: isoDate(fc.date),
    stations: STATIONS.length,
  }, 200, cors);
}

// ---------- Datos abiertos ----------

/**
 * Devuelve { date: "YYYYMMDD", data } ya parseado. Prueba el archivo de hoy y, si no existe
 * o está vacío, el de ayer. La caché guarda el JSON parseado por archivo, no por estación.
 */
async function loadDaily(kind, ctx) {
  const src = SOURCES[kind];
  const cache = caches.default;
  const now = new Date();
  let failure = null;

  for (let back = 0; back < 2; back++) {
    const ymd = argentinaYmd(now, back);
    const key = new Request(`https://cache.tiempo-smn/opendata/${kind}/${ymd}`);

    const hit = await cache.match(key);
    if (hit) {
      const cached = await hit.json();
      if (!cached.missing) return cached;
      continue;
    }

    let res;
    try {
      res = await fetch(`${OPEN_DATA}${src.dir}/${src.prefix}${ymd}.txt`);
    } catch (e) {
      failure = e;
      continue;
    }
    if (!res.ok) { failure = new Error("HTTP " + res.status); continue; }

    const data = src.parse(decodeText(new Uint8Array(await res.arrayBuffer())));
    if (src.isEmpty(data)) {
      // El SMN responde 200 con "El archivo no existe." cuando todavía no publicó el del día
      ctx.waitUntil(cache.put(key, cacheable({ date: ymd, missing: true }, MISSING_TTL)));
      continue;
    }
    const payload = { date: ymd, data };
    ctx.waitUntil(cache.put(key, cacheable(payload, src.ttl)));
    return payload;
  }
  throw new UpstreamError(failure ? "No se pudieron leer los datos abiertos del SMN." : "El SMN no publicó datos recientes.");
}

const cacheable = (obj, ttl) => new Response(JSON.stringify(obj), {
  headers: { "Content-Type": "application/json", "Cache-Control": `public, max-age=${ttl}` },
});

/** Estación con observación para `q` ({wmo, lat, lon}); prefiere observaciones de las últimas 6 h. */
function pickObserved(rows, q) {
  const byName = new Map(rows.map((r) => [r.name, r]));
  const now = Date.now();
  const build = (maxAgeMs) => STATIONS.map((s) => {
    const r = byName.get(s.obs);
    const ok = r && (maxAgeMs == null || now - Date.parse(r.date) <= maxAgeMs);
    return { ...s, obs: ok ? s.obs : null };
  });
  const picked = pickStation(build(MAX_OBS_AGE_MS), "obs", q) || pickStation(build(null), "obs", q);
  return picked && { ...picked, row: byName.get(picked.station.obs) };
}

// ---------- Utilidades ----------

/** Lee wmo/lat/lon del query. Devuelve { wmo, lat, lon } o { error }. */
function readLocation(url) {
  const p = url.searchParams;
  const out = { wmo: null, lat: null, lon: null };

  if (p.get("wmo")) {
    if (!/^\d{1,6}$/.test(p.get("wmo"))) return { error: "wmo inválido" };
    out.wmo = Number(p.get("wmo"));
  }
  const hasLat = p.get("lat") !== null && p.get("lat") !== "";
  const hasLon = p.get("lon") !== null && p.get("lon") !== "";
  if (hasLat || hasLon) {
    const lat = Number(p.get("lat"));
    const lon = Number(p.get("lon"));
    if (!hasLat || !hasLon || !Number.isFinite(lat) || !Number.isFinite(lon) || Math.abs(lat) > 90 || Math.abs(lon) > 180) {
      return { error: "lat/lon inválidos" };
    }
    out.lat = lat;
    out.lon = lon;
  }
  if (out.wmo === null && out.lat === null) return { error: "Falta wmo o lat/lon" };
  return out;
}

const isoDate = (ymd) => `${ymd.slice(0, 4)}-${ymd.slice(4, 6)}-${ymd.slice(6, 8)}`;

const ACCENTED = {
  CORDOBA: "Córdoba", TUCUMAN: "Tucumán", "ENTRE RIOS": "Entre Ríos", NEUQUEN: "Neuquén",
  "RIO NEGRO": "Río Negro",
};
const titleCase = (s) => s.toLowerCase()
  .replace(/(^|\s)(\S)/g, (_, a, b) => a + b.toUpperCase())
  .replace(/\b(De|Del|La|El)\b(?!$)/g, (m, w, i) => (i === 0 ? m : m.toLowerCase()));
const provinceName = (p) => ACCENTED[p] || titleCase(p);

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
  };
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json; charset=utf-8", ...headers },
  });
}

function withHeaders(res, extra) {
  const h = new Headers(res.headers);
  for (const [k, v] of Object.entries(extra)) h.set(k, v);
  return new Response(res.body, { status: res.status, headers: h });
}

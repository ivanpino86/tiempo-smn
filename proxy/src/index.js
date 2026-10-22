/**
 * Proxy del SMN para la app "Tiempo SMN" — Cloudflare Worker.
 *
 * Por qué existe:
 *   - La API ws1.smn.gob.ar exige un token JWT (header "Authorization: JWT <token>")
 *     para tiempo actual, pronóstico y alertas.
 *   - Ese header solo se acepta desde smn.gob.ar (el CORS bloquea a cualquier otro sitio).
 *   - El token vive 1 hora y viene embebido en el HTML de www.smn.gob.ar,
 *     que está detrás de un desafío de Cloudflare.
 *
 * Qué hace:
 *   - Guarda el token vigente en KV (binding TOKENS).
 *   - Si el token venció, intenta sacarlo del HTML del SMN (puede fallar por Cloudflare).
 *   - Recibe tokens nuevos por POST /token (los manda el script de GitHub Actions).
 *   - Llama a la API con el token, cachea respuestas y devuelve todo con CORS abierto.
 *
 * Rutas:
 *   GET  /search?q=texto      -> localidades (no necesita token)
 *   GET  /weather/:id         -> tiempo actual
 *   GET  /forecast/:id        -> pronóstico 7 días
 *   GET  /alerts/:id          -> alertas de la localidad
 *   GET  /coord?lat=&lon=     -> localidad más cercana a unas coordenadas
 *   GET  /health              -> estado del token
 *   POST /token               -> guarda un token nuevo (Authorization: Bearer ADMIN_SECRET)
 */

const SMN_API = "https://ws1.smn.gob.ar/v1";
const SMN_WEB = "https://www.smn.gob.ar/";
const TOKEN_KEY = "smn_token";
const TOKEN_RE = /localStorage\.setItem\(\s*['"]token['"]\s*,\s*['"]([A-Za-z0-9._-]+)['"]\s*\)/;

// Segundos de caché por tipo de dato
const TTL = { search: 86400, weather: 600, forecast: 1800, alerts: 600 };

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const cors = corsHeaders(request, env);

    if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });

    try {
      if (request.method === "POST" && url.pathname === "/token") return await saveToken(request, env, cors);
      if (request.method !== "GET") return json({ error: "Método no permitido" }, 405, cors);

      if (url.pathname === "/health") return await health(env, cors);

      if (url.pathname === "/search") {
        const q = (url.searchParams.get("q") || "").trim();
        if (q.length < 2) return json([], 200, cors);
        return await proxied(`/georef/location/search?name=${encodeURIComponent(q)}`, TTL.search, false, env, ctx, cors);
      }

      if (url.pathname === "/coord") {
        const lat = Number(url.searchParams.get("lat"));
        const lon = Number(url.searchParams.get("lon"));
        if (!isFinite(lat) || !isFinite(lon)) return json({ error: "lat/lon inválidos" }, 400, cors);
        // Redondeo a 2 decimales (~1 km): mejora la caché y no guarda la ubicación exacta
        return await proxied(`/georef/location/coord?lat=${lat.toFixed(2)}&lon=${lon.toFixed(2)}`, TTL.search, true, env, ctx, cors);
      }

      const m = url.pathname.match(/^\/(weather|forecast|alerts)\/(\d{1,7})$/);
      if (m) {
        const [, kind, id] = m;
        const path = kind === "alerts" ? `/warning/alert/location/${id}` : `/${kind}/location/${id}`;
        return await proxied(path, TTL[kind], true, env, ctx, cors);
      }

      return json({ error: "Ruta inexistente" }, 404, cors);
    } catch (err) {
      return json({ error: "Error interno del proxy", detail: String(err && err.message || err) }, 500, cors);
    }
  },
};

// ---------- Llamadas a la API con caché ----------

async function proxied(path, ttl, needsToken, env, ctx, cors) {
  const cache = caches.default;
  const cacheKey = new Request("https://cache.tiempo-smn" + path);
  const hit = await cache.match(cacheKey);
  if (hit) return withHeaders(hit, { ...cors, "X-Cache": "HIT" });

  let res = await callSmn(path, needsToken ? await getToken(env, false) : null);

  // Token vencido o inválido: intento conseguir uno nuevo y reintento una sola vez
  if (needsToken && res.status === 401) {
    const fresh = await getToken(env, true);
    if (fresh) res = await callSmn(path, fresh);
  }

  if (res.status === 401) {
    return json({ error: "token", message: "El proxy no tiene un token vigente del SMN. Esperá la próxima renovación o revisá el workflow." }, 503, cors);
  }
  if (!res.ok) {
    return json({ error: "smn", status: res.status, message: "El SMN respondió con error." }, 502, cors);
  }

  const body = await res.text();
  const out = new Response(body, {
    status: 200,
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": `public, max-age=${ttl}` },
  });
  ctx.waitUntil(cache.put(cacheKey, out.clone()));
  return withHeaders(out, { ...cors, "X-Cache": "MISS" });
}

function callSmn(path, token) {
  const headers = { Accept: "application/json", Origin: "https://www.smn.gob.ar", Referer: SMN_WEB };
  if (token) headers.Authorization = "JWT " + token;
  return fetch(SMN_API + path, { headers });
}

// ---------- Manejo del token ----------

async function getToken(env, forceRefresh) {
  const stored = await env.TOKENS.get(TOKEN_KEY);
  if (!forceRefresh && stored && secondsLeft(stored) > 60) return stored;

  const scraped = await scrapeToken();
  if (scraped && secondsLeft(scraped) > 60) {
    await env.TOKENS.put(TOKEN_KEY, scraped);
    return scraped;
  }
  // Si no pude renovar, devuelvo el guardado (si la API lo rechaza, se avisa al usuario)
  return stored;
}

async function scrapeToken() {
  try {
    const res = await fetch(SMN_WEB, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml",
        "Accept-Language": "es-AR,es;q=0.9",
      },
    });
    if (!res.ok) return null; // 403 = desafío de Cloudflare
    const m = (await res.text()).match(TOKEN_RE);
    return m ? m[1] : null;
  } catch {
    return null;
  }
}

async function saveToken(request, env, cors) {
  const auth = request.headers.get("Authorization") || "";
  if (!env.ADMIN_SECRET || auth !== "Bearer " + env.ADMIN_SECRET) return json({ error: "No autorizado" }, 401, cors);

  let token = "";
  try { token = ((await request.json()).token || "").trim(); } catch { /* cuerpo inválido */ }
  if (!/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(token)) return json({ error: "Token con formato inválido" }, 400, cors);

  const left = secondsLeft(token);
  if (left <= 0) return json({ error: "El token ya venció" }, 400, cors);

  await env.TOKENS.put(TOKEN_KEY, token);
  return json({ ok: true, expires_in: left }, 200, cors);
}

async function health(env, cors) {
  const t = await env.TOKENS.get(TOKEN_KEY);
  const left = t ? secondsLeft(t) : 0;
  return json({ token: t ? (left > 0 ? "vigente" : "vencido") : "sin token", expires_in: Math.max(0, left) }, 200, cors);
}

function secondsLeft(token) {
  try {
    const b64 = token.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const payload = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return payload.exp ? payload.exp - Math.floor(Date.now() / 1000) : 3600;
  } catch {
    return 0;
  }
}

// ---------- Utilidades ----------

function corsHeaders(request, env) {
  const allowed = (env.ALLOWED_ORIGINS || "*").split(",").map((s) => s.trim());
  const origin = request.headers.get("Origin") || "";
  const allow = allowed.includes("*") ? "*" : (allowed.includes(origin) ? origin : allowed[0]);
  return {
    "Access-Control-Allow-Origin": allow,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
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

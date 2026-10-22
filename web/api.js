// Capa de acceso a datos. Toda la app habla con el SMN a través de este archivo,
// así cuando se pase a Android (Capacitor) solo hay que cambiar acá cómo se hacen las llamadas.
(function () {
  const SMN_API = "https://ws1.smn.gob.ar/v1";
  const cfg = window.SMN_CONFIG || {};
  const PROXY = (cfg.PROXY_URL || "").replace(/\/+$/, "");

  class ApiError extends Error {
    constructor(code, message) { super(message); this.code = code; }
  }

  async function getJson(url, signal) {
    let res;
    try {
      res = await fetch(url, { signal, credentials: "omit", headers: { Accept: "application/json" } });
    } catch (e) {
      if (e.name === "AbortError") throw e;
      throw new ApiError("network", "Sin conexión con el servidor.");
    }
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      if (res.status === 502 || res.status === 503) throw new ApiError("unavailable", body.message || "Servicio no disponible.");
      if (res.status === 404 && body.error === "station") throw new ApiError("no_station", body.message || "No hay una estación para esa ubicación.");
      throw new ApiError("http", "El servidor respondió " + res.status + ".");
    }
    return res.json();
  }

  // Fila de búsqueda del SMN: [id, nombre, departamento, provincia, idEstación, idPronóstico, lon, lat, distanciaKm, nombreEstación]
  function normalizeRow(r) {
    if (Array.isArray(r)) {
      return { id: r[0], name: r[1], department: r[2], province: r[3], wmo: r[4], lon: r[6], lat: r[7], distance: r[8], station: r[9] };
    }
    if (r && typeof r === "object") {
      return {
        id: r.id, name: r.name, department: r.department, province: r.province, wmo: r.wmo || null,
        lon: r.coord && r.coord.lon, lat: r.coord && r.coord.lat, distance: r.distance, station: r.station || "",
      };
    }
    return null;
  }

  function requireProxy() {
    if (!PROXY) throw new ApiError("no_proxy", "Falta configurar PROXY_URL en config.js.");
  }

  async function searchLocations(query, signal) {
    const q = query.trim();
    if (q.length < 2) return [];
    let rows;
    if (cfg.DIRECT_SEARCH !== false) {
      try {
        rows = await getJson(SMN_API + "/georef/location/search?name=" + encodeURIComponent(q), signal);
      } catch (e) {
        if (e.name === "AbortError" || !PROXY) throw e;
      }
    }
    if (!rows) {
      requireProxy();
      rows = await getJson(PROXY + "/search?q=" + encodeURIComponent(q), signal);
    }
    return (Array.isArray(rows) ? rows : []).map(normalizeRow).filter(Boolean);
  }

  // Query con la estación (WMO) y las coordenadas de la localidad; el proxy elige la estación.
  // Las localidades guardadas por versiones viejas de la app pueden no tener ninguno de los dos.
  function locationQuery(loc) {
    const p = [];
    const wmo = loc && Number(loc.wmo);
    if (wmo > 0) p.push("wmo=" + wmo);
    const lat = loc && Number(loc.lat), lon = loc && Number(loc.lon);
    if (loc && loc.lat != null && loc.lon != null && isFinite(lat) && isFinite(lon)) p.push("lat=" + lat, "lon=" + lon);
    if (!p.length) throw new ApiError("no_location", "Esta localidad guardada no tiene ubicación.");
    return p.join("&");
  }

  async function getWeather(loc, signal) {
    requireProxy();
    return getJson(PROXY + "/weather?" + locationQuery(loc), signal);
  }

  async function getForecast(loc, signal) {
    requireProxy();
    return getJson(PROXY + "/forecast?" + locationQuery(loc), signal);
  }

  async function locationByCoords(lat, lon, signal) {
    requireProxy();
    const data = await getJson(PROXY + "/coord?lat=" + lat + "&lon=" + lon, signal);
    return normalizeRow(Array.isArray(data) && Array.isArray(data[0]) ? data[0] : data);
  }

  window.SMN = { searchLocations, getWeather, getForecast, locationByCoords, ApiError, hasProxy: !!PROXY };
})();

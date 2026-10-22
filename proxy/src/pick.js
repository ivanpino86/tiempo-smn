// Pure helpers to map a requested location to an SMN station.

const R_EARTH_KM = 6371;
const rad = (d) => (d * Math.PI) / 180;

export function haversineKm(lat1, lon1, lat2, lon2) {
  const dLat = rad(lat2 - lat1);
  const dLon = rad(lon2 - lon1);
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(rad(lat1)) * Math.cos(rad(lat2)) * Math.sin(dLon / 2) ** 2;
  return 2 * R_EARTH_KM * Math.asin(Math.min(1, Math.sqrt(a)));
}

const round1 = (n) => Math.round(n * 10) / 10;
const isNum = (v) => typeof v === "number" && Number.isFinite(v);

/**
 * Choose the station for a request.
 * `field` is "obs" (observations) or "fc" (forecast): only stations that have it qualify.
 * A matching `wmo` wins; otherwise the nearest qualifying station to lat/lon.
 * Returns { station, distance_km } (distance_km is null without coordinates) or null.
 */
export function pickStation(stations, field, { wmo, lat, lon } = {}) {
  const usable = stations.filter((s) => s[field]);
  const hasCoords = isNum(lat) && isNum(lon);
  const dist = (s) => (hasCoords ? round1(haversineKm(lat, lon, s.lat, s.lon)) : null);

  if (wmo != null) {
    const exact = usable.find((s) => s.wmo === Number(wmo));
    if (exact) return { station: exact, distance_km: dist(exact) };
  }
  if (!hasCoords) return null;

  let best = null;
  for (const s of usable) {
    const d = haversineKm(lat, lon, s.lat, s.lon);
    if (!best || d < best.d) best = { station: s, d };
  }
  return best && { station: best.station, distance_km: round1(best.d) };
}

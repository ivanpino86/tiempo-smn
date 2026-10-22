/**
 * Pure parsers for the SMN open data files (no fetch, no Worker APIs).
 *
 *   estaciones_smn.txt  fixed-width station list
 *   tiepreYYYYMMDD.txt  latest observation per station, ";" separated
 *   pronYYYYMMDD.txt    5-day model forecast, 3-hourly, one block per station
 *
 * All timestamps are Argentina local time (UTC-3, no DST).
 */

const TZ = "-03:00";
const MONTHS_ES = {
  enero: 1, febrero: 2, marzo: 3, abril: 4, mayo: 5, junio: 6, julio: 7,
  agosto: 8, septiembre: 9, setiembre: 9, octubre: 10, noviembre: 11, diciembre: 12,
};
const MONTHS_ABBR = {
  ENE: 1, FEB: 2, MAR: 3, ABR: 4, MAY: 5, JUN: 6, JUL: 7, AGO: 8, SEP: 9, SET: 9, OCT: 10, NOV: 11, DIC: 12,
};
// The forecast file contains garbage precipitation values (e.g. 850.0, 2261630.0) on its last step.
const MAX_RAIN_MM = 300;
const GENERIC_TOKENS = new Set(["AERO", "OBS", "OBSERVATORIO"]);

const pad = (n) => String(n).padStart(2, "0");
const round1 = (n) => Math.round(n * 10) / 10;

/** Decode bytes as UTF-8, falling back to latin1 (the files are served in either). */
export function decodeText(bytes) {
  const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(u8);
  } catch {
    let s = "";
    for (let i = 0; i < u8.length; i++) s += String.fromCharCode(u8[i]);
    return s;
  }
}

/** Strip accents, uppercase, turn "_ . ( ) -" into spaces and collapse whitespace. */
export function normName(s) {
  return String(s || "")
    .normalize("NFD").replace(/[̀-ͯ]/g, "")
    .toUpperCase()
    .replace(/[_.()\-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** normName without generic station-type tokens (AERO, OBS, OBSERVATORIO). Use only after exact matching fails. */
export function stripName(s) {
  const n = normName(s).split(" ").filter((t) => !GENERIC_TOKENS.has(t)).join(" ");
  return n || normName(s);
}

/** YYYYMMDD in Argentina time (UTC-3), optionally `daysBack` days earlier. */
export function argentinaYmd(date = new Date(), daysBack = 0) {
  const d = new Date(date.getTime() - 3 * 3600 * 1000 - daysBack * 86400 * 1000);
  return `${d.getUTCFullYear()}${pad(d.getUTCMonth() + 1)}${pad(d.getUTCDate())}`;
}

const lines = (text) => String(text || "").replace(/^﻿/, "").split(/\r?\n/);
const num = (s) => {
  const m = String(s == null ? "" : s).replace(",", ".").match(/-?\d+(\.\d+)?/);
  return m ? Number(m[0]) : null;
};
const dms = (deg, min) => {
  const sign = deg < 0 || Object.is(deg, -0) ? -1 : 1;
  return Math.round(sign * (Math.abs(deg) + min / 60) * 10000) / 10000;
};

/** estaciones_smn.txt -> [{ wmo, name, province, lat, lon }] */
export function parseStations(text) {
  const out = [];
  for (const line of lines(text)) {
    const name = line.slice(0, 30).trim();
    const m = line.slice(30).match(/^\s*([^\d-]+?)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(\d+)\s+(-?\d+)\s+(\d{4,6})\b/);
    if (!name || !m) continue; // headers, blanks and wrapped continuation lines
    out.push({
      wmo: Number(m[7]),
      name,
      province: m[1].trim(),
      lat: dms(Number(m[2]), Number(m[3])),
      lon: dms(Number(m[4]), Number(m[5])),
    });
  }
  return out;
}

/** tiepreYYYYMMDD.txt -> one object per station line. */
export function parseObservations(text) {
  const out = [];
  for (const line of lines(text)) {
    const f = line.split(";");
    if (f.length < 10) continue;
    const d = f[1].trim().match(/^(\d{1,2})-([a-záéíóú]+)-(\d{4})$/i);
    const t = f[2].trim().match(/^(\d{1,2}):(\d{2})$/);
    const month = d && MONTHS_ES[d[2].toLowerCase()];
    const temperature = num(f[5]);
    if (!d || !t || !month || temperature === null) continue;

    const w = f[8].trim();
    const wm = w.match(/^(.*?)\s+(\d+)$/);
    const wind = wm ? { direction: wm[1] || null, speed: Number(wm[2]) }
      : { direction: null, speed: /calma/i.test(w) ? 0 : num(w) };
    const feels = /^-?\d+([.,]\d+)?$/.test(f[6].trim()) ? num(f[6]) : null;

    out.push({
      name: f[0].trim(),
      date: `${d[3]}-${pad(month)}-${pad(d[1])}T${pad(t[1])}:${t[2]}:00${TZ}`,
      description: f[3].trim(),
      visibility_km: num(f[4]),
      temperature,
      feels_like: feels,
      humidity: num(f[7]),
      wind,
      pressure: num(f[9]),
    });
  }
  return out;
}

const ROW_RE = /^\s*(\d{1,2})\/([A-Za-z]{3})\/(\d{4}) (\d{1,2})Hs\.\s+(-?\d+(?:\.\d+)?)\s+(\d+)\s*\|\s*(\d+)\s+(\d+(?:\.\d+)?)\s*$/;

/** pronYYYYMMDD.txt -> { RAW_STATION_NAME: [{ time, temperature, wind_deg, wind_speed, rain_mm }] } */
export function parseForecast(text) {
  const all = lines(text);
  const out = {};
  let current = null;
  for (let i = 0; i < all.length; i++) {
    const line = all[i];
    // A station block starts with an unindented name line followed by a "====" line
    if (line && !/^[=\s*]/.test(line) && i + 1 < all.length && /^=+\s*$/.test(all[i + 1])) {
      current = line.trim();
      out[current] = out[current] || [];
      continue;
    }
    const m = current && line.match(ROW_RE);
    const month = m && MONTHS_ABBR[m[2].toUpperCase()];
    if (!m || !month) continue;
    const rain = Number(m[8]);
    out[current].push({
      time: `${m[3]}-${pad(month)}-${pad(m[1])}T${pad(m[4])}:00:00${TZ}`,
      temperature: Number(m[5]),
      wind_deg: Number(m[6]),
      wind_speed: Number(m[7]),
      rain_mm: rain >= MAX_RAIN_MM ? null : rain,
    });
  }
  return out;
}

const SLOTS = [["early_morning", 3], ["morning", 9], ["afternoon", 15], ["night", 21]];

/** Group 3-hourly rows into days with min/max, total rain and four 6-hour slots. */
export function daySummary(rows) {
  const byDay = new Map();
  for (const r of rows || []) {
    const day = r.time.slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(r);
  }
  const hourOf = (r) => Number(r.time.slice(11, 13));
  const rain = (r) => (r && r.rain_mm != null ? r.rain_mm : 0);
  return [...byDay.entries()].map(([date, list]) => {
    const temps = list.map((r) => r.temperature);
    const day = {
      date,
      temp_min: Math.min(...temps),
      temp_max: Math.max(...temps),
      rain_mm: round1(list.reduce((s, r) => s + rain(r), 0)),
    };
    for (const [key, hour] of SLOTS) {
      const idx = list.findIndex((r) => hourOf(r) === hour);
      if (idx < 0) { day[key] = null; continue; }
      const r = list[idx];
      day[key] = {
        temperature: r.temperature,
        rain06h: round1(rain(r) + (idx > 0 ? rain(list[idx - 1]) : 0)),
        wind: { deg: r.wind_deg, speed: r.wind_speed },
      };
    }
    return day;
  });
}

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import {
  decodeText, normName, stripName, argentinaYmd,
  parseStations, parseObservations, parseForecast, daySummary,
} from "../src/opendata.js";

const fx = (name) => new Uint8Array(readFileSync(new URL("./fixtures/" + name, import.meta.url)));

test("decodeText reads UTF-8 and falls back to latin1", () => {
  assert.equal(decodeText(new TextEncoder().encode("Córdoba Peña")), "Córdoba Peña");
  assert.equal(decodeText(Uint8Array.from([0x43, 0xf3, 0x72, 0x64, 0x6f, 0x62, 0x61])), "Córdoba");
  assert.equal(decodeText(new ArrayBuffer(0)), "");
});

test("normName strips accents, case, punctuation and underscores", () => {
  assert.equal(normName("Córdoba Observatorio"), "CORDOBA OBSERVATORIO");
  assert.equal(normName("CORDOBA_OBSERVATORIO"), "CORDOBA OBSERVATORIO");
  assert.equal(normName("MERCEDES_AERO_(CTES)"), "MERCEDES AERO CTES");
  assert.equal(normName("PCIA._ROQUE_SAENZ_PEÑA_AERO"), "PCIA ROQUE SAENZ PENA AERO");
  assert.equal(normName("  Pilar   Obs. "), "PILAR OBS");
});

test("stripName drops generic station-type tokens only", () => {
  assert.equal(stripName("Córdoba"), "CORDOBA");
  assert.equal(stripName("CORDOBA_AERO"), "CORDOBA");
  assert.equal(stripName("Pilar Obs."), "PILAR");
  assert.equal(stripName("PILAR OBSERVATORIO"), "PILAR");
  assert.equal(stripName("Aeroparque Buenos Aires"), "AEROPARQUE BUENOS AIRES");
});

test("argentinaYmd uses UTC-3 and can step back days", () => {
  assert.equal(argentinaYmd(new Date("2026-10-22T14:00:00Z")), "20261022");
  assert.equal(argentinaYmd(new Date("2026-10-22T01:00:00Z")), "20261021");
  assert.equal(argentinaYmd(new Date("2026-10-22T14:00:00Z"), 1), "20261021");
  assert.equal(argentinaYmd(new Date("2026-03-01T05:00:00Z"), 1), "20260228");
});

test("parseStations parses fixed-width rows into decimal degrees", () => {
  const st = parseStations(decodeText(fx("estaciones_smn.txt")));
  assert.equal(st.length, 8);
  const obs = st.find((s) => s.wmo === 87345);
  assert.equal(obs.name, "CORDOBA OBSERVATORIO");
  assert.equal(obs.province, "CORDOBA");
  assert.ok(Math.abs(obs.lat - (-31 - 25 / 60)) < 1e-3);
  assert.ok(Math.abs(obs.lon - (-64 - 11 / 60)) < 1e-3);
  assert.ok(obs.lat < 0 && obs.lon < 0);
});

test("parseStations handles long, truncated and parenthesized names", () => {
  const st = parseStations(decodeText(fx("estaciones_smn.txt")));
  const names = st.map((s) => s.name);
  assert.ok(names.includes("PRESIDENCIA ROQUE SAENZ PEÑA A"));
  assert.ok(names.includes("BASE CARLINI (EX JUBANY)"));
  assert.ok(names.includes("MERCEDES AERO (CTES)"));
  assert.equal(st.find((s) => s.wmo === 87281).province, "CORRIENTES");
});

test("parseStations ignores headers, blanks and wrapped continuation lines", () => {
  const text = [
    "NOMBRE   PROVINCIA   LATITUD",
    "          [gr] [min]",
    "ROSARIO AERO                   SANTA FE                             -32      55       -60      47         25  87480 SAAR",
    "                  SAAR",
    "",
  ].join("\r\n");
  const st = parseStations(text);
  assert.equal(st.length, 1);
  assert.equal(st[0].wmo, 87480);
});

test("parseObservations parses a full row with accents (latin1 file)", () => {
  const rows = parseObservations(decodeText(fx("tiepre.txt")));
  assert.equal(rows.length, 8);
  const r = rows.find((x) => x.name === "Córdoba Observatorio");
  assert.deepEqual(r, {
    name: "Córdoba Observatorio",
    date: "2026-10-22T11:00:00-03:00",
    description: "Parcialmente nublado",
    visibility_km: 10,
    temperature: 22.2,
    feels_like: null,
    humidity: 69,
    wind: { direction: "Sudeste", speed: 5 },
    pressure: 960.5,
  });
});

test("parseObservations handles numeric feels-like and Calma", () => {
  const rows = parseObservations(decodeText(fx("tiepre.txt")));
  assert.equal(rows.find((x) => x.name === "Pcia. Roque Saenz Peña").feels_like, 27.6);
  const calm = rows.find((x) => x.name === "Esc. Aviación Militar");
  assert.deepEqual(calm.wind, { direction: null, speed: 0 });
  assert.equal(calm.pressure, 953);
});

test("parseObservations tolerates missing pressure and blank lines", () => {
  const text = "\nX;05-enero-2026;00:00;Despejado;10 km;5;No se calcula; 50;Calma; / \r\n\r\n";
  const rows = parseObservations(text);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].pressure, null);
  assert.equal(rows[0].date, "2026-01-05T00:00:00-03:00");
});

test("parseForecast groups rows by station name", () => {
  const fc = parseForecast(decodeText(fx("pron.txt")));
  assert.deepEqual(Object.keys(fc).sort(), [
    "AEROPARQUE", "CORDOBA_AERO", "CORDOBA_OBSERVATORIO", "ESC.AVIACION_MILITAR_AERO",
    "MERCEDES_AERO_(CTES)", "PCIA._ROQUE_SAENZ_PEÑA_AERO",
  ]);
  const rows = fc.CORDOBA_OBSERVATORIO;
  assert.equal(rows.length, 40);
  assert.deepEqual(rows[0], {
    time: "2026-10-22T00:00:00-03:00", temperature: 19.9, wind_deg: 81, wind_speed: 10, rain_mm: 0.4,
  });
  assert.equal(rows[39].time, "2026-10-26T21:00:00-03:00");
});

test("parseForecast turns absurd precipitation sentinels into null", () => {
  const rows = parseForecast(decodeText(fx("pron.txt"))).CORDOBA_OBSERVATORIO;
  const bad = rows.find((r) => r.time === "2026-10-26T03:00:00-03:00");
  assert.equal(bad.rain_mm, null);
  assert.equal(bad.temperature, 10.4);
});

const mk = (date, hour, t, r, deg = 0, sp = 0) => ({
  time: `${date}T${String(hour).padStart(2, "0")}:00:00-03:00`, temperature: t, wind_deg: deg, wind_speed: sp, rain_mm: r,
});

test("daySummary computes min/max, rain total and 6h slots", () => {
  const d = "2026-10-22";
  const rows = [
    mk(d, 0, 10, 0), mk(d, 3, 9, 0.5, 90, 5), mk(d, 6, 8, 0.2), mk(d, 9, 14, 0, 100, 8),
    mk(d, 12, 20, 1.1), mk(d, 15, 24, 0.0, 180, 12), mk(d, 18, 18, null), mk(d, 21, 12, 2, 270, 3),
  ];
  const [day] = daySummary(rows);
  assert.equal(day.date, d);
  assert.equal(day.temp_min, 8);
  assert.equal(day.temp_max, 24);
  assert.equal(day.rain_mm, 3.8);
  assert.deepEqual(day.early_morning, { temperature: 9, rain06h: 0.5, wind: { deg: 90, speed: 5 } });
  assert.deepEqual(day.morning, { temperature: 14, rain06h: 0.2, wind: { deg: 100, speed: 8 } });
  assert.deepEqual(day.afternoon, { temperature: 24, rain06h: 1.1, wind: { deg: 180, speed: 12 } });
  assert.deepEqual(day.night, { temperature: 12, rain06h: 2, wind: { deg: 270, speed: 3 } });
});

test("daySummary splits days and returns null for missing slots", () => {
  const rows = [mk("2026-10-22", 21, 12, 0), mk("2026-10-23", 0, 11, 0), mk("2026-10-23", 3, 10, 0)];
  const days = daySummary(rows);
  assert.deepEqual(days.map((x) => x.date), ["2026-10-22", "2026-10-23"]);
  assert.equal(days[0].early_morning, null);
  assert.equal(days[1].morning, null);
  assert.equal(days[1].early_morning.temperature, 10);
});

test("daySummary over a real forecast yields 5 days", () => {
  const rows = parseForecast(decodeText(fx("pron.txt"))).CORDOBA_OBSERVATORIO;
  const days = daySummary(rows);
  assert.equal(days.length, 5);
  assert.equal(days[0].date, "2026-10-22");
  assert.ok(days.every((x) => x.temp_min <= x.temp_max));
});

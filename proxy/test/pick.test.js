import { test } from "node:test";
import assert from "node:assert/strict";
import { haversineKm, pickStation } from "../src/pick.js";

const S = [
  { wmo: 1, name: "A", lat: -31.4167, lon: -64.1833, obs: "a", fc: "A" },
  { wmo: 2, name: "B", lat: -31.2833, lon: -64.2, obs: "b", fc: null },
  { wmo: 3, name: "C", lat: -34.6, lon: -58.4, obs: null, fc: "C" },
];

test("haversineKm matches known distances", () => {
  assert.equal(haversineKm(-31.4, -64.2, -31.4, -64.2), 0);
  // Cordoba -> Buenos Aires is roughly 646 km
  const d = haversineKm(-31.4, -64.2, -34.6, -58.4);
  assert.ok(d > 640 && d < 655, String(d));
});

test("pickStation prefers the requested WMO when it has the field", () => {
  const r = pickStation(S, "obs", { wmo: 2, lat: -31.4, lon: -64.18 });
  assert.equal(r.station.wmo, 2);
  assert.ok(r.distance_km > 10 && r.distance_km < 20);
});

test("pickStation falls back to the nearest station having the field", () => {
  // WMO 2 has no forecast, so the nearest station with fc is A
  assert.equal(pickStation(S, "fc", { wmo: 2, lat: -31.28, lon: -64.2 }).station.wmo, 1);
  // Unknown WMO
  assert.equal(pickStation(S, "obs", { wmo: 999, lat: -31.3, lon: -64.2 }).station.wmo, 2);
  // No WMO at all
  assert.equal(pickStation(S, "fc", { lat: -34.5, lon: -58.5 }).station.wmo, 3);
});

test("pickStation without coordinates still honours a valid WMO", () => {
  const r = pickStation(S, "obs", { wmo: 1 });
  assert.equal(r.station.wmo, 1);
  assert.equal(r.distance_km, null);
});

test("pickStation returns null when nothing can be chosen", () => {
  assert.equal(pickStation(S, "obs", {}), null);
  assert.equal(pickStation(S, "obs", { wmo: 3 }), null);
  assert.equal(pickStation([], "obs", { lat: 0, lon: 0 }), null);
});

test("pickStation rounds distance to one decimal", () => {
  const r = pickStation(S, "obs", { lat: -31.4167, lon: -64.1833 });
  assert.equal(r.station.wmo, 1);
  assert.equal(r.distance_km, 0);
});

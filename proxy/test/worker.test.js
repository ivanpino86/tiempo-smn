import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import worker from "../src/index.js";

const fx = (name) => readFileSync(new URL("./fixtures/" + name, import.meta.url));
const realFetch = globalThis.fetch;
let calls;

before(() => {
  const store = new Map();
  globalThis.caches = {
    default: {
      match: async (req) => { const r = store.get(req.url); return r ? r.clone() : undefined; },
      put: async (req, res) => { store.set(req.url, res); },
    },
  };
  globalThis.fetch = async (url) => {
    calls.push(String(url));
    if (String(url).includes("tiepre")) return new Response(fx("tiepre.txt"));
    if (String(url).includes("pron")) return new Response(fx("pron.txt"));
    return new Response("[]", { status: 500 });
  };
});
after(() => { globalThis.fetch = realFetch; delete globalThis.caches; });

const ctx = { waitUntil: (p) => p };
const call = (path, init) => worker.fetch(new Request("https://w.test" + path, init), {}, ctx);

test("rejects invalid input with 400", async () => {
  calls = [];
  for (const path of ["/weather", "/weather?lat=abc&lon=1", "/weather?wmo=x", "/forecast?lat=1", "/coord?lat=95&lon=0", "/coord"]) {
    assert.equal((await call(path)).status, 400, path);
  }
  assert.equal(calls.length, 0);
});

test("answers CORS preflight and unknown routes", async () => {
  assert.equal((await call("/weather", { method: "OPTIONS" })).status, 204);
  assert.equal((await call("/nope")).status, 404);
  assert.equal((await call("/weather", { method: "POST" })).status, 405);
});

test("/weather returns an SMN-shaped body for a known WMO", async () => {
  const res = await call("/weather?wmo=87345&lat=-31.3988&lon=-64.2075");
  assert.equal(res.status, 200);
  const w = await res.json();
  assert.equal(w.station.wmo, 87345);
  assert.equal(w.station.name, "Córdoba Observatorio");
  assert.equal(w.temperature, 22.2);
  assert.equal(w.weather.description, "Parcialmente nublado");
  assert.deepEqual(w.wind, { direction: "Sudeste", speed: 5 });
  assert.ok(w.station.distance_km > 0 && w.station.distance_km < 20);
});

test("/weather falls back to the nearest station with data", async () => {
  // Tanti (near Cordoba) has no fixture-station of its own: nearest is a Cordoba one
  const w = await (await call("/weather?lat=-31.35&lon=-64.58")).json();
  assert.match(w.station.name, /^(Córdoba|Pilar|Esc\.)/);
});

test("/forecast returns day summaries for the station", async () => {
  const res = await call("/forecast?wmo=87345&lat=-31.3988&lon=-64.2075");
  assert.equal(res.status, 200);
  const f = await res.json();
  assert.equal(f.station.wmo, 87345);
  assert.ok(Array.isArray(f.forecast));
  for (const d of f.forecast) assert.ok(d.temp_min <= d.temp_max);
});

test("/coord returns a search-like row", async () => {
  const row = await (await call("/coord?lat=-31.4&lon=-64.2")).json();
  assert.equal(row.length, 10);
  assert.equal(row[0], "st-" + row[4]);
  assert.equal(row[3], "Córdoba");
  assert.equal(typeof row[8], "number");
});

test("upstream failure becomes a 502", async () => {
  const saved = globalThis.fetch;
  const savedCaches = globalThis.caches;
  globalThis.caches = { default: { match: async () => undefined, put: async () => {} } };
  globalThis.fetch = async () => { throw new Error("down"); };
  const res = await call("/weather?wmo=87345");
  globalThis.fetch = saved;
  globalThis.caches = savedCaches;
  assert.equal(res.status, 502);
  assert.equal((await res.json()).error, "smn");
});

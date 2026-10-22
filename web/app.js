// Interfaz de la app: buscador dinámico, tiempo actual y pronóstico.
(function () {
  const $ = (id) => document.getElementById(id);
  const input = $("q"), list = $("suggestions"), status = $("status"), out = $("out");
  const MIN_CHARS = 2, DEBOUNCE_MS = 250, MAX_SUGGESTIONS = 15;
  const STORE_LAST = "tiempo-smn:last", STORE_RECENT = "tiempo-smn:recent";

  let items = [], active = -1, debounceId = 0, searchCtrl = null, loadCtrl = null;
  const memo = new Map(); // caché de búsquedas de esta sesión

  // ---------- Utilidades ----------
  const fold = (s) => (s || "").normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function setStatus(msg, isErr) { status.textContent = msg || ""; status.className = "status" + (isErr ? " err" : ""); }
  function store(key, val) { try { localStorage.setItem(key, JSON.stringify(val)); } catch (e) {} }
  function load(key, def) { try { const v = localStorage.getItem(key); return v ? JSON.parse(v) : def; } catch (e) { return def; } }

  // Resalta en negrita la parte del nombre que coincide con lo escrito (ignorando tildes)
  function highlight(name, query) {
    const frag = document.createDocumentFragment();
    const i = fold(name).indexOf(fold(query).trim());
    if (i < 0 || !query.trim()) { frag.append(name); return frag; }
    const len = query.trim().length;
    frag.append(name.slice(0, i));
    frag.append(el("mark", "", name.slice(i, i + len)));
    frag.append(name.slice(i + len));
    return frag;
  }

  // ---------- Buscador dinámico ----------
  function openList() { list.hidden = false; input.setAttribute("aria-expanded", "true"); }
  function closeList() { list.hidden = true; input.setAttribute("aria-expanded", "false"); input.removeAttribute("aria-activedescendant"); active = -1; }

  function renderInfo(text) {
    list.innerHTML = "";
    list.appendChild(el("li", "info", text));
    openList();
  }

  function renderSuggestions(query) {
    list.innerHTML = "";
    if (!items.length) { renderInfo("No hay localidades que coincidan con “" + query + "”."); return; }
    items.forEach((loc, idx) => {
      const li = el("li");
      li.id = "opt-" + idx;
      li.setAttribute("role", "option");
      li.setAttribute("aria-selected", "false");
      const nm = el("span", "nm"); nm.appendChild(highlight(loc.name, query));
      const rg = el("span", "rg", [loc.department, loc.province].filter(Boolean).join(", "));
      li.append(nm, rg);
      li.addEventListener("mousedown", (e) => { e.preventDefault(); choose(idx); });
      list.appendChild(li);
    });
    openList();
  }

  function setActive(idx) {
    const opts = list.querySelectorAll('[role="option"]');
    if (!opts.length) return;
    active = (idx + opts.length) % opts.length;
    opts.forEach((o, i) => o.setAttribute("aria-selected", i === active ? "true" : "false"));
    input.setAttribute("aria-activedescendant", opts[active].id);
    opts[active].scrollIntoView({ block: "nearest" });
  }

  // Ordena: primero las que empiezan con lo escrito, después el resto
  function rank(rows, query) {
    const q = fold(query).trim();
    return rows
      .map((r) => ({ r, s: fold(r.name).startsWith(q) ? 0 : fold(r.name).includes(q) ? 1 : 2 }))
      .sort((a, b) => a.s - b.s || a.r.name.localeCompare(b.r.name, "es"))
      .map((x) => x.r)
      .slice(0, MAX_SUGGESTIONS);
  }

  async function runSearch(query) {
    const key = fold(query).trim();
    if (memo.has(key)) { items = rank(memo.get(key), query); renderSuggestions(query); return; }

    if (searchCtrl) searchCtrl.abort();
    searchCtrl = new AbortController();
    renderInfo("Buscando…");
    try {
      const rows = await SMN.searchLocations(query, searchCtrl.signal);
      memo.set(key, rows);
      if (input.value.trim() !== query.trim()) return; // el usuario siguió escribiendo
      items = rank(rows, query);
      renderSuggestions(query);
    } catch (e) {
      if (e.name === "AbortError") return;
      renderInfo(e.code === "network" ? "No se pudo conectar con el SMN. Revisá tu conexión." : (e.message || "Error al buscar."));
    }
  }

  input.addEventListener("input", () => {
    const q = input.value;
    $("clear").hidden = !q;
    clearTimeout(debounceId);
    if (q.trim().length < MIN_CHARS) { if (searchCtrl) searchCtrl.abort(); closeList(); return; }
    debounceId = setTimeout(() => runSearch(q), DEBOUNCE_MS);
  });

  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown") { e.preventDefault(); if (list.hidden && items.length) openList(); setActive(active + 1); }
    else if (e.key === "ArrowUp") { e.preventDefault(); setActive(active - 1); }
    else if (e.key === "Enter") {
      e.preventDefault();
      if (!list.hidden && items.length) choose(active >= 0 ? active : 0);
      else if (input.value.trim().length >= MIN_CHARS) runSearch(input.value);
    } else if (e.key === "Escape") { closeList(); }
  });

  input.addEventListener("focus", () => { if (items.length && input.value.trim().length >= MIN_CHARS) renderSuggestions(input.value); });
  input.addEventListener("blur", () => setTimeout(closeList, 120));

  $("clear").addEventListener("click", () => {
    input.value = ""; $("clear").hidden = true; items = []; closeList(); input.focus();
  });

  function choose(idx) {
    const loc = items[idx];
    if (!loc) return;
    input.value = loc.name;
    $("clear").hidden = false;
    closeList();
    input.blur();
    showLocation(loc);
  }

  // ---------- Recientes ----------
  function addRecent(loc) {
    const rec = load(STORE_RECENT, []).filter((r) => r.id !== loc.id);
    rec.unshift(loc);
    store(STORE_RECENT, rec.slice(0, 6));
    renderRecent();
  }
  function renderRecent() {
    const box = $("recent"); box.innerHTML = "";
    load(STORE_RECENT, []).forEach((loc) => {
      const b = el("button", "chip", loc.name);
      b.type = "button";
      b.title = [loc.department, loc.province].filter(Boolean).join(", ");
      b.addEventListener("click", () => { input.value = loc.name; $("clear").hidden = false; showLocation(loc); });
      box.appendChild(b);
    });
  }

  // ---------- Mi ubicación ----------
  $("locate").addEventListener("click", () => {
    if (!navigator.geolocation) { setStatus("Este navegador no permite obtener tu ubicación.", true); return; }
    const btn = $("locate");
    btn.classList.add("busy"); setStatus("Buscando tu ubicación…");
    navigator.geolocation.getCurrentPosition(async (pos) => {
      try {
        const loc = await SMN.locationByCoords(pos.coords.latitude, pos.coords.longitude);
        if (!loc || !loc.id) throw new Error("El SMN no encontró una localidad cercana.");
        input.value = loc.name; $("clear").hidden = false;
        showLocation(loc);
      } catch (e) { showError(e); }
      finally { btn.classList.remove("busy"); }
    }, (err) => {
      btn.classList.remove("busy");
      setStatus(err.code === 1 ? "No diste permiso para usar tu ubicación." : "No se pudo obtener tu ubicación.", true);
    }, { timeout: 15000, maximumAge: 600000 });
  });

  // ---------- Tiempo de una localidad ----------
  async function showLocation(loc) {
    store(STORE_LAST, loc);
    addRecent(loc);
    if (loadCtrl) loadCtrl.abort();
    loadCtrl = new AbortController();
    const sig = loadCtrl.signal;

    out.innerHTML = "";
    out.appendChild(el("div", "skeleton"));
    setStatus("Trayendo el tiempo de " + loc.name + "…");

    const [w, f] = await Promise.allSettled([SMN.getWeather(loc, sig), SMN.getForecast(loc, sig)]);
    if (sig.aborted) return;

    out.innerHTML = "";
    if (w.status === "rejected" && f.status === "rejected") { showError(w.reason, loc); return; }
    if (w.status === "fulfilled") out.appendChild(renderNow(w.value, loc));
    else out.appendChild(notice("Tiempo actual no disponible", errorText(w.reason)));
    if (f.status === "fulfilled") out.appendChild(renderForecast(f.value));
    else out.appendChild(notice("Pronóstico no disponible", errorText(f.reason)));
    setStatus("");
  }

  function errorText(e) {
    if (!e) return "Error desconocido.";
    switch (e.code) {
      case "no_proxy": return "La app todavía no tiene configurado el proxy (PROXY_URL en config.js). Sin él, el SMN no entrega el tiempo ni el pronóstico.";
      case "no_location": return "Esta localidad se guardó sin ubicación. Buscala de nuevo para ver el tiempo.";
      case "no_station": return "No hay una estación del SMN con datos cerca de esta localidad.";
      case "network": return "No hay conexión con el servidor. Revisá tu internet.";
      default: return e.message || "Error al consultar el SMN.";
    }
  }
  function notice(title, text) {
    const n = el("div", "notice");
    n.append(el("strong", "", title), document.createTextNode(text));
    return n;
  }
  function showError(e, loc) {
    out.innerHTML = "";
    out.appendChild(notice(loc ? "No se pudo cargar " + loc.name : "No se pudo completar la búsqueda", errorText(e)));
    setStatus("");
  }

  const fmt = (v, suf) => (v === null || v === undefined || v === "" ? "—" : v + (suf || ""));

  function renderNow(w, loc) {
    const card = el("section", "now");
    const place = el("div", "place");
    const sub = [loc.department, loc.province].filter(Boolean).join(", ");
    const st = w.station || {};
    const station = st.name ? "Estación " + st.name + (st.distance_km != null ? " (" + st.distance_km + " km)" : "") : "";
    place.append(el("h2", "", loc.name), el("p", "", [sub, station].filter(Boolean).join(" · ")));

    const desc = (w.weather && w.weather.description) || "";
    const ico = weatherIcon(desc, isNight(w.date));
    ico.classList.add("wx-ico");

    const temp = el("div", "temp", w.temperature != null ? String(Math.round(w.temperature)) : "—");
    temp.appendChild(el("sup", "", "°C"));

    const stats = el("dl", "stats");
    const wind = w.wind ? [w.wind.speed != null ? w.wind.speed + " km/h" : "", w.wind.direction || ""].join(" ").trim() : "";
    [["Sensación térmica", w.feels_like != null ? Math.round(w.feels_like) + "°" : "—"],
     ["Humedad", fmt(w.humidity, "%")],
     ["Viento", wind || "—"],
     ["Presión", fmt(w.pressure, " hPa")]].forEach(([k, v]) => {
      const s = el("div", "stat"); s.append(el("dt", "", k), el("dd", "", v)); stats.appendChild(s);
    });

    card.append(place, ico, temp, el("div", "desc", desc || "Sin descripción"), stats);
    if (w.date) {
      const d = new Date(w.date);
      card.appendChild(el("div", "stamp", "Observación de las " +
        d.toLocaleTimeString("es-AR", { hour: "2-digit", minute: "2-digit" }) + " · " +
        d.toLocaleDateString("es-AR", { weekday: "long", day: "numeric", month: "long" })));
    }
    return card;
  }

  function renderForecast(f) {
    const box = el("section", "fc");
    box.appendChild(el("h3", "", "Pronóstico 5 días"));
    if (f && f.station && f.station.name) {
      const d = f.station.distance_km;
      box.appendChild(el("p", "fc-note", "Modelo numérico del SMN para la estación " + f.station.name + (d != null ? " (" + d + " km)" : "") + "."));
    }
    const days = el("div", "days");
    const todayIso = new Date().toLocaleDateString("sv-SE"); // AAAA-MM-DD local
    ((f && f.forecast) || []).forEach((d) => {
      const c = el("div", "day" + (d.date === todayIso ? " today" : ""));
      const date = new Date(d.date + "T12:00:00");
      c.appendChild(el("div", "dn", d.date === todayIso ? "Hoy" : date.toLocaleDateString("es-AR", { weekday: "short", day: "numeric" })));
      const mm = el("div", "mm");
      mm.append(el("b", "", d.temp_max != null ? d.temp_max + "°" : "—"), el("span", "", " / " + (d.temp_min != null ? d.temp_min + "°" : "—")));
      c.appendChild(mm);
      [["early_morning", "Madrugada", true], ["morning", "Mañana", false], ["afternoon", "Tarde", false], ["night", "Noche", true]].forEach(([k, lbl, night]) => {
        const p = d[k]; if (!p) return;
        // El pronóstico abierto no trae descripción del cielo: muestro el viento y elijo el ícono por la lluvia
        const desc = p.wind && p.wind.speed != null ? "Viento " + p.wind.speed + " km/h" : "—";
        const sl = el("div", "slot");
        sl.append(weatherIcon("", night, p.rain06h > 0.5 ? "rain" : "partly"), el("div", "lbl", lbl), el("div", "", desc));
        const line = el("div", "", p.temperature != null ? p.temperature + "° " : "");
        if (p.rain06h > 0) line.appendChild(el("span", "rain", p.rain06h + " mm"));
        sl.appendChild(line);
        c.appendChild(sl);
      });
      days.appendChild(c);
    });
    if (!days.children.length) { box.appendChild(el("p", "status", "El SMN no tiene pronóstico para esta localidad.")); return box; }
    const scroll = el("div", "days-scroll"); scroll.appendChild(days); box.appendChild(scroll);
    return box;
  }

  function isNight(iso) {
    if (!iso) return false;
    const h = new Date(iso).getHours();
    return h < 7 || h >= 20;
  }

  // Ícono simple a partir de la descripción del SMN
  function weatherIcon(desc, night, forcedKind) {
    const d = fold(desc);
    let kind = "sun";
    if (forcedKind) kind = forcedKind;
    else if (/tormenta/.test(d)) kind = "storm";
    else if (/nieve|nevada/.test(d)) kind = "snow";
    else if (/lluvi|llovizn|chaparr|precip/.test(d)) kind = "rain";
    else if (/niebla|neblina|bruma/.test(d)) kind = "fog";
    else if (/parcial|algo nublado|poco nublado|ligeramente/.test(d)) kind = "partly";
    else if (/nublado|cubierto/.test(d)) kind = "cloud";
    const sun = night ? '<path class="wx-moon" d="M26 8a11 11 0 1 0 8 15 9 9 0 0 1-8-15z"/>'
                      : '<circle class="wx-sun" cx="24" cy="18" r="8"/>';
    const cloud = '<path class="wx-cloud" d="M14 38h22a8 8 0 0 0 0-16 11 11 0 0 0-21 3 6.5 6.5 0 0 0-1 13z"/>';
    const highCloud = '<g transform="translate(0,-7)">' + cloud + "</g>";
    const shapes = {
      sun: night ? '<path class="wx-moon" d="M28 10a14 14 0 1 0 10 19 11 11 0 0 1-10-19z"/>' : '<circle class="wx-sun" cx="24" cy="24" r="10"/>',
      partly: sun + cloud,
      cloud: cloud,
      rain: highCloud + '<path class="wx-rain" d="M17 37l-2 6M25 37l-2 6M33 37l-2 6"/>',
      storm: highCloud + '<path class="wx-bolt" d="M25 33l-6 9h5l-2 6 8-10h-5l3-5z"/>',
      snow: highCloud + '<path class="wx-rain" d="M17 39h0M25 43h0M33 39h0" stroke-width="4"/>',
      fog: '<path class="wx-line" d="M10 18h28M6 25h36M10 32h28M14 39h20"/>',
    };
    const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    svg.setAttribute("viewBox", "0 0 48 48");
    svg.setAttribute("aria-hidden", "true");
    svg.innerHTML = shapes[kind];
    return svg;
  }

  // ---------- Inicio ----------
  renderRecent();
  const last = load(STORE_LAST, null);
  if (last && last.id) { input.value = last.name; $("clear").hidden = false; showLocation(last); }
  else if (!SMN.hasProxy) {
    setStatus("Aviso: falta configurar el proxy. El buscador funciona, pero el tiempo y el pronóstico no se van a poder cargar.", true);
  }
})();

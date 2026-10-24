// Albion Pathfinder — интерфейс: форма, вывод маршрута, карта, язык.
// Поиск пути — в pathfinder.js, тексты — в i18n.js.

const { LEVELS, Graph } = window.Pathfinder;
// Цвета королевских городов, как в игре. Портальные города в Outlands
// получают цвет своего королевского города обводкой.
const CITY_COLOR = {
  "Thetford": "#9b6bd6",
  "Lymhurst": "#5fb85a",
  "Bridgewatch": "#e8892b",
  "Martlock": "#4a8fe0",
  "Fort Sterling": "#e9e6df",
  "Caerleon": "#d0453a",
};
const cityColor = (z) => (z.kind === "city" ? CITY_COLOR[z.name.replace(/ Portal$/, "")] || null : null);

// Кружок зоны в списке: у городов — цвет города, иначе цвет опасности
function dotHtml(z, title) {
  const c = cityColor(z);
  if (!c) return `<i class="dot ${z.color}" title="${title}"></i>`;
  const portal = z.name.endsWith(" Portal");
  const style = portal ? `box-shadow:0 0 0 2px ${c}` : `background:${c}`;
  return `<i class="dot ${z.color} city-dot" style="${style}" title="${title}"></i>`;
}

// Цвета тиров, как у предметов в игре
const TIER_COLOR = { 3: "#5fae4f", 4: "#4a86d9", 5: "#d0453a", 6: "#e8892b", 7: "#e6c63a", 8: "#f2efe8" };
const DNG_TIERS = [3, 4, 5, 6, 7, 8];

const ARROW = { N: "↑", NE: "↗", E: "→", SE: "↘", S: "↓", SW: "↙", W: "←", NW: "↖" };

const state = {
  graph: null,
  byName: new Map(),   // имя в нижнем регистре -> id
  pairs: [],           // уникальные пары соседних зон для карты
  result: null,        // последний найденный маршрут
  lang: "ru",
  view: "names",       // "names" | "compass"
  pickNext: "from",
  routeIds: null,      // зоны текущего маршрута (для затемнения меток)
  infoZone: null,      // зона, показанная в карточке под картой
  dByZone: new Map(),  // id зоны -> [{ d, main, dir }]
  dng: { on: false, tiers: new Set(DNG_TIERS), side: true },
};

const $ = (id) => document.getElementById(id);
const T = () => window.I18N[state.lang];

// ---------- настройки (язык, вид) в браузере ----------

function loadPrefs() {
  let saved = {};
  try { saved = JSON.parse(localStorage.getItem("albion-pathfinder") || "{}"); } catch (_) {}
  const browserRu = (navigator.language || "").toLowerCase().startsWith("ru");
  state.lang = saved.lang === "en" || saved.lang === "ru" ? saved.lang : browserRu ? "ru" : "en";
  state.view = saved.view === "compass" ? "compass" : "names";
  if (saved.dng) {
    state.dng.on = !!saved.dng.on;
    state.dng.side = saved.dng.side !== false;
    const tiers = (saved.dng.tiers || []).filter((t) => DNG_TIERS.includes(t));
    if (tiers.length) state.dng.tiers = new Set(tiers);
  }
}

function savePrefs() {
  try {
    localStorage.setItem("albion-pathfinder", JSON.stringify({
      lang: state.lang,
      view: state.view,
      dng: { on: state.dng.on, side: state.dng.side, tiers: [...state.dng.tiers] },
    }));
  } catch (_) {}
}

// ---------- язык ----------

function applyLang() {
  const t = T();
  document.documentElement.lang = state.lang;
  document.querySelectorAll("[data-i18n]").forEach((el) => { el.textContent = t[el.dataset.i18n]; });
  document.querySelectorAll("[data-i18n-ph]").forEach((el) => { el.placeholder = t[el.dataset.i18nPh]; });
  document.querySelectorAll("[data-i18n-title]").forEach((el) => {
    el.title = t[el.dataset.i18nTitle];
    el.setAttribute("aria-label", t[el.dataset.i18nTitle]);
  });
  document.querySelectorAll("[data-i18n-aria]").forEach((el) => {
    el.setAttribute("aria-label", t[el.dataset.i18nAria]);
  });
  document.querySelectorAll("[data-lang]").forEach((b) => {
    b.setAttribute("aria-pressed", String(b.dataset.lang === state.lang));
  });
  updateMapTitles();
  renderDngControls();
  renderZoneInfo();
  renderResult();
}

// ---------- загрузка данных ----------

async function load() {
  const res = await fetch("data/zones.json", { cache: "no-cache" }); // всегда сверяемся с сервером
  if (!res.ok) throw new Error("load");
  const data = await res.json();
  state.graph = new Graph(data);

  for (const z of data.zones) state.byName.set(z.name.toLowerCase(), z.id);
  const seen = new Set();
  for (const [a, b, type] of data.links) {
    const key = a < b ? `${a}|${b}` : `${b}|${a}`;
    if (seen.has(key)) continue;
    seen.add(key);
    state.pairs.push([a, b, type]);
  }

  for (const d of data.dungeons || []) {
    for (const [zid, main, dir] of d.entrances) {
      if (!state.dByZone.has(zid)) state.dByZone.set(zid, []);
      state.dByZone.get(zid).push({ d, main: !!main, dir });
    }
  }
  for (const list of state.dByZone.values()) list.sort((a, b) => a.d.tier - b.d.tier || b.main - a.main);

  $("data-version").textContent = data.version;
  const names = data.zones.map((z) => z.name).sort((x, y) => x.localeCompare(y));
  $("zone-list").innerHTML = names.map((n) => `<option value="${esc(n)}"></option>`).join("");
}

const zone = (id) => state.graph.zones.get(id);

function resolveZone(text) {
  const key = text.trim().toLowerCase();
  if (!key) return null;
  if (state.byName.has(key)) return state.byName.get(key);
  const names = [...state.byName.keys()];
  const starts = names.filter((n) => n.startsWith(key));
  if (starts.length === 1) return state.byName.get(starts[0]);
  const parts = names.filter((n) => n.includes(key));
  if (parts.length === 1) return state.byName.get(parts[0]);
  return null;
}

// ---------- поиск ----------

function currentOptions() {
  return {
    maxLevel: document.querySelector("input[name=safety]:checked").value,
    metric: document.querySelector("input[name=metric]:checked").value,
    portals: $("portals").checked,
  };
}

function search() {
  const fromText = $("from").value, toText = $("to").value;
  const from = resolveZone(fromText), to = resolveZone(toText);
  const opt = currentOptions();

  if (!from || !to) {
    state.result = { kind: "notFound", query: !from ? fromText : toText };
    setRoute(null);
    renderResult();
    return;
  }
  $("from").value = zone(from).name;
  $("to").value = zone(to).name;
  writeHash(from, to, opt);

  const path = state.graph.findPath(from, to, opt);
  if (path) {
    state.result = { kind: "route", from, to, opt, path };
    setRoute(path.steps.map((s) => s.zone));
  } else {
    // с каким минимальным уровнем опасности путь появится
    let hint = null;
    for (const lv of LEVELS.slice(LEVELS.indexOf(opt.maxLevel) + 1)) {
      const p = state.graph.findPath(from, to, Object.assign({}, opt, { maxLevel: lv }));
      if (p) { hint = { level: lv, hops: p.hops }; break; }
    }
    state.result = { kind: "noPath", opt, hint };
    setRoute(null);
  }
  renderResult();
}

// ---------- вывод маршрута ----------

function renderResult() {
  const out = $("result");
  const r = state.result;
  const t = T();
  if (!r) { out.innerHTML = ""; return; }

  if (r.kind === "notFound") {
    out.innerHTML = `<div class="warn">${t.notFound(esc(r.query))}</div>`;
    return;
  }
  if (r.kind === "pick") {
    out.innerHTML = `<div class="summary">${t.pickTo(esc(zone(r.from).name))}</div>`;
    return;
  }
  if (r.kind === "noPath") {
    const levels = LEVELS.slice(0, LEVELS.indexOf(r.opt.maxLevel) + 1).map((l) => t.levelName[l]).join(t.levelsJoin);
    const hint = r.hint ? t.hintLevel(t.levelName[r.hint.level], r.hint.hops) : "";
    out.innerHTML = `<div class="warn">${t.noPath(levels)}${hint}</div>`;
    return;
  }

  const { path, opt, from, to } = r;
  if (path.hops === 0) {
    out.innerHTML = `<div class="summary">${t.already}</div>`;
    return;
  }

  const inner = path.steps.slice(1, -1).map((s) => LEVELS.indexOf(zone(s.zone).color));
  const worst = inner.length ? LEVELS[Math.max(...inner)] : null;
  const endsWarn = [from, to].map(zone).filter((z) => LEVELS.indexOf(z.color) > LEVELS.indexOf(opt.maxLevel));

  let html = `<div class="summary">${t.hops}: <b>${path.hops}</b> · ${t.zonesOnPath}: <b>${path.steps.length}</b>`;
  if (worst) html += ` · ${t.worst}: <b>${t.colorName[worst]}</b>`;
  html += `<br><span class="muted">${t.distance} ${fmtNum(path.distance)} ${t.distUnit}</span></div>`;
  if (endsWarn.length) {
    html += `<div class="warn">${t.endsWarn(endsWarn.map((z) => t.zoneIs(esc(z.name), t.colorName[z.color])).join(", "))}</div>`;
  }

  html += `<div class="route-bar">
    <div class="seg" role="group">
      <button type="button" data-view="names" aria-pressed="${state.view === "names"}">${t.viewNames}</button>
      <button type="button" data-view="compass" aria-pressed="${state.view === "compass"}">${t.viewCompass}</button>
    </div>
    <button type="button" class="copy" id="copy">${t.copy}</button>
  </div>`;

  html += state.view === "compass" ? renderCompass(path) : renderNames(path);
  out.innerHTML = html;

  out.querySelectorAll("[data-view]").forEach((b) =>
    b.addEventListener("click", () => {
      state.view = b.dataset.view;
      savePrefs();
      renderResult();
    })
  );
  $("copy").addEventListener("click", copyRoute);
}

function zoneMeta(z) {
  const t = T();
  if (z.kind === "city") return t.city;
  return z.tier ? `T${z.tier}` : "";
}

function renderNames(path) {
  const t = T();
  return `<ol class="steps">${path.steps
    .map((s) => {
      const z = zone(s.zone);
      const portal = s.link && s.link.type === "portal" ? `<span class="portal">${t.viaPortal}</span>` : "";
      return `<li>${dotHtml(z, t.colorName[z.color])}${esc(z.name)} ${portal}${dngBadges(z.id)}<span class="meta">${zoneMeta(z)}</span></li>`;
    })
    .join("")}</ol>`;
}

// По сторонам света: для каждой зоны — в какую сторону идти к выходу.
// Выход из зоны steps[i] — это переход, которым вошли в steps[i + 1].
function renderCompass(path) {
  const t = T();
  const rows = path.steps.map((s, i) => {
    const z = zone(s.zone);
    const next = path.steps[i + 1];
    let dir;
    if (!next) {
      dir = `<span class="dir finish">⚑ ${t.arrive}</span>`;
    } else if (next.link.type === "portal") {
      dir = `<span class="dir portal">◎ ${t.takePortal}</span>`;
    } else {
      const d = next.link.dir;
      dir = `<span class="dir" title="${t.dirLong[d]}"><b class="arrow">${ARROW[d]}</b>${t.dir[d]}</span>`;
    }
    return `<li>${dir}<span class="zname">${dotHtml(z, t.colorName[z.color])}${esc(z.name)}${dngBadges(z.id)}</span><span class="meta">${zoneMeta(z)}</span></li>`;
  });
  return `<ol class="steps compass">${rows.join("")}</ol><p class="note">${t.compassNote}</p>`;
}

function routeText() {
  const r = state.result;
  if (!r || r.kind !== "route") return "";
  const t = T();
  const steps = r.path.steps;
  if (state.view === "names") return steps.map((s) => zone(s.zone).name).join(" → ");
  return steps
    .map((s, i) => {
      const next = steps[i + 1];
      const name = zone(s.zone).name;
      if (!next) return `${name} (${t.arrive})`;
      if (next.link.type === "portal") return `${name}: ${t.takePortal}`;
      return `${name}: ${t.dir[next.link.dir]}`;
    })
    .join(" → ");
}

async function copyRoute() {
  const btn = $("copy");
  try {
    await navigator.clipboard.writeText(routeText());
    btn.textContent = T().copied;
    setTimeout(() => { if (btn.isConnected) btn.textContent = T().copy; }, 1500);
  } catch (_) {
    // запасной вариант для старых браузеров
    const ta = document.createElement("textarea");
    ta.value = routeText();
    document.body.appendChild(ta);
    ta.select();
    try { document.execCommand("copy"); btn.textContent = T().copied; } catch (_) {}
    ta.remove();
  }
}

function fmtNum(n) {
  return new Intl.NumberFormat(state.lang === "ru" ? "ru-RU" : "en-US").format(Math.round(n / 10) * 10);
}

// ---------- статические подземелья ----------

// Входы в зоне, подходящие под фильтр (тиры, боковые входы)
function dngMatches(zid) {
  if (!state.dng.on) return [];
  return (state.dByZone.get(zid) || []).filter(
    (e) => state.dng.tiers.has(e.d.tier) && (e.main || state.dng.side)
  );
}

// По одному значку на тир: залитый — есть главный вход, контурный — только боковые
function tierGroups(entries) {
  const m = new Map();
  for (const e of entries) m.set(e.d.tier, (m.get(e.d.tier) || false) || e.main);
  return [...m.entries()].sort((a, b) => a[0] - b[0]);
}

function dngTitle(e) {
  const t = T();
  const parts = [`T${e.d.tier} ${t.faction[e.d.faction]}`, e.main ? t.dngMain : t.dngSideOne];
  if (e.dir) parts.push(e.dir);
  if (e.d.solo) parts.push(t.dngSolo);
  const fl = t.dngFloors(e.d.floors);
  if (fl) parts.push(fl);
  return `${e.d.name} — ${parts.join(", ")}`;
}

function dngBadges(zid) {
  const list = dngMatches(zid);
  if (!list.length) return "";
  const title = esc(list.map(dngTitle).join("\n"));
  return `<span class="dng-badges" title="${title}">${tierGroups(list)
    .map(([tier, main]) => `<b class="tbadge${main ? "" : " side"}" style="--tc:${TIER_COLOR[tier]}">${tier}</b>`)
    .join("")}</span>`;
}

function renderDngControls() {
  const t = T();
  $("dng-on").checked = state.dng.on;
  $("dng-side").checked = state.dng.side;
  $("dng-opts").classList.toggle("off", !state.dng.on);
  $("dng-tiers").innerHTML = DNG_TIERS.map(
    (tier) => `<button type="button" data-tier="${tier}" aria-pressed="${state.dng.tiers.has(tier)}" ${state.dng.on ? "" : "disabled"} style="--tc:${TIER_COLOR[tier]}">T${tier}</button>`
  ).join("");
  $("dng-side").disabled = !state.dng.on;
  let count = "";
  if (state.dng.on && state.graph) {
    const ds = new Set(), zs = new Set();
    for (const zid of state.graph.zones.keys()) {
      const m = dngMatches(zid);
      if (m.length) { zs.add(zid); m.forEach((e) => ds.add(e.d.id)); }
    }
    count = ds.size ? t.dngCount(ds.size, zs.size) : t.dngNone;
  }
  $("dng-count").textContent = count;
}

function onDngChange() {
  savePrefs();
  renderDngControls();
  drawDungeonLayer();
  updateMapTitles();
  renderResult();
}

function drawDungeonLayer() {
  const layer = $("dungeon-layer");
  if (!layer) return;
  layer.innerHTML = "";
  if (!state.dng.on) return;
  const onRoute = state.routeIds && state.routeIds.length > 1 ? new Set(state.routeIds) : null;
  const S = 6, GAP = 0.8; // размер значка в единицах карты
  for (const z of state.graph.zones.values()) {
    const groups = tierGroups(dngMatches(z.id));
    if (!groups.length) continue;
    const g = el("g", { class: "dng" + (onRoute && !onRoute.has(z.id) ? " dim" : "") }, layer);
    groups.forEach(([tier, main], i) => {
      const x = px(z) + 3 + i * (S + GAP), y = py(z) - 3 - S;
      el("rect", {
        x, y, width: S, height: S, rx: 1,
        class: "tb" + (main ? "" : " side"),
        style: `--tc:${TIER_COLOR[tier]}`,
        "data-id": z.id,
      }, g);
      const tx = el("text", { x: x + S / 2, y: y + S / 2 + 1.8, class: "tt" + (main ? "" : " side"), style: `--tc:${TIER_COLOR[tier]}`, "data-id": z.id }, g);
      tx.textContent = tier;
    });
  }
}

// Карточка зоны под картой: цвет, тир и все статики (без фильтра)
function renderZoneInfo() {
  const box = $("zone-info");
  if (!box) return;
  const z = state.infoZone && state.graph ? zone(state.infoZone) : null;
  if (!z) { box.innerHTML = ""; return; }
  const t = T();
  const tier = z.kind === "city" ? t.city : z.tier ? `T${z.tier}` : "";
  const list = state.dByZone.get(z.id) || [];
  let html = `<div class="zi-head">${dotHtml(z, t.colorName[z.color])}<b>${esc(z.name)}</b><span class="muted">${t.colorName[z.color]}${tier ? " · " + tier : ""}</span></div>`;
  if (!list.length) {
    html += `<div class="muted">${t.dngNoneInZone}</div>`;
  } else {
    html += `<div class="muted">${t.dngInZone}:</div><ul class="zi-list">${list
      .map((e) => {
        const extra = [e.main ? t.dngMain : t.dngSideOne];
        if (e.dir) extra.push(`<b class="zi-dir">${ARROW[e.dir]} ${e.dir}</b>`);
        if (e.d.solo) extra.push(t.dngSolo);
        const fl = t.dngFloors(e.d.floors);
        if (fl) extra.push(fl);
        return `<li><b class="tbadge${e.main ? "" : " side"}" style="--tc:${TIER_COLOR[e.d.tier]}">${e.d.tier}</b>${esc(e.d.name)} <span class="muted">(${t.faction[e.d.faction]}) · ${extra.join(" · ")}</span></li>`;
      })
      .join("")}</ul>`;
  }
  box.innerHTML = html;
}

// ---------- ссылка на маршрут ----------

function writeHash(from, to, opt) {
  const p = new URLSearchParams({
    from, to, s: opt.maxLevel, m: opt.metric, p: opt.portals ? "1" : "0",
  });
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const from = zone(p.get("from")), to = zone(p.get("to"));
  if (!from || !to) return false;
  $("from").value = from.name;
  $("to").value = to.name;
  const s = p.get("s");
  if (LEVELS.includes(s)) document.querySelector(`input[name=safety][value=${s}]`).checked = true;
  const m = p.get("m");
  if (m === "hops" || m === "distance") document.querySelector(`input[name=metric][value=${m}]`).checked = true;
  $("portals").checked = p.get("p") !== "0";
  return true;
}

// ---------- карта ----------

const SVG_NS = "http://www.w3.org/2000/svg";
const view = { x: 0, y: 0, w: 0, h: 0, full: null, dragged: false };
// В данных игры y растёт на север, в SVG — вниз, поэтому переворачиваем.
const px = (z) => z.x;
const py = (z) => -z.y;

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

function drawMap() {
  const svg = $("map");
  svg.innerHTML = "";
  const zones = [...state.graph.zones.values()];
  const pad = 15;
  const xs = zones.map(px), ys = zones.map(py);
  const minX = Math.min(...xs) - pad, minY = Math.min(...ys) - pad;
  view.full = { x: minX, y: minY, w: Math.max(...xs) + pad - minX, h: Math.max(...ys) + pad - minY };
  Object.assign(view, view.full);
  applyView();

  const gEdges = el("g", {}, svg);
  for (const [a, b, type] of state.pairs) {
    const za = zone(a), zb = zone(b);
    el("line", { x1: px(za), y1: py(za), x2: px(zb), y2: py(zb), class: "edge " + type }, gEdges);
  }
  el("g", { id: "route-layer" }, svg);

  const gZones = el("g", { id: "zone-layer" }, svg);
  const fill = { blue: "var(--blue)", yellow: "var(--yellow)", red: "var(--red)", black: "var(--black)" };
  for (const z of zones) {
    const c = el("circle", {
      cx: px(z), cy: py(z),
      r: z.kind === "city" ? 4 : 2.6,
      fill: fill[z.color],
      class: "zone " + z.kind,
      "data-id": z.id,
    }, gZones);
    const cc = cityColor(z);
    if (cc) {
      // королевский город — заливка его цветом; портальный город — цветная обводка
      if (z.name.endsWith(" Portal")) { c.style.stroke = cc; c.classList.add("portal-city"); }
      else c.style.fill = cc;
    }
    el("title", {}, c);
  }

  el("g", { id: "dungeon-layer" }, svg);
  const gLabels = el("g", {}, svg);
  for (const z of zones) {
    if (!(z.kind === "city" && z.color !== "black") && !z.name.endsWith("Portal")) continue;
    const lbl = el("text", { x: px(z) + 5, y: py(z) + 2.5, class: "label" }, gLabels);
    lbl.textContent = z.name;
    if (cityColor(z)) lbl.style.fill = cityColor(z);
  }

  svg.addEventListener("click", (e) => {
    if (view.dragged) return;
    const id = e.target.getAttribute && e.target.getAttribute("data-id");
    if (!id) return;
    state.infoZone = id;
    renderZoneInfo();
    if (state.pickNext === "from") {
      $("from").value = zone(id).name;
      $("to").value = "";
      state.pickNext = "to";
      state.result = { kind: "pick", from: id };
      setRoute([id]);
      renderResult();
    } else {
      $("to").value = zone(id).name;
      state.pickNext = "from";
      search();
    }
  });

  enablePanZoom(svg);
  drawDungeonLayer();
  updateMapTitles();
}

function updateMapTitles() {
  if (!state.graph) return;
  const t = T();
  document.querySelectorAll("#zone-layer .zone").forEach((c) => {
    const z = zone(c.getAttribute("data-id"));
    const tier = z.tier && z.kind !== "city" ? `, T${z.tier}` : "";
    const dng = dngMatches(z.id).map((e) => "\n• " + dngTitle(e)).join("");
    c.firstChild.textContent = `${z.name} — ${t.colorName[z.color]}${tier}${dng}`;
  });
}

function setRoute(ids) {
  state.routeIds = ids;
  drawDungeonLayer();
  const layer = $("route-layer");
  layer.innerHTML = "";
  const onRoute = new Set(ids || []);
  document.querySelectorAll("#zone-layer .zone").forEach((c) => {
    c.classList.toggle("dim", !!ids && ids.length > 1 && !onRoute.has(c.getAttribute("data-id")));
  });
  if (!ids) return;
  const zs = ids.map(zone);
  if (zs.length > 1) el("polyline", { points: zs.map((z) => `${px(z)},${py(z)}`).join(" "), class: "route" }, layer);
  for (const z of [zs[0], zs[zs.length - 1]]) el("circle", { cx: px(z), cy: py(z), r: 5, class: "route-node" }, layer);
  if (zs.length > 1) fitTo(zs);
}

function fitTo(zs) {
  const pad = 25;
  const xs = zs.map(px), ys = zs.map(py);
  let x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  let w = Math.max(...xs) - x + pad, h = Math.max(...ys) - y + pad;
  // подгоняем под пропорции самого окна карты, а не всей карты мира
  const r = $("map").getBoundingClientRect();
  const ratio = r.width && r.height ? r.width / r.height : view.full.w / view.full.h;
  if (w / h < ratio) { const nw = h * ratio; x -= (nw - w) / 2; w = nw; }
  else { const nh = w / ratio; y -= (nh - h) / 2; h = nh; }
  Object.assign(view, { x, y, w, h });
  applyView();
}

function applyView() {
  const svg = $("map");
  svg.setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
  // подписи и линия маршрута остаются одного размера на экране при любом зуме
  if (view.full) svg.style.setProperty("--k", Math.max(view.w / view.full.w, 0.08).toFixed(3));
}

function enablePanZoom(svg) {
  const toSvg = (cx, cy) => {
    const r = svg.getBoundingClientRect();
    const scale = Math.max(view.w / r.width, view.h / r.height);
    const offX = (r.width * scale - view.w) / 2, offY = (r.height * scale - view.h) / 2;
    return { x: view.x - offX + (cx - r.left) * scale, y: view.y - offY + (cy - r.top) * scale, scale };
  };
  function zoomAt(cx, cy, k) {
    const p = toSvg(cx, cy);
    const w = Math.min(view.full.w * 1.5, Math.max(40, view.w * k));
    const kk = w / view.w;
    view.x = p.x - (p.x - view.x) * kk;
    view.y = p.y - (p.y - view.y) * kk;
    view.w = w;
    view.h *= kk;
    applyView();
  }
  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    zoomAt(e.clientX, e.clientY, e.deltaY > 0 ? 1.15 : 1 / 1.15);
  }, { passive: false });

  const pointers = new Map();
  let last = null, pinch = null;
  svg.addEventListener("pointerdown", (e) => {
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    last = { x: e.clientX, y: e.clientY };
    view.dragged = false;
  });
  svg.addEventListener("pointermove", (e) => {
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.size === 2) {
      const [a, b] = [...pointers.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinch / d);
      pinch = d;
      view.dragged = true;
      return;
    }
    const { scale } = toSvg(e.clientX, e.clientY);
    const dx = e.clientX - last.x, dy = e.clientY - last.y;
    if (Math.abs(dx) + Math.abs(dy) > 3) view.dragged = true;
    if (view.dragged) {
      if (!svg.hasPointerCapture(e.pointerId)) svg.setPointerCapture(e.pointerId);
      view.x -= dx * scale;
      view.y -= dy * scale;
      applyView();
    }
    last = { x: e.clientX, y: e.clientY };
  });
  const end = (e) => { pointers.delete(e.pointerId); if (pointers.size < 2) pinch = null; };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("dblclick", () => { Object.assign(view, view.full); applyView(); });
}

// ---------- утилиты и запуск ----------

function esc(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

loadPrefs();
applyLang();

document.querySelectorAll("[data-lang]").forEach((b) =>
  b.addEventListener("click", () => {
    state.lang = b.dataset.lang;
    savePrefs();
    applyLang();
  })
);
$("route-form").addEventListener("submit", (e) => { e.preventDefault(); search(); });
$("swap").addEventListener("click", () => {
  [$("from").value, $("to").value] = [$("to").value, $("from").value];
  if ($("from").value && $("to").value) search();
});
document.querySelectorAll("input[name=safety], input[name=metric], #portals").forEach((i) =>
  i.addEventListener("change", () => { if ($("from").value && $("to").value) search(); })
);

$("dng-on").addEventListener("change", (e) => { state.dng.on = e.target.checked; onDngChange(); });
$("dng-side").addEventListener("change", (e) => { state.dng.side = e.target.checked; onDngChange(); });
$("dng-tiers").addEventListener("click", (e) => {
  const b = e.target.closest("[data-tier]");
  if (!b || !state.dng.on) return;
  const tier = Number(b.dataset.tier);
  const tiers = state.dng.tiers;
  // клик по единственному выбранному тиру снова включает все
  if (tiers.has(tier) && tiers.size === 1) DNG_TIERS.forEach((x) => tiers.add(x));
  else if (tiers.has(tier)) tiers.delete(tier);
  else tiers.add(tier);
  onDngChange();
});

load()
  .then(() => {
    drawMap();
    renderDngControls();
    if (readHash()) search();
  })
  .catch(() => {
    $("result").innerHTML = `<div class="warn">${T().loadError}</div>`;
  });

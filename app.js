// Albion Pathfinder — поиск кратчайшего пути между зонами Albion Online.
// Данные: data/zones.json (собирается tools/build_zones.py из ao-bin-dumps).

const LEVELS = ["blue", "yellow", "red", "black"];
const LEVEL_NAME = { blue: "синие", yellow: "жёлтые", red: "красные", black: "чёрные" };
const COLOR_RU = { blue: "синяя", yellow: "жёлтая", red: "красная", black: "чёрная" };

const state = {
  zones: new Map(),      // id -> zone
  byName: new Map(),     // lower-case name -> id
  adj: new Map(),        // id -> [{ to, type }]
  edges: [],
  route: null,
  pickNext: "from",
};

const $ = (id) => document.getElementById(id);

// ---------- загрузка данных ----------

async function load() {
  const res = await fetch("data/zones.json");
  if (!res.ok) throw new Error("Не удалось загрузить data/zones.json");
  const data = await res.json();

  for (const z of data.zones) {
    state.zones.set(z.id, z);
    state.byName.set(z.name.toLowerCase(), z.id);
    state.adj.set(z.id, []);
  }
  for (const [a, b, type] of data.edges) {
    state.adj.get(a).push({ to: b, type });
    state.adj.get(b).push({ to: a, type });
  }
  state.edges = data.edges;

  $("data-version").textContent = data.version;

  const list = $("zone-list");
  const names = [...state.zones.values()].map((z) => z.name).sort((x, y) => x.localeCompare(y));
  list.innerHTML = names.map((n) => `<option value="${escapeHtml(n)}"></option>`).join("");
}

// ---------- поиск пути ----------

// Поиск в ширину: все переходы стоят одинаково (1 зона = 1 шаг).
// Разрешены только зоны не опаснее выбранного уровня. Старт и финиш
// разрешены всегда — человек может уже стоять в красной зоне.
function findPath(fromId, toId, maxLevel, usePortals) {
  const maxIdx = LEVELS.indexOf(maxLevel);
  const allowed = (id) =>
    id === fromId || id === toId || LEVELS.indexOf(state.zones.get(id).color) <= maxIdx;

  const prev = new Map([[fromId, null]]);
  const queue = [fromId];
  for (let head = 0; head < queue.length; head++) {
    const u = queue[head];
    if (u === toId) break;
    for (const { to, type } of state.adj.get(u)) {
      if (prev.has(to) || !allowed(to)) continue;
      if (type === "portal" && !usePortals) continue;
      prev.set(to, { from: u, type });
      queue.push(to);
    }
  }
  if (!prev.has(toId)) return null;

  const path = [];
  for (let cur = toId; cur !== null; ) {
    const p = prev.get(cur);
    path.push({ id: cur, via: p ? p.type : null });
    cur = p ? p.from : null;
  }
  return path.reverse();
}

function resolveZone(text) {
  const key = text.trim().toLowerCase();
  if (state.byName.has(key)) return state.byName.get(key);
  // мягкий поиск: единственное совпадение по началу или подстроке
  const names = [...state.byName.keys()];
  const starts = names.filter((n) => n.startsWith(key));
  if (starts.length === 1) return state.byName.get(starts[0]);
  const parts = names.filter((n) => n.includes(key));
  if (parts.length === 1) return state.byName.get(parts[0]);
  return null;
}

// ---------- вывод результата ----------

function showRoute() {
  const out = $("result");
  const fromId = resolveZone($("from").value);
  const toId = resolveZone($("to").value);
  const level = document.querySelector("input[name=safety]:checked").value;
  const usePortals = $("portals").checked;

  if (!fromId || !toId) {
    const bad = !fromId ? $("from").value : $("to").value;
    out.innerHTML = `<div class="warn">Зона «${escapeHtml(bad)}» не найдена. Выберите название из списка.</div>`;
    setRoute(null);
    return;
  }
  $("from").value = state.zones.get(fromId).name;
  $("to").value = state.zones.get(toId).name;
  writeHash(fromId, toId, level, usePortals);

  if (fromId === toId) {
    out.innerHTML = `<div class="summary">Вы уже на месте 🙂</div>`;
    setRoute([{ id: fromId, via: null }]);
    return;
  }

  const path = findPath(fromId, toId, level, usePortals);
  if (!path) {
    // подсказка: с каким минимальным уровнем путь появится
    let hint = "";
    for (const lv of LEVELS.slice(LEVELS.indexOf(level) + 1)) {
      const p = findPath(fromId, toId, lv, usePortals);
      if (p) {
        hint = ` Путь есть, если разрешить зоны до уровня «${LEVEL_NAME[lv]}» (${p.length - 1} переходов).`;
        break;
      }
    }
    out.innerHTML = `<div class="warn">Через ${describeLevel(level)} зоны пути нет.${hint}</div>`;
    setRoute(null);
    return;
  }

  const jumps = path.length - 1;
  const danger = worstColor(path.slice(1, -1).map((s) => s.id));
  const endsWarn = [fromId, toId]
    .map((id) => state.zones.get(id))
    .filter((z) => LEVELS.indexOf(z.color) > LEVELS.indexOf(level));

  let html = `<div class="summary">Переходов: <b>${jumps}</b> · зон на пути: <b>${path.length}</b>`;
  if (danger) html += ` · самая опасная: <b>${COLOR_RU[danger]}</b>`;
  html += `</div>`;
  if (endsWarn.length) {
    html += `<div class="warn">Внимание: ${endsWarn
      .map((z) => `«${escapeHtml(z.name)}» — ${COLOR_RU[z.color]} зона`)
      .join(", ")}. Старт и финиш учитываются всегда.</div>`;
  }
  html += `<ol class="steps">${path
    .map((s) => {
      const z = state.zones.get(s.id);
      const portal = s.via === "portal" ? `<span class="portal">через портал</span>` : "";
      const tier = z.tier && z.kind !== "city" ? `T${z.tier}` : z.kind === "city" ? "город" : "";
      return `<li><i class="dot ${z.color}" title="${COLOR_RU[z.color]}"></i>${escapeHtml(z.name)} ${portal}<span class="meta">${tier}</span></li>`;
    })
    .join("")}</ol>`;
  out.innerHTML = html;
  setRoute(path);
}

function worstColor(ids) {
  let worst = -1;
  for (const id of ids) worst = Math.max(worst, LEVELS.indexOf(state.zones.get(id).color));
  return worst >= 0 ? LEVELS[worst] : null;
}

function describeLevel(level) {
  return LEVELS.slice(0, LEVELS.indexOf(level) + 1).map((l) => LEVEL_NAME[l]).join(" и ");
}

// ---------- ссылка на маршрут (#from=...&to=...) ----------

function writeHash(fromId, toId, level, portals) {
  const p = new URLSearchParams({ from: fromId, to: toId, s: level, p: portals ? "1" : "0" });
  history.replaceState(null, "", "#" + p.toString());
}

function readHash() {
  const p = new URLSearchParams(location.hash.slice(1));
  const from = state.zones.get(p.get("from"));
  const to = state.zones.get(p.get("to"));
  if (!from || !to) return false;
  $("from").value = from.name;
  $("to").value = to.name;
  const s = p.get("s");
  if (LEVELS.includes(s)) document.querySelector(`input[name=safety][value=${s}]`).checked = true;
  $("portals").checked = p.get("p") !== "0";
  return true;
}

// ---------- карта ----------

const SVG_NS = "http://www.w3.org/2000/svg";
const view = { x: 0, y: 0, w: 0, h: 0, full: null };

function el(tag, attrs, parent) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) e.setAttribute(k, attrs[k]);
  if (parent) parent.appendChild(e);
  return e;
}

// В данных игры y растёт на север, в SVG — вниз, поэтому переворачиваем.
const px = (z) => z.x;
const py = (z) => -z.y;

function drawMap() {
  const svg = $("map");
  svg.innerHTML = "";
  const zones = [...state.zones.values()];
  const xs = zones.map(px), ys = zones.map(py);
  const pad = 15;
  const minX = Math.min(...xs) - pad, maxX = Math.max(...xs) + pad;
  const minY = Math.min(...ys) - pad, maxY = Math.max(...ys) + pad;
  view.full = { x: minX, y: minY, w: maxX - minX, h: maxY - minY };
  Object.assign(view, view.full);
  applyView();

  const gEdges = el("g", {}, svg);
  for (const [a, b, type] of state.edges) {
    const za = state.zones.get(a), zb = state.zones.get(b);
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
    const t = el("title", {}, c);
    t.textContent = `${z.name} — ${COLOR_RU[z.color]}${z.tier && z.kind !== "city" ? ", T" + z.tier : ""}`;
  }

  const gLabels = el("g", {}, svg);
  for (const z of zones.filter((z) => z.kind === "city" && z.color !== "black" || z.name.endsWith("Portal"))) {
    const t = el("text", { x: px(z) + 5, y: py(z) + 2.5, class: "label" }, gLabels);
    t.textContent = z.name;
  }

  svg.addEventListener("click", (e) => {
    if (view.dragged) return;
    const id = e.target.getAttribute && e.target.getAttribute("data-id");
    if (!id) return;
    const name = state.zones.get(id).name;
    if (state.pickNext === "from") {
      $("from").value = name;
      $("to").value = "";
      state.pickNext = "to";
      $("result").innerHTML = `<div class="summary">Откуда: <b>${escapeHtml(name)}</b>. Теперь выберите, куда.</div>`;
      setRoute([{ id, via: null }]);
    } else {
      $("to").value = name;
      state.pickNext = "from";
      showRoute();
    }
  });

  enablePanZoom(svg);
}

function setRoute(path) {
  state.route = path;
  const layer = $("route-layer");
  layer.innerHTML = "";
  const onRoute = new Set(path ? path.map((s) => s.id) : []);
  document.querySelectorAll("#zone-layer .zone").forEach((c) => {
    c.classList.toggle("dim", !!path && path.length > 1 && !onRoute.has(c.getAttribute("data-id")));
  });
  if (!path) return;
  const pts = path.map((s) => state.zones.get(s.id)).map((z) => `${px(z)},${py(z)}`).join(" ");
  if (path.length > 1) el("polyline", { points: pts, class: "route" }, layer);
  for (const s of [path[0], path[path.length - 1]]) {
    const z = state.zones.get(s.id);
    el("circle", { cx: px(z), cy: py(z), r: 5, class: "route-node" }, layer);
  }
  if (path.length > 1) fitTo(path.map((s) => state.zones.get(s.id)));
}

// Приближаем карту к маршруту
function fitTo(zones) {
  const xs = zones.map(px), ys = zones.map(py);
  const pad = 25;
  let x = Math.min(...xs) - pad, y = Math.min(...ys) - pad;
  let w = Math.max(...xs) - x + pad, h = Math.max(...ys) - y + pad;
  const ratio = view.full.w / view.full.h;
  if (w / h < ratio) { const nw = h * ratio; x -= (nw - w) / 2; w = nw; }
  else { const nh = w / ratio; y -= (nh - h) / 2; h = nh; }
  Object.assign(view, { x, y, w, h });
  applyView();
}

function applyView() {
  $("map").setAttribute("viewBox", `${view.x} ${view.y} ${view.w} ${view.h}`);
}

function enablePanZoom(svg) {
  const toSvg = (clientX, clientY) => {
    const r = svg.getBoundingClientRect();
    // учитываем preserveAspectRatio="xMidYMid meet"
    const scale = Math.max(view.w / r.width, view.h / r.height);
    const offX = (r.width * scale - view.w) / 2;
    const offY = (r.height * scale - view.h) / 2;
    return { x: view.x - offX + (clientX - r.left) * scale, y: view.y - offY + (clientY - r.top) * scale, scale };
  };

  svg.addEventListener("wheel", (e) => {
    e.preventDefault();
    const k = e.deltaY > 0 ? 1.15 : 1 / 1.15;
    zoomAt(e.clientX, e.clientY, k);
  }, { passive: false });

  function zoomAt(cx, cy, k) {
    const p = toSvg(cx, cy);
    const w = Math.min(view.full.w * 1.5, Math.max(40, view.w * k));
    const realK = w / view.w;
    view.x = p.x - (p.x - view.x) * realK;
    view.y = p.y - (p.y - view.y) * realK;
    view.w = w;
    view.h = view.h * realK;
    applyView();
  }

  // перетаскивание мышью/пальцем + щипок двумя пальцами
  const pointers = new Map();
  let last = null, pinchDist = null;
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
      if (pinchDist) zoomAt((a.x + b.x) / 2, (a.y + b.y) / 2, pinchDist / d);
      pinchDist = d;
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
  const end = (e) => {
    pointers.delete(e.pointerId);
    if (pointers.size < 2) pinchDist = null;
  };
  svg.addEventListener("pointerup", end);
  svg.addEventListener("pointercancel", end);
  svg.addEventListener("dblclick", () => { Object.assign(view, view.full); applyView(); });
}

// ---------- утилиты и запуск ----------

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

$("route-form").addEventListener("submit", (e) => { e.preventDefault(); showRoute(); });
$("swap").addEventListener("click", () => {
  [$("from").value, $("to").value] = [$("to").value, $("from").value];
  if ($("from").value && $("to").value) showRoute();
});
document.querySelectorAll("input[name=safety], #portals").forEach((i) =>
  i.addEventListener("change", () => { if ($("from").value && $("to").value) showRoute(); })
);

load()
  .then(() => {
    drawMap();
    if (readHash()) showRoute();
  })
  .catch((err) => {
    $("result").innerHTML = `<div class="warn">${escapeHtml(err.message)}. Если вы открыли файл напрямую, запустите локальный сервер (см. README).</div>`;
  });

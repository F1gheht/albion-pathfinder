// Albion Pathfinder — поиск пути. Чистая логика без DOM:
// работает и в браузере (window.Pathfinder), и в Node (для тестов).
(function (root) {
  "use strict";

  const LEVELS = ["blue", "yellow", "red", "black"];

  // Режим «меньше идти»: каждый переход дополнительно стоит столько,
  // сколько примерно занимает загрузка зоны (в единицах координат зоны).
  const TRANSITION_COST = 60;
  // Режим «меньше переходов»: переход настолько «дорогой», что путь с меньшим
  // числом зон всегда выигрывает, а расстояние решает только при равенстве.
  const HOP_COST = 1e7;

  const dist = (x1, y1, x2, y2) => Math.hypot(x1 - x2, y1 - y2);

  // Двоичная куча для Дейкстры: элементы [стоимость, индекс перехода]
  class Heap {
    constructor() { this.a = []; }
    get size() { return this.a.length; }
    push(item) {
      const a = this.a;
      a.push(item);
      for (let i = a.length - 1; i > 0; ) {
        const p = (i - 1) >> 1;
        if (a[p][0] <= a[i][0]) break;
        [a[p], a[i]] = [a[i], a[p]];
        i = p;
      }
    }
    pop() {
      const a = this.a;
      const top = a[0];
      const last = a.pop();
      if (a.length) {
        a[0] = last;
        for (let i = 0; ; ) {
          const l = 2 * i + 1, r = l + 1;
          let m = i;
          if (l < a.length && a[l][0] < a[m][0]) m = l;
          if (r < a.length && a[r][0] < a[m][0]) m = r;
          if (m === i) break;
          [a[m], a[i]] = [a[i], a[m]];
          i = m;
        }
      }
      return top;
    }
  }

  class Graph {
    constructor(data) {
      this.zones = new Map();
      this.out = new Map(); // id зоны -> исходящие переходы
      for (const z of data.zones) {
        this.zones.set(z.id, z);
        this.out.set(z.id, []);
      }
      this.links = data.links.map(([from, to, type, dir, ax, ay, bx, by], i) => ({
        i, from, to, type, dir, ax, ay, bx, by,
      }));
      for (const l of this.links) this.out.get(l.from).push(l);
    }

    /**
     * Ищет путь from -> to.
     * options:
     *   maxLevel "blue" | "yellow" | "red" | "black" — самая опасная разрешённая зона
     *   portals  true/false — можно ли пользоваться порталами
     *   metric   "hops" (меньше переходов) | "distance" (меньше идти)
     *
     * Состояние поиска — переход, через который игрок вошёл в зону: путь внутри
     * зоны зависит от того, где ты появился. Старт и финиш — центры зон.
     * Расстояние внутри зоны — по прямой между точкой появления и выходом.
     *
     * Возвращает { steps: [{ zone, link }], hops, distance } или null.
     * link — переход, которым игрок ВОШЁЛ в эту зону (у первой — null).
     */
    findPath(from, to, options) {
      const opt = Object.assign({ maxLevel: "black", portals: true, metric: "hops" }, options);
      if (!this.zones.has(from) || !this.zones.has(to)) return null;
      if (from === to) return { steps: [{ zone: from, link: null }], hops: 0, distance: 0 };

      const maxIdx = LEVELS.indexOf(opt.maxLevel);
      const allowed = (id) =>
        id === from || id === to || LEVELS.indexOf(this.zones.get(id).color) <= maxIdx;
      const stepCost = opt.metric === "distance" ? TRANSITION_COST : HOP_COST;

      const n = this.links.length;
      const best = new Float64Array(n).fill(Infinity);
      const prev = new Int32Array(n).fill(-1); // -1 = пришли из старта
      const heap = new Heap();

      const relax = (fromLink, baseCost, px, py, zone) => {
        for (const l of this.out.get(zone)) {
          if (l.type === "portal" && !opt.portals) continue;
          if (!allowed(l.to)) continue;
          const c = baseCost + dist(px, py, l.ax, l.ay) + stepCost;
          if (c < best[l.i]) {
            best[l.i] = c;
            prev[l.i] = fromLink;
            heap.push([c, l.i]);
          }
        }
      };

      relax(-1, 0, 0, 0, from);
      let goal = -1, goalCost = Infinity;
      while (heap.size) {
        const [c, li] = heap.pop();
        if (c > best[li]) continue;   // устаревшая запись
        if (c >= goalCost) break;     // дальше только дороже
        const l = this.links[li];
        if (l.to === to) {
          // последний отрезок: от точки появления до центра конечной зоны
          const total = c + dist(l.bx, l.by, 0, 0);
          if (total < goalCost) { goalCost = total; goal = li; }
          continue;
        }
        relax(li, c, l.bx, l.by, l.to);
      }
      if (goal < 0) return null;

      const used = [];
      for (let li = goal; li >= 0; li = prev[li]) used.push(this.links[li]);
      used.reverse();

      const steps = [{ zone: from, link: null }];
      for (const l of used) steps.push({ zone: l.to, link: l });

      let distance = 0, px = 0, py = 0;
      for (const l of used) {
        distance += dist(px, py, l.ax, l.ay);
        px = l.bx; py = l.by;
      }
      distance += dist(px, py, 0, 0);
      return { steps, hops: used.length, distance: Math.round(distance) };
    }
  }

  const api = { LEVELS, Graph, TRANSITION_COST };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Pathfinder = api;
})(typeof window !== "undefined" ? window : globalThis);

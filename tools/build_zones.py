#!/usr/bin/env python3
"""
Собирает граф зон Albion Online из дампа ao-data/ao-bin-dumps.

Использование:
    git clone --depth 1 https://github.com/ao-data/ao-bin-dumps.git
    python tools/build_zones.py ao-bin-dumps/cluster/world.xml data/zones.json

Результат — компактный JSON, который читает сайт:
    {
      "version": "...",
      "zones": [{"id", "name", "color", "tier", "x", "y", "kind"}],
      "links": [[from, to, type, dir, ax, ay, bx, by]]
    }

links — направленные переходы:
    type    "road" (обычный выход) или "portal" (портал город <-> Outlands)
    dir     сторона света выхода в зоне from: N, NE, E, SE, S, SW, W, NW
    ax, ay  где находится выход в зоне from (относительно центра зоны)
    bx, by  где игрок появляется в зоне to (относительно центра зоны)
Координаты внутри зоны уже повёрнуты так, что север — вверх, как на карте мира.
"""
import json
import math
import re
import sys
import xml.etree.ElementTree as ET
from collections import Counter
from datetime import date

# Координаты выходов внутри зоны повёрнуты на 45° относительно карты мира
# (изометрическая камера). Угол подобран по ~1400 выходам: направление на
# выход совпадает с направлением на соседнюю зону на карте мира.
LOCAL_TO_WORLD_DEG = -45.0
COMPASS = ["E", "NE", "N", "NW", "W", "SW", "S", "SE"]


def classify(ctype: str):
    """Цвет и вид кластера, или None, если он не нужен на карте.
    blue = безопасно, yellow = PvP без полного лута, red = полный лут,
    black = Outlands."""
    if ctype in ("STARTINGCITY", "PLAYERCITY_SAFEAREA_01", "PLAYERCITY_SAFEAREA_02"):
        return "blue", "city"
    if ctype == "SAFEAREA":
        return "blue", "zone"
    if ctype == "OPENPVP_YELLOW":
        return "yellow", "zone"
    if ctype == "OPENPVP_RED":
        return "red", "zone"
    if ctype == "PLAYERCITY_BLACK_ROYAL":  # Caerleon — город посреди красных зон
        return "red", "city"
    if ctype.startswith("OPENPVP_BLACK"):
        return "black", "zone"
    if ctype in ("PLAYERCITY_BLACK_PORTALCITY_NOFURNITURE", "PLAYERCITY_BLACK_REST"):
        return "black", "city"
    if ctype.startswith("PASSAGE_"):
        color = ctype.split("_", 1)[1].lower()
        color = {"safearea": "blue"}.get(color, color)
        if color in ("blue", "yellow", "red", "black"):
            return color, "passage"
    return None


def tier_from_file(fname: str):
    m = re.search(r"_T(\d)_", fname or "")
    return int(m.group(1)) if m else None


def split_target(targetid: str):
    """'<guid выхода>@<id кластера>' -> (guid, cluster)"""
    if not targetid or "@" not in targetid:
        return None, None
    guid, cluster = targetid.rsplit("@", 1)
    return guid, cluster


def floats(s):
    return [float(v) for v in (s or "").split()]


class Cluster:
    """Обёртка над <cluster>: центр и перевод локальных координат в «север вверх»."""

    def __init__(self, el):
        self.el = el
        ox, oy = floats(el.get("origin")) or (0, 0)
        sx, sy = floats(el.get("size")) or (0, 0)
        self.cx, self.cy = ox + sx / 2, oy + sy / 2
        a = math.radians(LOCAL_TO_WORLD_DEG)
        self.cos, self.sin = math.cos(a), math.sin(a)

    def local(self, pos):
        """Позиция объекта в зоне -> (x восток, y север) относительно центра."""
        p = floats(pos)
        if len(p) != 2:
            return 0.0, 0.0
        dx, dy = p[0] - self.cx, p[1] - self.cy
        return dx * self.cos - dy * self.sin, dx * self.sin + dy * self.cos

    def exits(self):
        ex = self.el.find("exits")
        return list(ex) if ex is not None else []

    def portal_exits(self):
        ex = self.el.find("portalexits")
        return list(ex) if ex is not None else []


def compass(x, y, kind="zone"):
    """Сторона света выхода по его координатам (север вверх).

    Обычная зона на карте — квадрат, повёрнутый ромбом, и выходы стоят на его
    четырёх сторонах. Поэтому у не-городов направление всегда «двойное»:
    NE, NW, SE или SW — по тому, на какой стороне ромба выход. Проверено:
    в ~95% случаев совпадает с направлением на соседнюю зону по карте мира.
    У городов выходы бывают где угодно, для них — 8 направлений по углу.
    """
    if abs(x) < 1e-6 and abs(y) < 1e-6:
        return None
    if kind != "city":
        return ("N" if y >= 0 else "S") + ("E" if x >= 0 else "W")
    ang = math.degrees(math.atan2(y, x)) % 360
    return COMPASS[int((ang + 22.5) // 45) % 8]


def main(src, dst):
    root = ET.parse(src).getroot()
    raw = {c.get("id"): c for c in root.find("clusters")}
    clusters = {cid: Cluster(el) for cid, el in raw.items()}

    zones = {}
    for cid, el in raw.items():
        if el.get("enabled") != "true":
            continue
        info = classify(el.get("type", ""))
        if not info:
            continue
        color, kind = info
        pos = floats(el.get("worldmapposition"))
        zones[cid] = {
            "id": cid,
            "name": el.get("displayname") or cid,
            "color": color,
            "tier": tier_from_file(el.get("file")),
            "x": round(pos[0], 1) if len(pos) == 2 else None,
            "y": round(pos[1], 1) if len(pos) == 2 else None,
            "kind": kind,
        }

    # Индекс выходов по id: (кластер, guid) -> элемент <exit>
    exit_by_id = {}
    for cid, c in clusters.items():
        for e in c.exits():
            exit_by_id[(cid, e.get("id"))] = e
        for e in c.portal_exits():
            exit_by_id[(cid, e.get("id"))] = e

    links = {}  # ключ без дублей -> запись

    def add(a, b, etype, a_pos, b_pos):
        if a not in zones or b not in zones or a == b:
            return
        ax, ay = a_pos
        bx, by = b_pos
        rec = [a, b, etype, compass(ax, ay, zones[a]["kind"]) if etype == "road" else None,
               round(ax), round(ay), round(bx), round(by)]
        links[(a, b, etype, rec[4], rec[5])] = rec

    # 1) Обычные выходы. Тип перехода может быть "Cluster" или, например,
    #    "DungeonSolo" (вход в The Underway) — берём любой, если цель — зона карты.
    for cid in zones:
        c = clusters[cid]
        for e in c.exits():
            guid, tgt = split_target(e.get("targetid"))
            if tgt not in zones:
                continue
            back = exit_by_id.get((tgt, guid))
            arrive = clusters[tgt].local(back.get("pos")) if back is not None else (0.0, 0.0)
            add(cid, tgt, "road", c.local(e.get("pos")), arrive)

    # 2) Порталы: портальный город в Outlands -> Conquerors' Hall внутри
    #    королевского города. Связываем с самим городом; точка появления —
    #    дверь зала в городе.
    def hall_door_in_city(hall_id):
        hall = clusters.get(hall_id)
        if hall is None:
            return None, None
        for e in hall.exits():
            guid, tgt = split_target(e.get("targetid"))
            if tgt in zones and zones[tgt]["kind"] == "city":
                door = exit_by_id.get((tgt, guid))
                pos = clusters[tgt].local(door.get("pos")) if door is not None else (0.0, 0.0)
                return tgt, pos
        return None, None

    for cid in zones:
        c = clusters[cid]
        for p in c.portal_exits():
            _, hall_id = split_target(p.get("targetid"))
            city, door = hall_door_in_city(hall_id)
            if not city:
                continue
            portal_pos = c.local(p.get("pos"))
            add(cid, city, "portal", portal_pos, door)
            add(city, cid, "portal", door, portal_pos)

    links = list(links.values())

    # Оставляем основную связную часть карты: изолированные зоны
    # (например, Brecilien в Туманах) статически недостижимы.
    adj = {k: set() for k in zones}
    for a, b, *_ in links:
        adj[a].add(b)
        adj[b].add(a)
    best, seen = set(), set()
    for start in zones:
        if start in seen:
            continue
        comp, stack = {start}, [start]
        while stack:
            u = stack.pop()
            for v in adj[u] - comp:
                comp.add(v)
                stack.append(v)
        seen |= comp
        if len(comp) > len(best):
            best = comp
    zones = {k: v for k, v in zones.items() if k in best}
    links = [l for l in links if l[0] in best and l[1] in best]

    # Проходы без координат на карте ставим посередине между соседями
    for z in zones.values():
        if z["x"] is None:
            pts = [(zones[n]["x"], zones[n]["y"]) for n in adj[z["id"]]
                   if n in zones and zones[n]["x"] is not None]
            if pts:
                z["x"] = round(sum(p[0] for p in pts) / len(pts), 1)
                z["y"] = round(sum(p[1] for p in pts) / len(pts), 1)

    out = {
        "version": date.today().isoformat(),
        "source": "https://github.com/ao-data/ao-bin-dumps (cluster/world.xml)",
        "zones": sorted(zones.values(), key=lambda z: z["name"]),
        "links": sorted(links, key=lambda l: (l[0], l[1], l[2], l[4], l[5])),
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    pairs = {tuple(sorted(l[:2])) for l in links}
    one_way = {(a, b) for a, b, *_ in links} ^ {(b, a) for a, b, *_ in links}
    print(f"зон: {len(zones)}, соседних пар: {len(pairs)}, переходов: {len(links)}")
    print("цвета:", dict(Counter(z["color"] for z in zones.values())))
    print("типы переходов:", dict(Counter(l[2] for l in links)))
    print("односторонних пар:", len(one_way) // 2 if one_way else 0)


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])

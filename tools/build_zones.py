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
      "edges": [["idA", "idB", "road" | "portal"]]
    }
"""
import json
import re
import sys
import xml.etree.ElementTree as ET
from datetime import date

# Какие типы кластеров считаем частью карты и какого они цвета.
# blue = безопасно, yellow = PvP без полного лута, red = полный лут,
# black = Outlands (полный лут, гильдейские территории).
def classify(ctype: str):
    """Возвращает (color, kind) или None, если кластер не нужен."""
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


def target_cluster(targetid: str):
    # формат: "<guid выхода>@<id кластера>"
    if not targetid or "@" not in targetid:
        return None
    return targetid.rsplit("@", 1)[1]


def main(src, dst):
    root = ET.parse(src).getroot()
    clusters = {c.get("id"): c for c in root.find("clusters")}

    zones = {}
    for cid, c in clusters.items():
        if c.get("enabled") != "true":
            continue
        info = classify(c.get("type", ""))
        if not info:
            continue
        color, kind = info
        pos = (c.get("worldmapposition") or "").split()
        zones[cid] = {
            "id": cid,
            "name": c.get("displayname") or cid,
            "color": color,
            "tier": tier_from_file(c.get("file")),
            "x": round(float(pos[0]), 1) if len(pos) == 2 else None,
            "y": round(float(pos[1]), 1) if len(pos) == 2 else None,
            "kind": kind,
        }

    edges = set()

    def add(a, b, etype):
        if a in zones and b in zones and a != b:
            edges.add((min(a, b), max(a, b), etype))

    # 1) Обычные выходы между зонами
    for cid in zones:
        exits = clusters[cid].find("exits")
        if exits is None:
            continue
        for e in exits:
            if e.get("targettype") != "Cluster":
                continue
            add(cid, target_cluster(e.get("targetid")), "road")

    # 2) Порталы: королевский город <-> портальный город в Outlands.
    #    В данных портал ведёт в Conquerors' Hall внутри города, поэтому
    #    ищем город, в который выходит этот зал.
    def city_of(cluster_id):
        if cluster_id in zones:
            return cluster_id
        hall = clusters.get(cluster_id)
        if hall is None or hall.find("exits") is None:
            return None
        for e in hall.find("exits"):
            t = target_cluster(e.get("targetid"))
            if t in zones and zones[t]["kind"] == "city":
                return t
        return None

    for cid in zones:
        pex = clusters[cid].find("portalexits")
        if pex is None:
            continue
        for p in pex:
            city = city_of(target_cluster(p.get("targetid")))
            if city:
                add(cid, city, "portal")

    # Оставляем только основную связную часть карты: изолированные зоны
    # (например, Brecilien в Туманах) статически недостижимы.
    adj = {k: set() for k in zones}
    for a, b, _ in edges:
        adj[a].add(b)
        adj[b].add(a)
    best = set()
    seen = set()
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
    edges = {e for e in edges if e[0] in best}

    # Проходы без координат на карте ставим посередине между соседями
    for z in zones.values():
        if z["x"] is None:
            nb = [zones[b if a == z["id"] else a] for a, b, _ in edges if z["id"] in (a, b)]
            pts = [(n["x"], n["y"]) for n in nb if n["x"] is not None]
            if pts:
                z["x"] = round(sum(p[0] for p in pts) / len(pts), 1)
                z["y"] = round(sum(p[1] for p in pts) / len(pts), 1)

    out = {
        "version": date.today().isoformat(),
        "source": "https://github.com/ao-data/ao-bin-dumps (cluster/world.xml)",
        "zones": sorted(zones.values(), key=lambda z: z["name"]),
        "edges": sorted([list(e) for e in edges]),
    }
    with open(dst, "w", encoding="utf-8") as f:
        json.dump(out, f, ensure_ascii=False, separators=(",", ":"))

    from collections import Counter
    print(f"зон: {len(zones)}, связей: {len(edges)}")
    print("цвета:", dict(Counter(z["color"] for z in zones.values())))
    print("типы связей:", dict(Counter(e[2] for e in edges)))


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(__doc__)
        sys.exit(1)
    main(sys.argv[1], sys.argv[2])

"""Maintains content/index.json and content/<lang>/course.json as doses are added."""
from __future__ import annotations

import json
import os
from typing import Optional

from .schema import SCHEMA_VERSION, Dose

# Default level ladder (CEFR-like). A course may override names/descriptions.
DEFAULT_LEVELS = [
    {"id": "A1", "name": "Iniciante", "description": "Primeiro contato: fala clara, temas concretos do dia a dia."},
    {"id": "A2", "name": "Básico", "description": "Rotina, histórias simples, ritmo pausado, vocabulário cotidiano."},
    {"id": "B1", "name": "Intermediário", "description": "Conversas naturais, opinião, narrativas mais longas."},
    {"id": "B2", "name": "Intermediário alto", "description": "Fala rápida, humor, gíria, temas abstratos."},
    {"id": "C1", "name": "Avançado", "description": "Conteúdo nativo sem concessões, nuance e registro."},
    {"id": "C2", "name": "Domínio", "description": "Qualquer conteúdo, sotaques e subculturas."},
]

# Exame de referência por idioma — o denominador do "quanto falta" que o app mostra.
_EXAMS = {"ko": "TOPIK", "ja": "JLPT"}
_TIER_LABELS = {
    "ko": [("A", "Básico", "TOPIK I · 1–2급", "A1–A2"),
           ("B", "Intermediário", "TOPIK II · 3–4급", "B1–B2"),
           ("C", "Avançado", "TOPIK II · 5–6급", "C1–C2")],
}


def _vocab_ladder(lang: str) -> Optional[dict]:
    """Escada de vocabulário do idioma: quantas palavras cada faixa tem.

    É o que permite ao app dizer "você tem 131 das 1.866 palavras do TOPIK I"
    sem embutir número nenhum no código do app. Sem tabela para o idioma, some.
    """
    labels = _TIER_LABELS.get(lang)
    if not labels:
        return None
    try:
        from .levels import tier_sizes
        sizes = tier_sizes(lang)
    except Exception:
        return None
    if not any(sizes.values()):
        return None
    return {
        "exam": _EXAMS.get(lang, ""),
        "source": "국립국어원 «한국어 학습용 어휘 목록» + TOPIK 어휘 목록 (2015)",
        "tiers": [{"tier": t, "name": n, "exam": e, "cefr": c, "words": sizes.get(t, 0)}
                  for t, n, e, c in labels],
    }


def _read_json(path: str) -> Optional[dict]:
    if not os.path.isfile(path):
        return None
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path: str, data: dict) -> None:
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, indent=2)


def update_course(content_root: str, dose: Dose, dose_rel_path: str,
                  native_name: str = "") -> None:
    """Insert/replace this dose in <lang>/course.json (ordered by level then lesson)."""
    lang = dose.language
    course_path = os.path.join(content_root, lang, "course.json")
    course = _read_json(course_path) or {
        "schemaVersion": SCHEMA_VERSION,
        "language": lang,
        "name": dose.languageName,
        "nativeName": native_name or dose.languageName,
        "levels": DEFAULT_LEVELS,
        "doses": [],
    }
    ladder = _vocab_ladder(lang)
    if ladder:
        course["vocabLadder"] = ladder
    ref = {
        "id": dose.id,
        "level": dose.level,
        "lessonNumber": dose.lessonNumber,
        "title": dose.title,
        "path": dose_rel_path,
        "durationSec": round(dose.media.durationSec),
        "cardCount": len(dose.cards),
        "mediaKind": dose.media.kind,
    }
    if dose.media.posterSrc:
        ref["posterSrc"] = dose.media.posterSrc
    # quantos cards desta dose caem em cada faixa — a biblioteca usa para
    # mostrar o nível da lição sem baixar o dose.json inteiro
    tiers: dict[str, int] = {}
    for c in dose.cards:
        if c.topikLevel:
            tiers[c.topikLevel] = tiers.get(c.topikLevel, 0) + 1
    if tiers:
        ref["cardTiers"] = tiers
    doses = [d for d in course["doses"] if d["id"] != dose.id]
    doses.append(ref)
    level_order = {lv["id"]: i for i, lv in enumerate(course["levels"])}
    doses.sort(key=lambda d: (level_order.get(d["level"], 99), d["lessonNumber"]))
    course["doses"] = doses
    _write_json(course_path, course)
    _update_index(content_root, course)


def _update_index(content_root: str, course: dict) -> None:
    index_path = os.path.join(content_root, "index.json")
    index = _read_json(index_path) or {"schemaVersion": SCHEMA_VERSION, "languages": []}
    lang = course["language"]
    entry = {
        "code": lang,
        "name": course["name"],
        "nativeName": course.get("nativeName", course["name"]),
        "coursePath": f"{lang}/course.json",
        "doseCount": len(course["doses"]),
    }
    langs = [x for x in index["languages"] if x["code"] != lang]
    langs.append(entry)
    langs.sort(key=lambda x: x["name"])
    index["languages"] = langs
    _write_json(index_path, index)

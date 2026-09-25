"""Nível de vocabulário (TOPIK / 국립국어원) — a régua de progresso do curso.

NÃO entra na escolha das palavras: os 20 cards de uma dose continuam saindo da
frequência dentro do próprio vídeo (`frequency.py`). Aqui só se responde "essa
palavra é de que nível?", para o aluno saber onde está e quanto falta.

Fonte: `data/topik_ko.json`, união de duas listas públicas —
  • 국립국어원 «한국어 학습용 어휘 목록» (초급 / 중급 / 고급)
  • «TOPIK 어휘 목록» de 2015 (등급 A / B / C)
Quando as duas discordam, vale a mais básica: errar para o lado de "isso é
básico" é melhor do que dizer que o aluno já está num nível que não alcançou.

Três faixas, alinhadas com o TOPIK e com o CEFR que o app já usa:
  A → TOPIK I  (1–2급) ≈ A1–A2
  B → TOPIK II (3–4급) ≈ B1–B2
  C → TOPIK II (5–6급) ≈ C1–C2
"""
from __future__ import annotations

import functools
import json
import os

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))

# rótulo → (faixa, nome PT, TOPIK, CEFR)
TIERS = {
    "A": ("Básico", "TOPIK I · 1–2급", "A1–A2"),
    "B": ("Intermediário", "TOPIK II · 3–4급", "B1–B2"),
    "C": ("Avançado", "TOPIK II · 5–6급", "C1–C2"),
}
_NIKL_TO_TIER = {"초급": "A", "중급": "B", "고급": "C"}


# Japonês: JLPT por lema UniDic (data/jlpt_ja.json, listas de Jonathan Waller / tanos,
# via open-anki-jlpt-decks). N5 e N4 são a base do aluno (sem card, fora da escada);
# a escada usa as letras como chave: A = N3, B = N2, C = N1.
_JLPT_TO_TIER = {"N3": "A", "N2": "B", "N1": "C"}


@functools.lru_cache(maxsize=2)
def _jlpt(lang: str) -> dict[str, str]:
    path = os.path.join(DATA, f"jlpt_{lang}.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


def exam_level(lemma: str, lang: str) -> str | None:
    """Nível de exame da palavra ("N3"…), só onde há tabela por nível (japonês)."""
    return _jlpt(lang).get(lemma)


@functools.lru_cache(maxsize=4)
def _table(lang: str) -> dict[str, dict]:
    path = os.path.join(DATA, f"topik_{lang}.json")
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        return json.load(fh)


@functools.lru_cache(maxsize=4)
def tier_map(lang: str) -> dict[str, str]:
    """lema -> 'A' | 'B' | 'C'. A união das duas listas, pela mais básica."""
    if _jlpt(lang):
        return {lm: _JLPT_TO_TIER[lv] for lm, lv in _jlpt(lang).items() if lv in _JLPT_TO_TIER}
    out: dict[str, str] = {}
    for word, v in _table(lang).items():
        tiers = {t for t in (v.get("topik"), _NIKL_TO_TIER.get(v.get("nikl", ""))) if t}
        if tiers:
            out[word] = min(tiers)  # 'A' < 'B' < 'C'
    return out


def level_of(lemma: str, lang: str = "ko") -> str | None:
    return tier_map(lang).get(lemma)


@functools.lru_cache(maxsize=4)
def tier_sizes(lang: str) -> dict[str, int]:
    """Quantas palavras existem em cada faixa — o denominador do progresso."""
    sizes = {"A": 0, "B": 0, "C": 0}
    for t in tier_map(lang).values():
        sizes[t] += 1
    return sizes

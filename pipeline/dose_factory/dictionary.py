"""Dicionário das legendas: o significado de QUALQUER palavra da fala, não só dos
20 cards (o "tocar na palavra" do player e o "+ card").

Duas camadas, na ordem em que o app mostra:
  1. data/dict_pt_<lang>.json — significado em PT, curto e no sentido da lição
     (o mesmo estilo dos cards). É curado: nasce dos `meaning` dos words.json e
     das traduções feitas para o glossário de cada lição. Só ele vira card.
  2. data/dict_en_<lang>.json — reserva em inglês, gerada de dicionários abertos:
       ja → JMdict (EDRDG, CC BY-SA 4.0), por kanji e por leitura
       ko → Wiktionary via kaikki.org (CC BY-SA)
     Nenhum dos dois tem português; a palavra sem PT aparece com o inglês marcado
     "EN" — melhor que nada ao tocar na legenda, mas não vira card.

  python -m dose_factory dict --lang ja --src JMdict_e.gz
  python -m dose_factory dict --lang ko --src kaikki.org-dictionary-Korean.jsonl
"""
from __future__ import annotations

import functools
import gzip
import json
import os
import re

from .frequency import DATA

_MAX_GLOSSES = 3


def _save(path: str, data: dict) -> None:
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(data, fh, ensure_ascii=False, separators=(",", ":"), sort_keys=True)


def _wanted(lang: str) -> set[str]:
    """Só o que pode aparecer numa lição: lemas da lista de frequência (e compostos),
    mais os níveis do exame. Mantém o arquivo em poucos MB."""
    from .frequency import build_lemma_freq, _luw
    words = set(build_lemma_freq(lang))
    if lang == "ja":
        words |= set(_luw())
        path = os.path.join(DATA, "jlpt_ja.json")
    else:
        path = os.path.join(DATA, "topik_ko.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            raw = json.load(fh)
        words |= set(raw.get("levels", raw) if isinstance(raw, dict) else raw)
    return words


def build_en_ja(src: str) -> int:
    """JMdict_e(.gz) → {grafia: "gloss; gloss"} por kanji (keb) e por kana (reb)."""
    import xml.etree.ElementTree as ET
    wanted = _wanted("ja")
    opener = gzip.open if src.endswith(".gz") else open
    out: dict[str, str] = {}
    readings: dict[str, str] = {}
    with opener(src, "rb") as fh:
        for _ev, el in ET.iterparse(fh):
            if el.tag != "entry":
                continue
            kebs = [k.text for k in el.iter("keb") if k.text]
            rebs = [r.text for r in el.iter("reb") if r.text]
            glosses = []
            for sense in el.iter("sense"):
                gl = [g.text for g in sense.iter("gloss") if g.text]
                if gl:
                    glosses.append(", ".join(gl[:2]))
                if len(glosses) >= _MAX_GLOSSES:
                    break
            el.clear()
            if not glosses:
                continue
            text = "; ".join(glosses)
            keys = kebs or rebs
            if not any(k in wanted for k in kebs + rebs):
                continue
            for k in keys:
                out.setdefault(k, text)  # a 1ª entrada é a mais comum
            if kebs:  # kana só como reserva: 奇麗 → きれい também acha
                for r in rebs:
                    out.setdefault(r, text)
                for k in kebs:  # leitura de composto: o UniDic não faz rendaku (金曜日)
                    if len(k) > 1:
                        readings.setdefault(k, rebs[0] if rebs else "")
    _save(os.path.join(DATA, "dict_en_ja.json"), out)
    _save(os.path.join(DATA, "reading_ja.json"), {k: v for k, v in readings.items() if v})
    return len(out)


_KO_POS = {"noun", "verb", "adj", "adv", "num", "pron", "intj"}


def build_en_ko(src: str) -> int:
    """kaikki.org (Wiktionary) Korean JSONL → {palavra: "gloss; gloss"}."""
    wanted = _wanted("ko")
    out: dict[str, str] = {}
    with open(src, encoding="utf-8") as fh:
        for line in fh:
            e = json.loads(line)
            word = e.get("word")
            if not word or word not in wanted or e.get("pos") not in _KO_POS:
                continue
            glosses = []
            for s in e.get("senses", []):
                if "form-of" in s.get("tags", []):
                    continue
                g = (s.get("glosses") or [None])[0]
                if g:
                    glosses.append(re.sub(r"\s+", " ", g))
                if len(glosses) >= _MAX_GLOSSES:
                    break
            if glosses and word not in out:
                out[word] = "; ".join(glosses)
    _save(os.path.join(DATA, "dict_en_ko.json"), out)
    return len(out)


@functools.lru_cache(maxsize=4)
def _load(name: str) -> dict:
    path = os.path.join(DATA, name)
    if not os.path.isfile(path):
        return {}
    with open(path, encoding="utf-8") as fh:
        data = json.load(fh)
    return data.get("words", data)


def reading_ja(word: str) -> str | None:
    """Leitura (hiragana) de uma grafia pelo JMdict — só palavras de 2+ caracteres."""
    return _load("reading_ja.json").get(word) or None


def meaning_pt(lemma: str, lang: str) -> str | None:
    return _load(f"dict_pt_{lang}.json").get(lemma) or None


def meaning_en(lemma: str, lang: str, display: str | None = None, reading: str | None = None) -> str | None:
    d = _load(f"dict_en_{lang}.json")
    for k in (display, lemma, reading):
        if k and d.get(k):
            return d[k]
    return None


def save_pt(lang: str, words: dict[str, str]) -> int:
    """Acrescenta/atualiza significados PT (lema → texto) em dict_pt_<lang>.json."""
    path = os.path.join(DATA, f"dict_pt_{lang}.json")
    cur = {}
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            cur = json.load(fh).get("words", {})
    n = 0
    for k, v in words.items():
        if v and cur.get(k) != v:
            cur[k] = v
            n += 1
    with open(path, "w", encoding="utf-8") as fh:
        json.dump({"_doc": "Significado PT por lema (curto, no sentido da lição). Curado à mão; "
                           "ver dose_factory/dictionary.py.", "words": dict(sorted(cur.items()))},
                  fh, ensure_ascii=False, indent=0)
    _load.cache_clear()
    return n

"""Enriquece as doses publicadas, em ordem de lição, sem remontar a mídia principal.

  python -m dose_factory enrich --lang ja            (todas as lições do idioma)
  python -m dose_factory enrich --lang ko --only ko-A1-05

Por dose (idempotente; roda de novo depois de regerar uma lição ou mexer nas listas):
  • segments[].tokens  — refeitos: nomes próprios fora, compostos de unidade longa
                          juntos (飛行機), `base: true` na base do aluno.
  • cards[].homophones — japonês: outras palavras frequentes com a mesma pronúncia
                          (使用 · 仕様); o card mostra a escrita na frente.
  • glossary[]          — o dicionário da legenda: TODA palavra de conteúdo da fala
                          (fora os cards da dose), com significado PT (dict_pt) ou,
                          na falta, EN (dict_en). A palavra nova com PT ganha material
                          de card (TTS + fragmento da frase + cena): é o "+ card".
  • sentenceCards[]     — até 5 frases i+1: todas as palavras já conhecidas antes da
                          lição, menos UMA — que é card desta dose. Card de escuta
                          (frente = áudio da frase; verso = texto + tradução).
  • media.condensedSrc  — "áudio condensado": só as falas, sem os silêncios e as
                          partes sem legenda, para ouvir de novo (e offline).
  • cenas (frames) de todos os cards.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess

from .build_local import _cut_fragment, segment_tokens
from .frequency import (
    KNOWN_BASE, content_tokens, homophones, is_base, is_loanword, lemma_rank,
    _ja_display,
)
from .levels import level_of
from .dictionary import meaning_en, meaning_pt, reading_ja

MAX_SENTENCE_CARDS = 5
_SENT_MIN, _SENT_MAX = 6, 40          # caracteres visíveis
CONDENSED_PAD_BEFORE, CONDENSED_PAD_AFTER = 150, 350  # ms em volta de cada fala
CONDENSED_MERGE_GAP = 700             # falas mais próximas que isso viram um trecho só


def _visible_len(text: str) -> int:
    return len(text.replace(" ", ""))


def _doses(content_root: str, lang: str) -> list[str]:
    course = os.path.join(content_root, lang, "course.json")
    with open(course, encoding="utf-8") as fh:
        refs = sorted(json.load(fh)["doses"], key=lambda r: (r["level"], r["lessonNumber"]))
    return [os.path.join(content_root, lang, r["path"]) for r in refs]


# ---- glossário ----------------------------------------------------------------

def _spellings(dose: dict, lang: str) -> dict[str, dict]:
    """lema → {display, reading, tag, segs:[índices]} a partir das falas da dose."""
    out: dict[str, dict] = {}
    spell: dict[str, dict[tuple, int]] = {}
    dict_spell: dict[str, dict[tuple, int]] = {}
    for k, seg in enumerate(dose["segments"]):
        for t in content_tokens(seg["target"], lang, dictionary=True):
            e = out.setdefault(t["lemma"], {"tag": t["tag"], "segs": [], "surfaces": {}, "dict": True})
            e["dict"] = e["dict"] and bool(t.get("dict"))  # palavra de card em alguma fala → card
            if t.get("proper"):
                e["proper"] = t["proper"]
            if not e["segs"] or e["segs"][-1] != k:
                e["segs"].append(k)
            e["surfaces"][k] = t["surface"]
            if lang == "ja" and "display" in t:
                # grafia/leitura das ocorrências de dicionário só valem se a palavra
                # não aparece de outro jeito (日 como sufixo, か, não muda o ひ de 日)
                sp = (dict_spell if t.get("dict") else spell).setdefault(t["lemma"], {})
                key = (t["display"], t["reading"], t["kana"])
                sp[key] = sp.get(key, 0) + 1
    for lm, sp in dict_spell.items():
        spell.setdefault(lm, sp)
    for lm, e in out.items():
        if lang == "ja" and lm in spell:
            e["display"], e["reading"] = _ja_display(lm, e["tag"], spell[lm])
        else:
            e["display"], e["reading"] = lm, None
    return out


def _best_segment(dose: dict, segs: list[int]) -> int:
    """A fala mais curta e clara (com tradução) entre as que têm a palavra."""
    def key(k: int):
        s = dose["segments"][k]
        n = _visible_len(s["target"])
        return (0 if s.get("translation") else 1, 0 if 5 <= n <= 42 else 1, n, k)
    return min(segs, key=key)


def _tts(text: str, lang: str, dose_dir: str, key: str) -> str | None:
    from .tts import VOICES, tts_filename
    import asyncio
    import edge_tts
    fn = tts_filename(key)
    out_dir = os.path.join(dose_dir, "media", "tts")
    os.makedirs(out_dir, exist_ok=True)
    path = os.path.join(out_dir, fn)
    if not os.path.isfile(path) or os.path.getsize(path) == 0:
        try:
            asyncio.run(edge_tts.Communicate(text, VOICES.get(lang, "en-US-AriaNeural")).save(path))
        except Exception as err:  # sem rede: o card fica sem TTS (o app toca o fragmento)
            print(f"    ⚠ TTS falhou para {text}: {err}")
            return None
    return f"media/tts/{fn}"


_JA_READING_FIX = {"私": "わたし", "日本": "にほん", "清水": "きよみず", "日": "ひ", "三": "さん", "一": "いち", "二": "に"}


def build_glossary(dose: dict, lang: str, dose_dir: str, media: str,
                   card_home: dict[str, str]) -> tuple[list[dict], list[str]]:
    """Glossário da dose + lemas novos sem significado PT (a traduzir). `card_home`:
    lema → dose em que ele é card; essas palavras não ganham "+ card" aqui (o card
    já existe ou vem na lição dela) — o app mostra "card da lição N"."""
    card_lemmas = {c["id"][2:] for c in dose["cards"] if c["id"].startswith("w-")}
    loanwords = KNOWN_BASE.get(lang, {}).get("loanwords")
    out, missing = [], []
    for lemma, e in sorted(_spellings(dose, lang).items(), key=lambda kv: kv[1]["segs"][0]):
        if lemma in card_lemmas:
            continue
        base = is_base(lemma, lang)
        pt = meaning_pt(lemma, lang)
        entry = {"lemma": lemma, "target": e["display"], "reading": e["reading"],
                 "meaning": pt, "meaningEn": None if pt else meaning_en(lemma, lang, e["display"], e["reading"]),
                 "freqRank": lemma_rank(lemma, lang), "topikLevel": level_of(lemma, lang)}
        if base:
            entry["base"] = True
        if lemma in card_home:
            entry["cardIn"] = card_home[lemma]
        katakana_only = loanwords and is_loanword(e["display"] or "")
        if e.get("dict"):
            entry["dict"] = True  # palavra funcional: dicionário sim, "+ card" não
            # leitura: a do uso comum, não a forma-base do UniDic (日本 = にほん, não
            # ニッポン; 私 = わたし, não わたくし) — correções à mão, depois o JMdict
            if lang == "ja" and entry["reading"]:
                entry["reading"] = (_JA_READING_FIX.get(entry["target"]) or reading_ja(entry["target"])
                                    or entry["reading"])
            if not entry["meaning"] and not entry["meaningEn"] and e.get("proper"):
                entry["meaning"] = {"person": "nome de pessoa", "place": "nome de lugar"}.get(
                    e["proper"], "nome próprio")
        elif not base and not katakana_only and lemma not in card_home:
            if not pt:
                missing.append(lemma)
            else:
                k = _best_segment(dose, e["segs"])
                seg = dose["segments"][k]
                surface = e["surfaces"].get(k) or e["display"]
                cid = f"w-{lemma}"
                entry["card"] = {
                    "id": cid, "segmentId": seg["id"], "target": e["display"], "translation": pt,
                    "startMs": seg["startMs"], "endMs": seg["endMs"], "reading": e["reading"],
                    "context": f"{seg['target']} — {seg.get('translation') or ''}".strip(" —"),
                    "audioClipSrc": _tts(e["display"], lang, dose_dir, lemma),
                    "exampleAudioSrc": _cut_fragment(media, seg["startMs"], seg["endMs"], dose_dir, cid),
                    "freqRank": entry["freqRank"], "topikLevel": entry["topikLevel"],
                    "newWords": [surface] if surface != e["display"] else [],
                    "homophones": homophones(lemma, lang, None) or None,
                }
        out.append(entry)
    return out, missing


# ---- cards de frase i+1 -------------------------------------------------------

def build_sentence_cards(dose: dict, lang: str, known_before: set[str], dose_dir: str,
                         media: str) -> list[dict]:
    cards = {c["id"][2:]: c for c in dose["cards"] if c["id"].startswith("w-")}
    cand = []
    for seg in dose["segments"]:
        toks = seg.get("tokens") or []
        if not toks or not seg.get("translation"):
            continue
        n = _visible_len(seg["target"])
        if not (_SENT_MIN <= n <= _SENT_MAX):
            continue
        unknown = {t["lemma"] for t in toks
                   if not t.get("base") and not t.get("dict") and t["lemma"] not in known_before}
        if len(unknown) != 1:
            continue
        focus = next(iter(unknown))
        card = cards.get(focus)
        if not card:
            continue
        # a própria frase-exemplo do card não conta: ela já está no verso dele
        if seg["startMs"] < card["endMs"] and card["startMs"] < seg["endMs"]:
            continue
        tok = next(t for t in toks if t["lemma"] == focus)
        cand.append((-len(toks), abs(n - 16), seg, focus, tok, card))
    cand.sort(key=lambda c: (c[0], c[1], c[2]["startMs"]))
    out, used_focus, used_text = [], set(), set()
    for _a, _b, seg, focus, tok, card in cand:
        if focus in used_focus or seg["target"] in used_text:
            continue
        cid = "s-" + hashlib.md5(f"{seg['target']}|{focus}".encode("utf-8")).hexdigest()[:10]
        frag = _cut_fragment(media, seg["startMs"], seg["endMs"], dose_dir, cid)
        out.append({
            "id": cid, "kind": "sentence", "segmentId": seg["id"], "target": seg["target"],
            "translation": seg["translation"], "startMs": seg["startMs"], "endMs": seg["endMs"],
            "audioClipSrc": frag, "exampleAudioSrc": frag, "freqRank": card.get("freqRank"),
            "topikLevel": card.get("topikLevel"),
            "focus": {"lemma": focus, "target": card["target"], "meaning": card.get("translation"),
                      "reading": card.get("reading"), "start": tok["start"], "end": tok["end"]},
        })
        used_focus.add(focus)
        used_text.add(seg["target"])
        if len(out) >= MAX_SENTENCE_CARDS:
            break
    return out


# ---- áudio condensado ---------------------------------------------------------

def build_condensed(dose: dict, dose_dir: str, media: str) -> tuple[str | None, list[list[int]]]:
    """Só as falas, emendadas. Devolve (src, mapa) — mapa = [[inícioCondensado,
    inícioOriginal, duração], …] em ms, para o app achar a legenda de cada instante."""
    spans = []
    for s in dose["segments"]:
        a = max(0, s["startMs"] - CONDENSED_PAD_BEFORE)
        b = s["endMs"] + CONDENSED_PAD_AFTER
        if spans and a - spans[-1][1] <= CONDENSED_MERGE_GAP:
            spans[-1][1] = max(spans[-1][1], b)
        else:
            spans.append([a, b])
    if not spans:
        return None, []
    dur_ms = int(dose["media"]["durationSec"] * 1000)
    spans = [[a, min(b, dur_ms)] for a, b in spans if a < dur_ms]
    expr = "+".join(f"between(t,{a / 1000:.3f},{b / 1000:.3f})" for a, b in spans)
    out_rel = "media/condensed.mp3"
    out = os.path.join(dose_dir, out_rel)
    script = os.path.join(dose_dir, "media", ".condense.filter")
    with open(script, "w") as fh:
        fh.write(f"aselect='{expr}',asetpts=N/SR/TB")
    try:
        subprocess.run(["ffmpeg", "-loglevel", "error", "-y", "-i", media,
                        "-filter_script:a", script, "-vn", "-ac", "1", "-b:a", "56k",
                        "-c:a", "libmp3lame", out], check=True)
    except subprocess.CalledProcessError as err:
        print(f"    ⚠ áudio condensado falhou: {err}")
        return None, []
    finally:
        os.remove(script)
    cmap, t = [], 0
    for a, b in spans:
        cmap.append([t, a, b - a])
        t += b - a
    return out_rel, cmap


# ---- orquestração -------------------------------------------------------------

def enrich_language(content_root: str, lang: str, only: set[str] | None = None,
                    condensed: bool = True) -> dict[str, list[str]]:
    """Enriquece as doses do idioma em ordem. Devolve {doseId: lemas sem PT}."""
    from .frames import add_frames, update_course_posters
    known_before: set[str] = set()   # cards das lições anteriores
    card_home: dict[str, str] = {}   # lema → dose em que é card
    for path in _doses(content_root, lang):
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        for c in d["cards"]:
            if c["id"].startswith("w-"):
                card_home.setdefault(c["id"][2:], d["id"])
    missing_all: dict[str, list[str]] = {}
    for path in _doses(content_root, lang):
        with open(path, encoding="utf-8") as fh:
            dose = json.load(fh)
        dose_dir = os.path.dirname(path)
        media = os.path.join(dose_dir, dose["media"]["src"])
        lessons_cards = {c["id"][2:] for c in dose["cards"] if c["id"].startswith("w-")}
        if only and dose["id"] not in only:
            known_before |= lessons_cards
            continue
        print(f"{dose['id']}:")
        for seg in dose["segments"]:
            seg["tokens"] = segment_tokens(seg["target"], lang)
        for c in dose["cards"]:
            if c["id"].startswith("w-"):
                h = homophones(c["id"][2:], lang)
                if h:
                    c["homophones"] = h
                else:
                    c.pop("homophones", None)
        gl, missing = build_glossary(dose, lang, dose_dir, media, card_home)
        dose["glossary"] = gl
        missing_all[dose["id"]] = missing
        dose["sentenceCards"] = build_sentence_cards(dose, lang, known_before, dose_dir, media)
        if condensed and os.path.isfile(media):
            src, cmap = build_condensed(dose, dose_dir, media)
            dose["media"]["condensedAudioSrc"] = src
            dose["media"]["condensedMap"] = cmap
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(dose, fh, ensure_ascii=False, indent=2)
        add_frames(path)
        addable = sum(1 for g in gl if g.get("card"))
        cond = dose["media"].get("condensedMap") or []
        cond_min = (cond[-1][0] + cond[-1][2]) / 60000 if cond else 0
        print(f"  glossário {len(gl)} palavras ({addable} com '+ card', {len(missing)} sem PT) · "
              f"{len(dose['sentenceCards'])} cards de frase · condensado {cond_min:.1f} min "
              f"de {dose['media']['durationSec'] / 60:.1f}")
        known_before |= lessons_cards
    update_course_posters(content_root, lang)
    return missing_all


def refresh_glossary(content_root: str, lang: str) -> dict[str, list[str]]:
    """Só tokens + glossário das doses publicadas — sem mexer em cards de frase,
    áudio condensado e cenas. É o que se roda quando muda o que a legenda conta
    como palavra (lições já estudadas continuam iguais no SRS)."""
    card_home: dict[str, str] = {}
    paths = _doses(content_root, lang)
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            d = json.load(fh)
        for c in d["cards"]:
            if c["id"].startswith("w-"):
                card_home.setdefault(c["id"][2:], d["id"])
    missing_all: dict[str, list[str]] = {}
    for path in paths:
        with open(path, encoding="utf-8") as fh:
            dose = json.load(fh)
        dose_dir = os.path.dirname(path)
        media = os.path.join(dose_dir, dose["media"]["src"])
        for seg in dose["segments"]:
            seg["tokens"] = segment_tokens(seg["target"], lang)
        # a cena do "+ card" vem do passo de frames, que aqui não roda: preserva
        scenes = {g["card"]["id"]: g["card"].get("sceneSrc") for g in dose.get("glossary") or []
                  if g.get("card") and g["card"].get("sceneSrc")}
        gl, missing = build_glossary(dose, lang, dose_dir, media, card_home)
        for g in gl:
            if g.get("card") and g["card"]["id"] in scenes:
                g["card"]["sceneSrc"] = scenes[g["card"]["id"]]
        dose["glossary"] = gl
        missing_all[dose["id"]] = missing
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(dose, fh, ensure_ascii=False, indent=2)
        n_dict = sum(1 for g in gl if g.get("dict"))
        print(f"{dose['id']}: glossário {len(gl)} palavras ({n_dict} só de dicionário, {len(missing)} sem PT)")
    return missing_all

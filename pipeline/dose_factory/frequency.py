"""Frequency-based vocabulary selection.

Picks the N highest-frequency *content words* (dictionary form / lemma) that occur
in a dose, ranked by a lemma frequency derived from a real corpus frequency list
(OpenSubtitles / OPUS — hermitdave FrequencyWords). Korean is lemmatized with
kiwipiepy, Japanese with fugashi (MeCab/UniDic). Words already taught in earlier
lessons are excluded, so each lesson teaches fresh vocabulary (i+1).

The frequency source is a plain ranked word list at data/freq_raw_<lang>.txt and is
swappable (e.g. for a government/NIKL list) without touching the app.
"""
from __future__ import annotations

import functools
import json
import os

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))

# Korean content POS (Sejong tags): common/proper noun, verb, adjective, adverb.
_KO_CONTENT = {"NNG", "NNP", "VV", "VA", "MAG"}
# Japanese content POS (UniDic pos1).
_JA_CONTENT = {"名詞", "動詞", "形容詞", "副詞"}
# High-frequency but low-value-as-a-card lemmas to skip.
_STOP_KO = {"것", "거", "수", "때", "등", "중", "분", "데", "게", "이거", "저거", "그거",
            "쪽", "님", "씨", "저희", "우리", "여기", "거기", "저기", "번", "개", "명"}
_STOP_JA = {"の", "こと", "これ", "それ", "の様", "さん", "君", "私", "僕", "事", "物",
            "為", "様", "方", "人", "とき", "ところ"}


@functools.lru_cache(maxsize=1)
def _kiwi():
    from kiwipiepy import Kiwi
    return Kiwi()


@functools.lru_cache(maxsize=1)
def _ja_tagger():
    import fugashi
    return fugashi.Tagger()


def _ko_lemma(form: str, tag: str) -> str | None:
    if tag in ("VV", "VA"):
        return form + "다"  # dictionary form of verbs/adjectives
    if tag in ("NNG", "NNP", "MAG"):
        return form
    return None


def content_tokens(text: str, lang: str) -> list[dict]:
    """Content words of `text` with their position: [{lemma, surface, tag, start, end}].
    `start`/`end` are character offsets into `text` ([start, end)) — the span the
    app underlines in the subtitle (legenda "conhecido/novo") and that the SRS card
    highlights in the example sentence. `lemma` is the dictionary form, i.e. the
    same string the card id carries (`w-<lemma>`), so app-side the token ↔ card
    join is a string compare."""
    out: list[dict] = []
    if lang == "ko":
        toks = _kiwi().tokenize(text)
        skip = -1
        for k, t in enumerate(toks):
            if k == skip:
                continue
            # kiwi marks irregular stems VV-I / VA-I / VV-R … — same part of speech.
            base = t.tag.split("-")[0]
            lm, tag, end = _ko_lemma(t.form, base), base, t.start + t.len
            # A base noun + derivational suffix is ONE word: 손+님 -> 손님,
            # 말+하 -> 말하다. Teaching the base alone would be a wrong card.
            nxt = toks[k + 1] if k + 1 < len(toks) else None
            if lm and base in ("NNG", "NNP") and nxt is not None:
                if nxt.tag == "XSN":
                    lm, skip, end = t.form + nxt.form, k + 1, nxt.start + nxt.len
                elif nxt.tag.split("-")[0] in ("XSV", "XSA"):
                    lm, tag, skip = t.form + nxt.form + "다", "VV", k + 1
                    end = nxt.start + nxt.len
            if base in _KO_CONTENT and lm and lm not in _STOP_KO:
                # real inflected surface as it appears (e.g. 하 -> 해, 오 -> 왔)
                surface = text[t.start:end] or t.form
                out.append({"lemma": lm, "surface": surface, "tag": tag,
                            "start": t.start, "end": t.start + len(surface)})
    else:  # ja
        cursor = 0  # fugashi has no offsets: walk the text along the surfaces
        for w in _ja_tagger()(text):
            pos = w.feature.pos1
            at = text.find(w.surface, cursor)
            if at < 0:
                at = cursor
            cursor = at + len(w.surface)
            if pos in _JA_CONTENT:
                lemma = (w.feature.lemma or w.surface).split("-")[0]
                if not lemma or lemma in _STOP_JA:
                    continue
                if any(ch.isdigit() for ch in lemma):
                    continue
                out.append({"lemma": lemma, "surface": w.surface, "tag": pos,
                            "start": at, "end": cursor})
    return out


def content_lemmas(text: str, lang: str) -> list[tuple[str, str, str]]:
    """Return [(lemma, surface, tag)] for content words in `text`."""
    return [(t["lemma"], t["surface"], t["tag"]) for t in content_tokens(text, lang)]


def build_lemma_freq(lang: str, top_raw: int = 25000) -> dict[str, int]:
    """Derive a lemma->count map by lemmatizing the raw surface frequency list.
    Cached to data/lemma_freq_<lang>.json."""
    cache = os.path.join(DATA, f"lemma_freq_{lang}.json")
    if os.path.isfile(cache):
        with open(cache, encoding="utf-8") as fh:
            return json.load(fh)
    raw = os.path.join(DATA, f"freq_raw_{lang}.txt")
    freq: dict[str, int] = {}
    with open(raw, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if i >= top_raw:
                break
            parts = line.split()
            if len(parts) < 2:
                continue
            word = parts[0]
            try:
                cnt = int(parts[1])
            except ValueError:
                continue
            for lm, _s, _t in content_lemmas(word, lang):
                freq[lm] = freq.get(lm, 0) + cnt
    os.makedirs(DATA, exist_ok=True)
    with open(cache, "w", encoding="utf-8") as fh:
        json.dump(freq, fh, ensure_ascii=False)
    return freq


@functools.lru_cache(maxsize=4)
def rank_map(lang: str) -> dict[str, int]:
    """lemma -> rank (1 = most frequent) within the language's content-word freq list."""
    freq = build_lemma_freq(lang)
    ordered = sorted(freq.items(), key=lambda kv: -kv[1])
    return {lm: i + 1 for i, (lm, _c) in enumerate(ordered)}


def analyze(sentences: list[dict], lang: str) -> dict[int, list[tuple[str, str, str]]]:
    """Tokenize every sentence once: {sentence i -> [(lemma, surface, tag)]}."""
    return {s["i"]: content_lemmas(s["text"], lang) for s in sentences}


def video_words(sentences: list[dict], lang: str,
                analysis: dict[int, list] | None = None) -> list[dict]:
    """One entry per unique content lemma, at its first occurrence in the dose."""
    analysis = analysis or analyze(sentences, lang)
    seen: dict[str, dict] = {}
    for s in sentences:
        for lm, surf, tag in analysis[s["i"]]:
            if lm not in seen:
                seen[lm] = {"lemma": lm, "surface": surf, "tag": tag,
                            "sentenceIndex": s["i"]}
    return list(seen.values())


# Example-sentence length band (visible chars, spaces excluded): short & clear.
_EX_MIN, _EX_MAX = 5, 42


def best_example(lemma: str, sentences: list[dict], lang: str,
                 analysis: dict[int, list] | None = None) -> dict | None:
    """Pick the shortest clear sentence that contains `lemma` (so the SRS audio
    fragment is a tight example, not a huge run-on). Returns {sentenceIndex, surface}."""
    analysis = analysis or analyze(sentences, lang)
    by_i = {s["i"]: s for s in sentences}
    hits: list[tuple[int, int, str]] = []
    for i, lems in analysis.items():
        surf = next((su for lm, su, _t in lems if lm == lemma), None)
        if surf is None:
            continue
        length = len(by_i[i]["text"].replace(" ", ""))
        hits.append((i, length, surf))
    if not hits:
        return None
    band = [h for h in hits if _EX_MIN <= h[1] <= _EX_MAX]
    pool = band if band else hits
    pool.sort(key=lambda h: (h[1], h[0]))  # shortest, then earliest
    return {"sentenceIndex": pool[0][0], "surface": pool[0][2]}


def select_frequency_words(
    sentences: list[dict], lang: str, used: set[str], n: int = 20,
    analysis: dict[int, list] | None = None,
) -> list[dict]:
    """Top-n most frequent content lemmas in the dose that are in the frequency
    list and not already taught, each with its best (shortest clear) example
    sentence. Sorted most-frequent first."""
    analysis = analysis or analyze(sentences, lang)
    freq = build_lemma_freq(lang)
    cand = [w for w in video_words(sentences, lang, analysis)
            if w["lemma"] in freq and w["lemma"] not in used]
    cand.sort(key=lambda w: -freq[w["lemma"]])
    top = cand[:n]
    for w in top:
        ex = best_example(w["lemma"], sentences, lang, analysis)
        if ex:
            w["sentenceIndex"] = ex["sentenceIndex"]
            w["surface"] = ex["surface"]
    return top

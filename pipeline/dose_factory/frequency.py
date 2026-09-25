"""Frequency-based vocabulary selection.

Picks the N highest-frequency *content words* (dictionary form / lemma) that occur
in a dose, ranked by a lemma frequency list of the language. Korean is lemmatized
with kiwipiepy, Japanese with fugashi (MeCab/UniDic). Words already taught in
earlier lessons are excluded, so each lesson teaches fresh vocabulary (i+1).

Sources (swappable without touching the app):
  ko → data/freq_raw_ko.txt, a surface list (OpenSubtitles / OPUS, hermitdave)
       lemmatized word by word into data/lemma_freq_ko.json.
  ja → data/freq_bccwj_ja.tsv, NINJAL's BCCWJ 短単位語彙表 — already by UniDic
       lemma (the same string fugashi returns), ranked by the colloquial registers
       (Yahoo!知恵袋 + Yahoo!ブログ). The OpenSubtitles surface list was useless for
       Japanese: no spaces to split on, so 見る landed at #990 behind 捜査 and 殺人.

KNOWN_BASE: what the learner already knows — whole exam levels (JLPT N5+N4 for
Japanese) plus the N most frequent words of the language that NO exam level claims.
A frequent word that is N3 or above (状態, 確認, 結果…) is not known: the learner is
in the N4→N3 transition. Loanwords (外来語: カフェ, チケット) also count as known —
too easy to spend a card on. None of these become cards, and their subtitle tokens
carry `base: true` so the app counts them as known (legenda "conhecido/novo",
compreensão por lição).
"""
from __future__ import annotations

import functools
import json
import os
import re

DATA = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "data"))

# Japonês: o aluno está na transição N4→N3 («base de 1000 palavras») e já fazia
# imersão. A base é N5 + N4 inteiros (便利, 窓, 遠い ficam depois do #1000 do corpus).
# O top-1000 só completa com palavras que NENHUM nível do JLPT reivindica (楽しむ,
# 彼氏, 多く): 355 das 1000 mais frequentes são N3/N2/N1 (状態, 確認, 情報, 結果) e
# eram contadas como conhecidas por engano — são justamente as que o aluno precisa.
# `loanwords`: 外来語 (カフェ, チケット) não vira card, é fácil demais; conta como base.
# Coreano começa do zero (lições A0), então não tem base.
# `declared`: palavras N3+ que o aluno marcou como já conhecidas (data/known_ja.json,
# lista de 2026-09-24 sobre as 243 do top-1000 que faltavam) — valem mais que o JLPT.
# O coreano começa do zero: a base é só o que o aluno marcar «Já sei» no app
# (exportado em Ajustes e importado com `dose_factory known`).
KNOWN_BASE = {"ja": {"top": 1000, "jlpt": ("N5", "N4"), "loanwords": True,
                     "declared": "known_ja.json"},
              "ko": {"declared": "known_ko.json"}}

# Korean content POS (Sejong tags): common noun, verb, adjective, adverb. Nome
# próprio (NNP: 윤지, 부산, 서울) não é vocabulário: não vira card nem token — senão
# um nome dito 70 vezes derrubava a "compreensão por lição" e o i+1.
_KO_CONTENT = {"NNG", "VV", "VA", "MAG"}
# Japanese content POS (UniDic pos1). 形状詞 = adjetivo-na (綺麗, 静か, 大丈夫).
_JA_CONTENT = {"名詞", "動詞", "形容詞", "副詞", "形状詞"}
# Nome próprio, numeral e 名詞-助動詞語幹 (そう/よう) não viram card nem token.
_JA_SKIP_POS2 = {"固有名詞", "数詞", "助動詞語幹"}
_JA_HONORIFIC = {"お", "ご", "御"}
_HANGUL_RE = re.compile(r"[가-힣]")
_JA_SCRIPT = re.compile(r"[\u3040-\u30ff\u4e00-\u9fff々]")
# High-frequency but low-value-as-a-card lemmas to skip.
_STOP_KO = {"것", "거", "수", "때", "등", "중", "분", "데", "게", "이거", "저거", "그거",
            "쪽", "님", "씨", "저희", "우리", "여기", "거기", "저기", "번", "개", "명"}
_STOP_JA = {"の", "こと", "これ", "それ", "の様", "さん", "君", "私", "僕", "事", "物",
            "為", "様", "方", "人", "とき", "ところ",
            # pedaços que o UniDic corta de palavras maiores: バイ(バイ), 小学(生),
            # 同(業種), 一生(懸命), (五十一)日間, 一時 (= «uma hora» do relógio),
            # (お)婆(ちゃん), より (advérbio-partícula); 詰まる vem de つまんない
            # (つまらない), e o card diria «entupir»
            "バイ", "小学", "同", "一生", "日間", "一時", "婆", "より", "詰まる",
            "振り",  # 振り: プリ(クラ) lido como ふり
            # (おじい)ちゃん, (くるりん)ぱ, デイ(キャンプ), (よーい)始め, 入り, a marca アサヒ;
            # 仲 sozinho repete 仲良く
            # (a lista compara o LEMA UniDic: じい = 爺, デイ = デー, アサヒ = 朝日, ぱ = ぱっ)
            "爺", "ぱっ", "デー", "始め", "入り", "朝日", "仲",
            # N3 frequentes que só aparecem como pedaço: (お)願い(します), (かも)しれない,
            # 実(は), 久し(ぶり), ところ = 所, a interjeição まあ, ごめん (dia 1); sufixos
            # e prefixos de composto: 飛行機, 後頭部, キャンプ地, 初(泊まり), 10年間,
            # (と)共(に); 仕様 = «しょう» (volitivo) mal cortado
            "所", "願う", "知れる", "実", "久しい", "まあ", "御免",
            "機", "部", "地", "初", "年間", "共", "仕様",
            # pedaços de palavra que o UniDic solta: (とんでも)ない, (す)ごい, もじゃ(もじゃ)
            "とんでも", "ごい", "もじゃ",
            # e leituras erradas de pedaço: (注文し)ま(す) → 縞, (お)子さん, 違(くね),
            # (あ)ざす, (カサん)だら, 細見(え)
            "縞", "子さん", "違", "ざす", "陀羅", "細見",
            # interjeição que o UniDic lê como advérbio; (ペッ)ツ
            "ああ", "ぺっ"}
# Dicionário da legenda (`content_tokens(..., dictionary=True)`): QUALQUER palavra
# da fala abre o dicionário ao toque, não só as que podem virar card. As que não
# podem (人, 私, この, はい, 日本, nomes, números, prefixos/sufixos; no coreano 저,
# 그리고, 뭐, 시, 개, 이다) saem com `dict: True`: clicáveis, mas fora da
# compreensão, das marcas e do Prime (o app não as conta). Só partícula, auxiliar
# e pontuação ficam de fora.
_JA_NON_WORD = {"助詞", "助動詞", "補助記号", "記号", "空白"}

# Verbo cujo lema UniDic é uma forma antiga: o card mostra a forma de hoje.
_JA_DISPLAY = {"感ずる": ("感じる", "かんじる")}


@functools.lru_cache(maxsize=1)
def _kiwi():
    from kiwipiepy import Kiwi
    return Kiwi()


@functools.lru_cache(maxsize=1)
def _ja_tagger():
    import fugashi
    return fugashi.Tagger()


# Durante a reconstrução da lista coreana: o conjunto de palavras conhecidas vem
# da lista ANTERIOR + TOPIK. Sem isso, a lista (que usa o analisador) e o
# analisador (que consulta a lista em `_ko_word_exists`) se chamam em círculo.
_KO_BOOTSTRAP: frozenset[str] | None = None


def _ko_known_words() -> frozenset[str]:
    return _KO_BOOTSTRAP if _KO_BOOTSTRAP is not None else _ko_known_words_cached()


@functools.lru_cache(maxsize=1)
def _ko_known_words_cached() -> frozenset[str]:
    words = set(build_lemma_freq("ko"))
    path = os.path.join(DATA, "topik_ko.json")
    if os.path.isfile(path):
        with open(path, encoding="utf-8") as fh:
            words |= set(json.load(fh))
    return frozenset(words)


def _ko_word_exists(lemma: str) -> bool:
    return lemma in _ko_known_words()


def _ko_lemma(form: str, tag: str) -> str | None:
    if tag in ("VV", "VA"):
        return form + "다"  # dictionary form of verbs/adjectives
    if tag in ("NNG", "MAG"):
        return form
    return None


def content_tokens(text: str, lang: str, dictionary: bool = False) -> list[dict]:
    """Content words of `text` with their position: [{lemma, surface, tag, start, end}].
    `dictionary=True` (só a legenda) acrescenta, com `dict: True`, as palavras que
    não podem virar card mas precisam abrir o dicionário (ver `_JA_NON_WORD`).
    A escolha de cards nunca usa esse modo.
    `start`/`end` are character offsets into `text` ([start, end)) — the span the
    app underlines in the subtitle (legenda "conhecido/novo") and that the SRS card
    highlights in the example sentence. `lemma` is the dictionary form, i.e. the
    same string the card id carries (`w-<lemma>`), so app-side the token ↔ card
    join is a string compare."""
    out: list[dict] = []
    names = _names(lang)
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
            if lm and base == "NNG" and nxt is not None:
                # plural -들 (인형들) não forma palavra nova: fica o substantivo
                if nxt.tag == "XSN" and nxt.form != "들":
                    lm, skip, end = t.form + nxt.form, k + 1, nxt.start + nxt.len
                elif nxt.tag.split("-")[0] in ("XSV", "XSA") and _ko_word_exists(t.form + nxt.form + "다"):
                    # só quando o verbo existe: 강아지하고 (= com o cachorro) o kiwi lê
                    # como 강아지+하+고, e 강아지하다 não é palavra
                    lm, tag, skip = t.form + nxt.form + "다", "VV", k + 1
                    end = nxt.start + nxt.len
            if base in _KO_CONTENT and lm and lm not in _STOP_KO and lm not in names:
                # real inflected surface as it appears (e.g. 하 -> 해, 오 -> 왔)
                surface = text[t.start:end] or t.form
                out.append({"lemma": lm, "surface": surface, "tag": tag,
                            "start": t.start, "end": t.start + len(surface)})
            elif dictionary and base[0] not in "JESXUW":  # partícula, terminação, sufixo, símbolo
                word = lm or (t.form + "다" if base.startswith("V") else t.form)
                if not word or not _HANGUL_RE.search(word):
                    continue
                surface = text[t.start:end] or t.form
                tok = {"lemma": word, "surface": surface, "tag": base, "dict": True,
                       "start": t.start, "end": t.start + len(surface)}
                if base == "NNP" or word in names:
                    tok["proper"] = "name"
                out.append(tok)
    else:  # ja
        cursor = 0  # fugashi has no offsets: walk the text along the surfaces
        morphs = []
        for w in _ja_tagger()(text):
            at = text.find(w.surface, cursor)
            if at < 0:
                at = cursor
            cursor = at + len(w.surface)
            f = w.feature
            morphs.append({"surface": w.surface, "start": at, "end": cursor, "pos1": f.pos1,
                           "pos2": f.pos2, "pos3": f.pos3, "lemma": (f.lemma or w.surface).split("-")[0],
                           "orthBase": f.orthBase, "kana": f.kana or "", "kanaBase": f.kanaBase or ""})
        prev_pos, prev_surf = None, ""
        for m in _merge_long_units(morphs, text):
            pos = m["pos1"]
            # depois de prefixo (新|幹線, 不|動産) a palavra é metade de um composto: o
            # card ensinaria um pedaço. Prefixo honorífico (お土産, ご飯) não conta.
            in_compound = prev_pos == "接頭辞" and prev_surf not in _JA_HONORIFIC
            prev_pos, prev_surf = pos, m["surface"]
            lemma = m["lemma"]
            if not lemma:
                continue
            card_word = (not in_compound and pos in _JA_CONTENT and m["pos2"] not in _JA_SKIP_POS2
                         and lemma not in _STOP_JA and lemma not in names
                         and not any(ch.isdigit() for ch in lemma)
                         and bool(_JA_SCRIPT.search(lemma)))  # inglês de abertura não é palavra da lição
            # dicionário: qualquer outra palavra escrita em japonês ("10", "you" não)
            dict_word = (dictionary and not card_word and pos not in _JA_NON_WORD
                         and bool(_JA_SCRIPT.search(m["surface"])))
            if not (card_word or dict_word):
                continue
            # O lema UniDic é uma chave, não uma grafia: 綺麗 → 奇麗, やっぱり →
            # 矢張り. Para mostrar no card vale a forma de dicionário na grafia
            # em que a palavra foi dita (orthBase), com a leitura (kanaBase).
            base = m["orthBase"] or lemma
            kana = m["kanaBase"]
            tok = {"lemma": lemma, "surface": m["surface"], "tag": pos,
                   "start": m["start"], "end": m["end"], "kana": kana,
                   "display": base, "reading": _hiragana(kana) if _has_kanji(base) else None}
            if dict_word:
                tok["dict"] = True
                if m["pos2"] == "固有名詞" or lemma in names:
                    tok["proper"] = {"人名": "person", "地名": "place"}.get(m.get("pos3") or "", "name")
            out.append(tok)
    return out


# ---- nomes próprios ----------------------------------------------------------

@functools.lru_cache(maxsize=4)
def _names(lang: str) -> frozenset[str]:
    """Lemas que são nome de pessoa/lugar mas o analisador não marca como nome
    próprio (さやか vira o adjetivo 清か; 몰이, o cachorro das histórias, vira
    NNG). `data/names_<lang>.json` → {"lemmas": [...]}. Não viram token nem card."""
    path = os.path.join(DATA, f"names_{lang}.json")
    if not os.path.isfile(path):
        return frozenset()
    with open(path, encoding="utf-8") as fh:
        return frozenset(json.load(fh)["lemmas"])


# ---- unidades longas (japonês) -----------------------------------------------
# O UniDic corta em unidades CURTAS (短単位): 飛行機 = 飛行|機, 金曜日 = 金曜|日.
# O card saía "飛行" (e o 機 ia para a lista de exclusão). A lista de unidades
# LONGAS do BCCWJ (長単位語彙表, NINJAL) diz quais sequências são uma palavra só;
# juntamos substantivo + substantivo/sufixo (e prefixo não honorífico) quando a
# emenda existe lá com frequência coloquial mínima.
_LUW_MIN_PMW = 0.3      # coloquial (知恵袋 + ブログ), por milhão
_LUW_MAX_PARTS = 4
_LUW_PARTS_POS = {"名詞", "接尾辞", "接頭辞"}
# emendas que a lista longa tem mas que, na fala, são duas palavras (今|自分たち)
_LUW_NEVER = {"今自分"}


@functools.lru_cache(maxsize=1)
def _luw() -> dict[str, tuple[str, float]]:
    """lema do composto → (leitura katakana, pmw coloquial)."""
    path = os.path.join(DATA, "luw_ja.tsv")
    if not os.path.isfile(path):
        return {}
    out = {}
    for ln in open(path, encoding="utf-8"):
        if ln.startswith("#"):
            continue
        lemma, lform, _pos, _f, col = ln.rstrip("\n").split("\t")
        out[lemma] = (lform, float(col))
    extra = os.path.join(DATA, "compounds_ja.json")
    if os.path.isfile(extra):  # compostos declarados à mão: frequência mínima
        with open(extra, encoding="utf-8") as fh:
            for lemma, lform in json.load(fh)["lemmas"].items():
                out.setdefault(lemma, (lform, _LUW_MIN_PMW))
    return out


def _merge_long_units(morphs: list[dict], text: str) -> list[dict]:
    luw = _luw()
    if not luw:
        return morphs
    out, i, n = [], 0, len(morphs)
    while i < n:
        hit = None
        for j in range(min(n, i + _LUW_MAX_PARTS), i + 1, -1):  # o mais longo primeiro
            parts = morphs[i:j]
            if any(p["pos1"] not in _LUW_PARTS_POS or p["pos2"] in ("固有名詞", "数詞") for p in parts):
                continue
            if parts[0]["pos1"] == "接頭辞" and parts[0]["surface"] in _JA_HONORIFIC:
                continue
            if parts[-1]["pos1"] == "接頭辞" or not any(p["pos1"] == "名詞" for p in parts):
                continue
            if any(parts[k]["end"] != parts[k + 1]["start"] for k in range(len(parts) - 1)):
                continue
            joined = "".join(p["surface"] for p in parts)
            entry = luw.get(joined)
            if entry and entry[1] >= _LUW_MIN_PMW and joined not in _LUW_NEVER:
                hit = (j, joined, entry[0])
                break
        if not hit:
            out.append(morphs[i])
            i += 1
            continue
        j, joined, _lform = hit
        parts = morphs[i:j]
        # leitura = a pronúncia de cada parte como foi dita (金曜日 = キンヨウビ, 父さん =
        # トウサン); a forma da lista longa é a de dicionário (キンヨウヒ, チチサン)
        kana = "".join(p["kana"] for p in parts)
        from .dictionary import reading_ja
        jm = reading_ja(joined)
        if jm:
            kana = "".join(chr(ord(c) + 0x60) if "ぁ" <= c <= "ゖ" else c for c in jm)
        out.append({"surface": text[parts[0]["start"]:parts[-1]["end"]], "start": parts[0]["start"],
                    "end": parts[-1]["end"], "pos1": "名詞", "pos2": "普通名詞", "lemma": joined,
                    "orthBase": joined, "kana": kana, "kanaBase": kana})
        i = j
    return out


@functools.lru_cache(maxsize=1)
def _suw_colloquial() -> list[float]:
    """pmw coloquial de cada rank da lista curta (decrescente) — para dar ao composto
    o rank que ele teria se estivesse nela."""
    path = os.path.join(DATA, "freq_bccwj_ja.tsv")
    return [float(ln.split("\t")[4]) for ln in open(path, encoding="utf-8") if not ln.startswith("#")]


def _compound_rank(lemma: str) -> int | None:
    entry = _luw().get(lemma)
    if not entry:
        return None
    import bisect
    col = _suw_colloquial()
    # lista decrescente: quantas palavras simples são mais frequentes que o composto
    neg = [-c for c in col]
    return bisect.bisect_left(neg, -entry[1]) + 1


# ---- homófonos (japonês) -----------------------------------------------------
_HOMOPHONE_MAX_RANK = 10000


@functools.lru_cache(maxsize=1)
def _by_reading() -> dict[str, list[tuple[int, str]]]:
    path = os.path.join(DATA, "freq_bccwj_ja.tsv")
    out: dict[str, list[tuple[int, str]]] = {}
    for ln in open(path, encoding="utf-8"):
        if ln.startswith("#"):
            continue
        r = ln.split("\t")
        rank = int(r[0])
        if rank > _HOMOPHONE_MAX_RANK:
            continue
        out.setdefault(r[2], []).append((rank, r[1]))
    return out


def homophones(lemma: str, lang: str, reading_kata: str | None = None, limit: int = 3) -> list[str]:
    """Outras palavras frequentes com a MESMA pronúncia (使用 · 仕様 · 私用). Card cuja
    frente é só áudio fica ambíguo para elas — o app mostra a escrita junto."""
    if lang != "ja":
        return []
    lform = reading_kata or _ja_lform().get(lemma) or (_luw().get(lemma) or ("",))[0]
    if not lform:
        return []
    others = [lm for _r, lm in sorted(_by_reading().get(lform, [])) if lm != lemma
              and not is_loanword(lm) and _has_kanji(lm)]
    return others[:limit]


# ---- escolha dos 20 cards -----------------------------------------------------
# A lista de frequência do idioma diz o quanto a palavra vale EM GERAL; as
# ocorrências no vídeo dizem o quanto ela vale PARA ESTA LIÇÃO (entender o vídeo
# e ouvir a palavra de novo em outro contexto). Só a lista escolhia 状態 (dito uma
# vez) e deixava 充電 (dito 20 vezes) de fora. Nota = −ln(rank) + VIDEO_WEIGHT ·
# ln(falas em que aparece): dobrar as ocorrências compensa um rank ~1,8× pior; uma
# palavra dita em 10 falas empata com uma 10× mais frequente dita uma vez.
# Palavra dita numa fala só entra só se faltarem candidatas com 2 ou mais — e
# a prioridade das repetidas vale só até RARE_RANK: palavra rara no idioma (紅芋,
# #40000) disputa pela nota com as demais, por mais que o vídeo a repita.
VIDEO_WEIGHT = 0.85
MIN_OCCURRENCES = 2
RARE_RANK = 12000


def card_score(rank: int, occurrences: int) -> float:
    import math
    return -math.log(max(rank, 1)) + VIDEO_WEIGHT * math.log(max(occurrences, 1))


def _has_kanji(s: str) -> bool:
    return any("一" <= ch <= "鿿" or ch == "々" for ch in s)


def _hiragana(kata: str) -> str:
    return "".join(chr(ord(ch) - 0x60) if "ァ" <= ch <= "ヶ" else ch for ch in kata)


def known_rank(lang: str) -> int:
    """Até que rank o aluno já sabe (0 = nenhum)."""
    return KNOWN_BASE.get(lang, {}).get("top", 0)


_KATAKANA_WORD = re.compile(r"^[\u30a0-\u30ffー]+$")


def is_loanword(lemma: str) -> bool:
    """外来語? O lema UniDic de um estrangeirismo é sempre em katakana (カフェ-cafe →
    カフェ); palavra nativa escrita em katakana tem lema em kanji/hiragana (ネコ → 猫,
    マジ → まじ), então continua podendo virar card."""
    return bool(_KATAKANA_WORD.match(lemma))


@functools.lru_cache(maxsize=4)
def _declared(lang: str) -> frozenset[str]:
    """Lemas que o aluno declarou saber (KNOWN_BASE[lang]["declared"])."""
    name = KNOWN_BASE.get(lang, {}).get("declared")
    if not name:
        return frozenset()
    with open(os.path.join(DATA, name), encoding="utf-8") as fh:
        return frozenset(json.load(fh)["lemmas"])


def is_base(lemma: str, lang: str) -> bool:
    """A palavra está na base que o aluno declarou saber?"""
    base = KNOWN_BASE.get(lang)
    if not base:
        return False
    if base.get("loanwords") and is_loanword(lemma):
        return True
    if lemma in _declared(lang):
        return True
    if base.get("jlpt"):
        from .levels import exam_level
        level = exam_level(lemma, lang)
        if level:  # o JLPT manda: N3 frequente não é base
            return level in base["jlpt"]
    r = lemma_rank(lemma, lang)
    return bool(r and r <= base.get("top", 0))


def content_lemmas(text: str, lang: str) -> list[tuple[str, str, str]]:
    """Return [(lemma, surface, tag)] for content words in `text`."""
    return [(t["lemma"], t["surface"], t["tag"]) for t in content_tokens(text, lang)]


# Coreano: a lista é de FORMAS soltas (sem frase em volta), e algumas contrações
# frequentes o kiwi lê, sozinhas, como outro substantivo: 날 é quase sempre 나를
# ("me", não "dia"), 걸 = 것을, 거지 = 것이지 ("né?", não "mendigo"), 수도 =
# -ㄹ 수도 ("pode ser que", não "capital"). Lidas assim, 날/거지/수도 entravam
# no top-110 do idioma e virariam card com o sentido errado.
# 볼 (보다, "vou ver") virava 볼 "bochecha"; -라고/-라는 (citação) virava o nome 라.
_KO_SURFACE_FIX = {"날": "나를", "걸": "것을", "거지": "것이지", "수도": "수 도",
                   "건": "것은", "게": "것이", "뭘": "뭐를", "걸로": "것으로",
                   "그걸로": "그것으로", "이걸로": "이것으로", "볼": "볼게",
                   "라고": "", "라는": "", "라": "", "라고요": ""}


def build_lemma_freq(lang: str, top_raw: int | None = None, rebuild: bool = False) -> dict[str, int]:
    """Derive a lemma->count map by lemmatizing the raw surface frequency list.
    Cached to data/lemma_freq_<lang>.json. Japanese reads the BCCWJ lemma list
    directly (already lemmatized, file order = rank)."""
    bccwj = os.path.join(DATA, f"freq_bccwj_{lang}.tsv")
    if os.path.isfile(bccwj):
        return _bccwj_freq(bccwj)
    cache = os.path.join(DATA, f"lemma_freq_{lang}.json")
    previous: dict[str, int] = {}
    if os.path.isfile(cache):
        with open(cache, encoding="utf-8") as fh:
            previous = json.load(fh)
        if not rebuild:
            return previous
    if lang == "ko":
        return _rebuild_ko(cache, previous, top_raw)
    raw = os.path.join(DATA, f"freq_raw_{lang}.txt")
    freq: dict[str, int] = {}
    with open(raw, encoding="utf-8") as fh:
        for i, line in enumerate(fh):
            if top_raw is not None and i >= top_raw:
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


def _rebuild_ko(cache: str, previous: dict[str, int], top_raw: int | None) -> dict[str, int]:
    """Refaz data/lemma_freq_ko.json com o analisador ATUAL (python -m dose_factory
    freqlist --lang ko). Rode sempre que mudar a lematização coreana — senão a
    lista fica com lemas que o analisador não produz mais (사람들 separado de 사람)."""
    global _KO_BOOTSTRAP
    known = set(previous)
    topik = os.path.join(DATA, "topik_ko.json")
    if os.path.isfile(topik):
        with open(topik, encoding="utf-8") as fh:
            raw_t = json.load(fh)
        known |= set(raw_t.get("levels", raw_t) if isinstance(raw_t, dict) else raw_t)
    _KO_BOOTSTRAP = frozenset(known)
    freq: dict[str, int] = {}
    try:
        with open(os.path.join(DATA, "freq_raw_ko.txt"), encoding="utf-8") as fh:
            for i, line in enumerate(fh):
                if top_raw is not None and i >= top_raw:
                    break
                parts = line.split()
                if len(parts) < 2 or not parts[1].isdigit():
                    continue
                word = _KO_SURFACE_FIX.get(parts[0], parts[0])
                for lm, _s, _t in content_lemmas(word, "ko"):
                    freq[lm] = freq.get(lm, 0) + int(parts[1])
    finally:
        _KO_BOOTSTRAP = None
    with open(cache, "w", encoding="utf-8") as fh:
        json.dump(freq, fh, ensure_ascii=False)
    _ko_known_words_cached.cache_clear()
    rank_map.cache_clear()
    return freq


@functools.lru_cache(maxsize=1)
def _ja_lform() -> dict[str, str]:
    """lema UniDic → leitura do lema (katakana), da lista BCCWJ."""
    path = os.path.join(DATA, "freq_bccwj_ja.tsv")
    if not os.path.isfile(path):
        return {}
    rows = (ln.split("\t") for ln in open(path, encoding="utf-8") if not ln.startswith("#"))
    return {r[1]: r[2] for r in rows}


def _ja_display(lemma: str, tag: str, spellings: dict[tuple, int]) -> tuple[str, str | None]:
    """Grafia do card: a forma de dicionário mais usada no vídeo cuja leitura é a
    do lema (綺麗 para o lema 奇麗). Verbo sem nenhuma que bata foi dito numa
    forma derivada (喋れる, potencial de 喋る) → vale o lema. Advérbio coloquial
    (やっぱり, lema 矢張り) fica com a grafia falada."""
    if lemma in _JA_DISPLAY:
        return _JA_DISPLAY[lemma]
    lform = _ja_lform().get(lemma)
    ranked = sorted(spellings.items(), key=lambda kv: -kv[1])
    for (disp, reading, kana), _n in ranked:
        if lform and kana == lform:
            return disp, reading
    if tag == "動詞" and lform:
        return lemma, (_hiragana(lform) if _has_kanji(lemma) else None)
    (disp, reading, _kana), _n = ranked[0]
    return disp, reading


@functools.lru_cache(maxsize=2)
def _bccwj_freq(path: str) -> dict[str, int]:
    """lemma -> pseudo-count that preserves the file's order (rank 1 = maior)."""
    rows = [ln.split("\t") for ln in open(path, encoding="utf-8") if not ln.startswith("#")]
    n = len(rows)
    return {r[1]: n - k for k, r in enumerate(rows)}


@functools.lru_cache(maxsize=4)
def rank_map(lang: str) -> dict[str, int]:
    """lemma -> rank (1 = most frequent) within the language's content-word freq list."""
    freq = build_lemma_freq(lang)
    ordered = sorted(freq.items(), key=lambda kv: -kv[1])
    return {lm: i + 1 for i, (lm, _c) in enumerate(ordered)}


def lemma_rank(lemma: str, lang: str) -> int | None:
    """Rank na lista de frequência do idioma. Composto de unidade longa (飛行機) não
    está na lista curta: ganha o rank que a sua frequência coloquial teria nela."""
    r = rank_map(lang).get(lemma)
    if r is None and lang == "ja":
        r = _compound_rank(lemma)
    return r


def analyze(sentences: list[dict], lang: str) -> dict[int, list[tuple[str, str, str]]]:
    """Tokenize every sentence once: {sentence i -> [(lemma, surface, tag)]}."""
    return {s["i"]: content_lemmas(s["text"], lang) for s in sentences}


def video_words(sentences: list[dict], lang: str,
                analysis: dict[int, list] | None = None) -> list[dict]:
    """One entry per unique content lemma, at its first occurrence in the dose.
    Japanese entries also carry `display`/`reading`: the most common dictionary-form
    spelling the video actually used (綺麗, not the UniDic key 奇麗)."""
    analysis = analysis or analyze(sentences, lang)
    seen: dict[str, dict] = {}
    spellings: dict[str, dict[tuple, int]] = {}
    for s in sentences:
        for lm, surf, tag in analysis[s["i"]]:
            if lm not in seen:
                seen[lm] = {"lemma": lm, "surface": surf, "tag": tag,
                            "sentenceIndex": s["i"]}
        if lang == "ja":
            for t in content_tokens(s["text"], lang):
                sp = spellings.setdefault(t["lemma"], {})
                key = (t["display"], t["reading"], t["kana"])
                sp[key] = sp.get(key, 0) + 1
    for lm, sp in spellings.items():
        if lm in seen:
            seen[lm]["display"], seen[lm]["reading"] = _ja_display(lm, seen[lm]["tag"], sp)
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


def occurrences(lemma: str, analysis: dict[int, list]) -> int:
    """Em quantas frases do vídeo a palavra aparece (repetir na mesma frase não conta)."""
    return sum(1 for lems in analysis.values() if any(lm == lemma for lm, _s, _t in lems))


def select_frequency_words(
    sentences: list[dict], lang: str, used: set[str], n: int = 20,
    analysis: dict[int, list] | None = None,
) -> list[dict]:
    """Os n melhores lemas de conteúdo da dose pela nota `card_score` (frequência no
    idioma × ocorrências no vídeo), fora os já ensinados e a base que o aluno já
    sabe (KNOWN_BASE), cada um com a sua frase-exemplo mais curta e clara. O vídeo
    define o conjunto de candidatas; a lista de frequência continua sendo o peso
    principal. Palavra dita numa fala só entra só quando faltam candidatas com
    MIN_OCCURRENCES ou mais. Ordenadas pela nota."""
    analysis = analysis or analyze(sentences, lang)
    # a base que o aluno já sabe (KNOWN_BASE) nunca vira card
    # nem palavra que o card mostraria em katakana (マジ, コショウ): o aluno pediu
    # cards sem katakana, e as nativas escritas assim são gíria/grafia fácil
    cand = []
    from .levels import level_of
    for w in video_words(sentences, lang, analysis):
        rank = lemma_rank(w["lemma"], lang)
        # Fora da lista mas no TOPIK/JLPT (귤, 김밥, 외국어: a lista coreana é de
        # legenda de filme e não tem comida nem escola): candidata com peso de rara
        # — só entra se o vídeo repetir ou se faltar palavra. Antes era descartada.
        if rank is None and level_of(w["lemma"], lang):
            rank = RARE_RANK + 1
        if rank is None or w["lemma"] in used or is_base(w["lemma"], lang):
            continue
        if KNOWN_BASE.get(lang, {}).get("loanwords") and is_loanword(w.get("display") or ""):
            continue
        w["rank"] = rank
        w["occurrences"] = occurrences(w["lemma"], analysis)
        w["score"] = card_score(rank, w["occurrences"])
        cand.append(w)
    cand.sort(key=lambda w: (-w["score"], w["rank"]))
    first = lambda w: w["occurrences"] >= MIN_OCCURRENCES and w["rank"] <= RARE_RANK  # noqa: E731
    top = [w for w in cand if first(w)][:n]
    if len(top) < n:  # faltou: completa com as demais, pela mesma nota
        top += [w for w in cand if not first(w)][: n - len(top)]
    top.sort(key=lambda w: (-w["score"], w["rank"]))
    for w in top:
        ex = best_example(w["lemma"], sentences, lang, analysis)
        if ex:
            w["sentenceIndex"] = ex["sentenceIndex"]
            w["surface"] = ex["surface"]
    return top

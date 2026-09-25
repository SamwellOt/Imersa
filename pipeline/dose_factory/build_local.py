"""Assemble a dose.json from local artifacts.

Two entry points:
  * build_dose            — from media + SRTs (+ optional Scribe JSON). Used by the
                            demo and the URL pipeline.
  * build_dose_from_scribe — from media + a Scribe JSON + a per-sentence PT
                            translation list (+ optional prime ranges). Used for
                            languages without a bunsetsu-style SRT step (e.g. Korean).
No network / API key needed here.
"""
from __future__ import annotations

import hashlib
import json
import os
import re
import shutil
import subprocess
from datetime import datetime, timezone
from typing import Optional

from . import srt as srtlib
from .course import update_course
from .frequency import content_tokens, is_base
from .schema import (
    Difficulty, Dose, Media, PrimeChunk, SentenceCard, Segment, Source, SourcePart,
    validate,
)

CHUNK_TARGET_SENTENCES = 7
PRIME_MAX_CHARS = 190
DEFAULT_MAX_CARDS = 50
_VIDEO_EXT = (".mp4", ".mkv", ".webm", ".mov")

# Backchannels / interjections that make poor standalone SRS cards.
_FILLERS = {
    "네", "예", "응", "어", "음", "아", "오", "와", "우와", "대박", "짠", "허", "하", "흠",
    "야", "자", "맞아", "맞아요", "맞습니다", "맞죠", "그렇죠", "그쵸", "그래", "그래요",
    "그니까요", "그러네", "좋아", "좋아요", "좋습니다", "오케이", "오키", "노", "네네네",
    "진짜", "진짜요", "뭐", "뭔데", "왜요", "왜", "아니", "아니요", "아니에요", "응응",
    "그래?", "그럼", "예예", "음음",
}
# Essential set-phrases worth keeping even though short.
_ESSENTIAL = {
    "안녕하세요", "감사합니다", "감사해요", "안녕히 계세요", "잘 먹었습니다",
    "반가웠어요", "안녕", "죄송합니다", "괜찮아요",
}
_NUM_CHARS = set("영일이삼사오육칠팔구십백천만 점0123456789.,")
_COUNT_RE = re.compile(r"^(하나|둘|셋|넷)([,\s]+(하나|둘|셋|넷))*$")


def _norm(text: str) -> str:
    return text.strip().strip(".!?…~ ").strip()


def segment_tokens(text: str, lang: str) -> list[dict]:
    """`Segment.tokens`: só o que o app usa (lema + posição); `tag` fica de fora.
    `base: true` = palavra da base que o aluno já sabe (KNOWN_TOP): o app a conta
    como conhecida sem precisar de card."""
    out = []
    for t in content_tokens(text, lang, dictionary=True):
        tok = {"lemma": t["lemma"], "surface": t["surface"], "start": t["start"], "end": t["end"]}
        if t.get("dict"):
            # só dicionário: clicável na legenda, fora da compreensão (ver frequency)
            tok["dict"] = True
            if t.get("proper"):
                tok["proper"] = t["proper"]
        elif is_base(t["lemma"], lang):
            tok["base"] = True
        out.append(tok)
    return out


def _is_filler(text: str) -> bool:
    t = _norm(text)
    if not t:
        return True
    if t in _ESSENTIAL:
        return False
    if t in _FILLERS:
        return True
    if _COUNT_RE.match(t):
        return True
    # score-like lines: "오 점", "삼 점", "사 점오 점"
    if "점" in t and all(c in _NUM_CHARS for c in t):
        return True
    return False


def _card_score(text: str) -> int:
    t = _norm(text)
    visible = len(t.replace(" ", ""))
    return visible + (12 if t in _ESSENTIAL else 0)


def select_essential(sentences: list[dict], max_cards: int) -> list[dict]:
    """Pick the <=max_cards most essential sentences, spread across the timeline.

    Drops fillers/echoes/counting, then buckets the timeline into max_cards slots
    and keeps the highest-scoring candidate in each, filling any remainder with the
    next-best leftovers. Result is returned in chronological order.
    """
    cand = [s for s in sentences
            if not _is_filler(s["text"]) and len(s["text"].replace(" ", "")) >= 4]
    if len(cand) <= max_cards:
        return cand
    t0 = sentences[0]["start"]
    t1 = sentences[-1]["end"]
    span = max(1, t1 - t0)
    buckets: list[list[dict]] = [[] for _ in range(max_cards)]
    for s in cand:
        b = min(max_cards - 1, int((s["start"] - t0) / span * max_cards))
        buckets[b].append(s)
    chosen: list[dict] = []
    for b in buckets:
        if b:
            chosen.append(max(b, key=lambda s: _card_score(s["text"])))
    if len(chosen) < max_cards:
        picked = {s["i"] for s in chosen}
        rest = sorted((s for s in cand if s["i"] not in picked),
                      key=lambda s: _card_score(s["text"]), reverse=True)
        for s in rest:
            if len(chosen) >= max_cards:
                break
            chosen.append(s)
    chosen.sort(key=lambda s: s["i"])
    return chosen


def ffprobe_duration(path: str) -> float:
    try:
        out = subprocess.run(
            ["ffprobe", "-v", "error", "-show_entries", "format=duration",
             "-of", "default=noprint_wrappers=1:nokey=1", path],
            capture_output=True, text=True, check=True,
        )
        return float(out.stdout.strip())
    except Exception:
        return 0.0


def _teaser(text: str, max_chars: int = PRIME_MAX_CHARS) -> str:
    text = " ".join(text.split())
    if len(text) <= max_chars:
        return text
    cut = text[:max_chars]
    for sep in ("。", ". ", "! ", "? ", "; ", ", "):
        i = cut.rfind(sep)
        if i > max_chars * 0.5:
            return cut[: i + 1].strip() + " …"
    return cut.rstrip() + " …"


def _cut_fragment(media_path: str, start_ms: int, end_ms: int, dose_dir: str,
                  key: str) -> Optional[str]:
    """Pre-cut the example sentence into a tight mp3 (BACK of the card) so playback
    is exact and instant — no seeking a large video at runtime."""
    pad_before, pad_after = 120, 280  # ms
    ss = max(0, start_ms - pad_before) / 1000.0
    dur = (end_ms - start_ms + pad_before + pad_after) / 1000.0
    if dur <= 0:
        return None
    fn = "f" + hashlib.md5(key.encode("utf-8")).hexdigest()[:12] + ".mp3"
    dst_dir = os.path.join(dose_dir, "media", "frag")
    os.makedirs(dst_dir, exist_ok=True)
    try:
        subprocess.run(
            ["ffmpeg", "-y", "-ss", f"{ss:.3f}", "-i", media_path, "-t", f"{dur:.3f}",
             "-vn", "-ac", "1", "-c:a", "libmp3lame", "-q:a", "5",
             os.path.join(dst_dir, fn)],
            capture_output=True, check=True,
        )
        return f"media/frag/{fn}"
    except Exception:
        return None


def _copy_tts(word: dict, words_path: str, dose_dir: str) -> Optional[str]:
    """Copy a word's TTS clip into the dose's media/tts/ and return its rel path."""
    tf = word.get("ttsFile")
    if not tf:
        return None
    src = os.path.join(os.path.dirname(os.path.abspath(words_path)), "tts", tf)
    if not os.path.isfile(src):
        return None
    dst_dir = os.path.join(dose_dir, "media", "tts")
    os.makedirs(dst_dir, exist_ok=True)
    shutil.copy2(src, os.path.join(dst_dir, tf))
    return f"media/tts/{tf}"


def _place_media(dose_dir: str, media_path: str) -> tuple[str, str, float]:
    """Copy media into the dose's media/ folder. Returns (src_rel, kind, durationSec)."""
    media_dir = os.path.join(dose_dir, "media")
    os.makedirs(media_dir, exist_ok=True)
    ext = os.path.splitext(media_path)[1].lower()
    kind = "video" if ext in _VIDEO_EXT else "audio"
    dst_name = "main" + ext
    shutil.copy2(media_path, os.path.join(media_dir, dst_name))
    return f"media/{dst_name}", kind, ffprobe_duration(media_path)


def _write_and_index(dose: Dose, content_root: str, native_name: str) -> str:
    problems = validate(dose)
    if problems:
        print("  ⚠ validation:", "; ".join(problems))
    dose_dir = os.path.join(content_root, dose.language, "course",
                            f"{dose.level}-{dose.lessonNumber:02d}")
    os.makedirs(dose_dir, exist_ok=True)
    dose_path = os.path.join(dose_dir, "dose.json")
    with open(dose_path, "w", encoding="utf-8") as fh:
        json.dump(dose.to_dict(), fh, ensure_ascii=False, indent=2)
    rel = os.path.relpath(dose_path, os.path.join(content_root, dose.language))
    update_course(content_root, dose, rel.replace(os.sep, "/"),
                  native_name=native_name)
    print(f"  ✓ dose {dose.id}: {len(dose.segments)} segments, {len(dose.cards)} cards, "
          f"{len(dose.primePreview)} prime chunks, {dose.media.durationSec:.0f}s")
    return dose_path


def _dose_dir(content_root: str, language: str, level: str, lesson: int) -> str:
    return os.path.join(content_root, language, "course", f"{level}-{lesson:02d}")


# --------------------------------------------------------------------------- #
# Scribe-based flow (Korean etc.)                                             #
# --------------------------------------------------------------------------- #

def prep_scribe(scribe_json: str, out_stem: str) -> tuple[int, int]:
    """Extract sentence + display units from a Scribe JSON.

    Writes:
      <out_stem>.units.json      — {sentences:[{i,start,end,text,speaker}], display:[...]}
      <out_stem>.sentences.txt   — numbered target-language sentences (to translate)
    Returns (num_sentences, num_display_lines).
    """
    sents = srtlib.sentences_from_scribe(scribe_json)
    disp = srtlib.display_lines_from_scribe(scribe_json)
    units = {
        "sentences": [
            {"i": i + 1, "start": s.start_ms, "end": s.end_ms, "text": s.text, "speaker": s.speaker}
            for i, s in enumerate(sents)
        ],
        "display": [
            {"start": d.start_ms, "end": d.end_ms, "text": d.text, "speaker": d.speaker}
            for d in disp
        ],
    }
    with open(out_stem + ".units.json", "w", encoding="utf-8") as fh:
        json.dump(units, fh, ensure_ascii=False, indent=2)
    with open(out_stem + ".sentences.txt", "w", encoding="utf-8") as fh:
        for u in units["sentences"]:
            fh.write(f'{u["i"]}\t{u["text"]}\n')
    return len(sents), len(disp)


def build_dose_from_scribe(
    *,
    content_root: str,
    media_path: str,
    language: str,
    language_name: str,
    level: str,
    lesson: int,
    title: str,
    synopsis: str,
    units_path: str,
    translations_path: str,
    prime_path: Optional[str] = None,
    words_path: Optional[str] = None,
    title_target: Optional[str] = None,
    premise: Optional[str] = None,
    native_name: str = "",
    source_platform: str = "youtube",
    source_url: Optional[str] = None,
    source_parts: Optional[list[dict]] = None,
    creator: Optional[str] = None,
    cefr: Optional[str] = None,
    hint: Optional[str] = None,
    tags: Optional[list[str]] = None,
    vocab: Optional[list[dict]] = None,
    grammar: Optional[list[str]] = None,
    max_cards: int = DEFAULT_MAX_CARDS,
) -> str:
    with open(units_path, encoding="utf-8") as fh:
        units = json.load(fh)
    with open(translations_path, encoding="utf-8") as fh:
        trans = json.load(fh)  # list[str] aligned to sentences order
    sents = units["sentences"]
    disp = units["display"]
    if len(trans) != len(sents):
        print(f"  ⚠ translations ({len(trans)}) != sentences ({len(sents)}) — aligning by index")

    pt_by_i = {s["i"]: (trans[k] if k < len(trans) else "") for k, s in enumerate(sents)}
    # sentence spans carrying PT, for display-line alignment
    sent_spans = [srtlib.SrtBlock(s["i"], s["start"], s["end"], pt_by_i[s["i"]]) for s in sents]

    segments: list[Segment] = []
    for j, d in enumerate(disp, start=1):
        # linha com tradução própria (legenda por frase/oração — japonês): usa ela;
        # senão, a tradução da frase que mais se sobrepõe no tempo
        tr = d["translation"] if "translation" in d else srtlib.align_translation(d["start"], d["end"], sent_spans)
        segments.append(Segment(
            id=f"s{j}", index=j, startMs=d["start"], endMs=d["end"],
            target=d["text"], translation=tr, speakerId=d.get("speaker"),
            tokens=segment_tokens(d["text"], language),
        ))

    dose_dir = _dose_dir(content_root, language, level, lesson)
    cards: list[SentenceCard] = []
    if words_path and os.path.isfile(words_path):
        # Frequency-word cards: FRONT = the word's TTS clip (audioClipSrc); BACK =
        # the immersion example sentence [startMs,endMs] from the main media.
        with open(words_path, encoding="utf-8") as fh:
            words = json.load(fh)
        by_i = {s["i"]: s for s in sents}
        for w in words:
            ex = by_i.get(int(w["sentenceIndex"]))
            if not ex:
                continue
            ex_pt = pt_by_i.get(ex["i"], "")
            ctx = f"{ex['text']} — {ex_pt}".strip(" —")
            surface = w.get("surface")
            cards.append(SentenceCard(
                id=f"w-{w['lemma']}", segmentId="", target=w.get("display") or w["lemma"],
                translation=w.get("meaning") or "", reading=w.get("reading"),
                startMs=ex["start"], endMs=ex["end"], context=ctx,
                newWords=[surface] if surface and surface != w["lemma"] else [],
                freqRank=w.get("freqRank"),
                topikLevel=w.get("topikLevel"),
                audioClipSrc=_copy_tts(w, words_path, dose_dir),
                exampleAudioSrc=_cut_fragment(media_path, ex["start"], ex["end"],
                                              dose_dir, f"w-{w['lemma']}"),
            ))
    else:
        for s in select_essential(sents, max_cards):
            cards.append(SentenceCard(
                id=f"c{s['i']}", segmentId="", target=s["text"],
                translation=pt_by_i[s["i"]] or "", startMs=s["start"], endMs=s["end"],
                context=premise, audioClipSrc=None,
            ))

    prime: list[PrimeChunk] = []
    if prime_path and os.path.isfile(prime_path):
        with open(prime_path, encoding="utf-8") as fh:
            ranges = json.load(fh)
        by_i = {s["i"]: s for s in sents}
        for k, ch in enumerate(ranges, start=1):
            a = by_i.get(int(ch["from"]))
            b = by_i.get(int(ch["to"]))
            if not a or not b:
                continue
            seg_ids = [sg.id for sg in segments
                       if srtlib.overlap_ms(sg.startMs, sg.endMs, a["start"], b["end"]) > 0]
            prime.append(PrimeChunk(id=f"p{k}", startMs=a["start"], endMs=b["end"],
                                    summary=ch["summary"], segmentIds=seg_ids))

    src_rel, kind, duration = _place_media(dose_dir, media_path)

    dose = Dose(
        id=f"{language}-{level}-{lesson:02d}", language=language, languageName=language_name,
        level=level, lessonNumber=lesson, title=title, titleTarget=title_target,
        synopsis=synopsis, premise=premise,
        source=Source(platform=source_platform, url=source_url, creator=creator,
                      parts=[SourcePart(url=p["url"], startMs=int(p["startMs"]),
                                        title=p.get("title"))
                             for p in (source_parts or [])]),
        media=Media(kind=kind, src=src_rel, durationSec=duration),
        difficulty=Difficulty(cefr=cefr or level, comprehensibilityHint=hint,
                              newVocabCount=len(vocab) if vocab else None),
        segments=segments, cards=cards, primePreview=prime,
        grammarPoints=grammar or [], tags=tags or [],
        createdAt=datetime.now(timezone.utc).isoformat(),
    )
    if vocab:
        from .schema import VocabItem
        dose.vocab = [VocabItem(term=v["term"], meaning=v["meaning"],
                                reading=v.get("reading"), exampleSegmentId=v.get("exampleSegmentId"))
                      for v in vocab]

    return _write_and_index(dose, content_root, native_name)


# --------------------------------------------------------------------------- #
# SRT-based flow (demo / URL pipeline)                                        #
# --------------------------------------------------------------------------- #

def build_dose(
    *,
    content_root: str,
    media_path: str,
    language: str,
    language_name: str,
    level: str,
    lesson: int,
    title: str,
    synopsis: str,
    target_srt: str,
    translation_srt: Optional[str] = None,
    scribe_json: Optional[str] = None,
    title_target: Optional[str] = None,
    premise: Optional[str] = None,
    native_name: str = "",
    source_platform: str = "local",
    source_url: Optional[str] = None,
    creator: Optional[str] = None,
    cefr: Optional[str] = None,
    hint: Optional[str] = None,
    prime_summaries_path: Optional[str] = None,
    words_path: Optional[str] = None,
    tags: Optional[list[str]] = None,
) -> str:
    dose_dir = _dose_dir(content_root, language, level, lesson)
    src_rel, kind, duration = _place_media(dose_dir, media_path)

    target_blocks = srtlib.parse_srt(target_srt)
    trans_blocks = srtlib.parse_srt(translation_srt) if translation_srt else []
    segments: list[Segment] = []
    for i, b in enumerate(target_blocks, start=1):
        tr = srtlib.align_translation(b.start_ms, b.end_ms, trans_blocks) if trans_blocks else None
        segments.append(Segment(id=f"s{i}", index=i, startMs=b.start_ms, endMs=b.end_ms,
                                target=b.text, translation=tr,
                                tokens=segment_tokens(b.text, language)))

    if scribe_json and os.path.isfile(scribe_json):
        sentences = srtlib.sentences_from_scribe(scribe_json)
    else:
        sentences = [srtlib.Sentence(b.start_ms, b.end_ms, b.text, None) for b in target_blocks]
    cards: list[SentenceCard] = []
    if words_path and os.path.isfile(words_path):
        with open(words_path, encoding="utf-8") as fh:
            words = json.load(fh)
        for w in words:
            idx = int(w["sentenceIndex"]) - 1
            if idx < 0 or idx >= len(sentences):
                continue
            ex = sentences[idx]
            ex_pt = srtlib.align_translation(ex.start_ms, ex.end_ms, trans_blocks) if trans_blocks else ""
            surface = w.get("surface")
            cards.append(SentenceCard(
                id=f"w-{w['lemma']}", segmentId="", target=w.get("display") or w["lemma"],
                translation=w.get("meaning") or "", reading=w.get("reading"),
                startMs=ex.start_ms, endMs=ex.end_ms,
                context=f"{ex.text} — {ex_pt}".strip(" —"),
                newWords=[surface] if surface and surface != w["lemma"] else [],
                freqRank=w.get("freqRank"),
                audioClipSrc=_copy_tts(w, words_path, dose_dir),
                exampleAudioSrc=_cut_fragment(media_path, ex.start_ms, ex.end_ms,
                                              dose_dir, f"w-{w['lemma']}")))
    else:
        for i, s in enumerate(sentences, start=1):
            tr = srtlib.align_translation(s.start_ms, s.end_ms, trans_blocks) if trans_blocks else ""
            cards.append(SentenceCard(id=f"c{i}", segmentId="", target=s.text, translation=tr or "",
                                      startMs=s.start_ms, endMs=s.end_ms, context=premise,
                                      audioClipSrc=None))

    prime: list[PrimeChunk] = []
    authored = None
    if prime_summaries_path and os.path.isfile(prime_summaries_path):
        with open(prime_summaries_path, encoding="utf-8") as fh:
            authored = json.load(fh)
    if authored:
        for i, ch in enumerate(authored, start=1):
            prime.append(PrimeChunk(id=f"p{i}", startMs=int(ch["startMs"]), endMs=int(ch["endMs"]),
                                    summary=ch["summary"], segmentIds=ch.get("segmentIds", [])))
    elif trans_blocks:
        for i in range(0, len(sentences), CHUNK_TARGET_SENTENCES):
            grp = sentences[i:i + CHUNK_TARGET_SENTENCES]
            if not grp:
                continue
            start, end = grp[0].start_ms, grp[-1].end_ms
            parts: list[str] = []
            for g in grp:
                t = srtlib.align_translation(g.start_ms, g.end_ms, trans_blocks)
                if t and (not parts or parts[-1] != t):
                    parts.append(t)
            seg_ids = [s.id for s in segments if srtlib.overlap_ms(s.startMs, s.endMs, start, end) > 0]
            prime.append(PrimeChunk(id=f"p{i // CHUNK_TARGET_SENTENCES + 1}", startMs=start,
                                    endMs=end, summary=_teaser(" ".join(parts)), segmentIds=seg_ids))

    dose = Dose(
        id=f"{language}-{level}-{lesson:02d}", language=language, languageName=language_name,
        level=level, lessonNumber=lesson, title=title, titleTarget=title_target,
        synopsis=synopsis, premise=premise,
        source=Source(platform=source_platform, url=source_url, creator=creator),
        media=Media(kind=kind, src=src_rel, durationSec=duration),
        difficulty=Difficulty(cefr=cefr or level, comprehensibilityHint=hint),
        segments=segments, cards=cards, primePreview=prime,
        tags=tags or [], createdAt=datetime.now(timezone.utc).isoformat(),
    )
    return _write_and_index(dose, content_root, native_name)

"""SRT + ElevenLabs Scribe JSON parsing and time-based alignment helpers.

Handles both space-delimited languages (Korean, English, …) and non-spaced ones
(Japanese, Chinese) by honoring Scribe's explicit "spacing" tokens.
"""
from __future__ import annotations

import json
import re
from dataclasses import dataclass

_TIME_RE = re.compile(
    r"(\d{2}):(\d{2}):(\d{2})[,.](\d{3})\s*-->\s*(\d{2}):(\d{2}):(\d{2})[,.](\d{3})"
)

# Sentence-ending punctuation across scripts (CJK + latin).
_SENT_END = set("。．.！？!?…")
# Pause (seconds) between words that forces a sentence break in Scribe JSON.
_PAUSE_BREAK_S = 1.0
# Display-line tuning (short on-screen subtitle lines).
_DISPLAY_MAX_CHARS = 22
_DISPLAY_GAP_S = 0.5


@dataclass
class SrtBlock:
    index: int
    start_ms: int
    end_ms: int
    text: str  # newlines collapsed to spaces


def _to_ms(h: str, m: str, s: str, ms: str) -> int:
    return ((int(h) * 60 + int(m)) * 60 + int(s)) * 1000 + int(ms)


def parse_srt(path: str) -> list[SrtBlock]:
    """Parse an SRT file into blocks. Tolerant of blank lines / CRLF."""
    with open(path, "r", encoding="utf-8-sig") as fh:
        raw = fh.read()
    blocks: list[SrtBlock] = []
    for chunk in re.split(r"\n\s*\n", raw.strip()):
        lines = [ln for ln in chunk.splitlines() if ln.strip() != ""]
        if not lines:
            continue
        idx = 0
        m = _TIME_RE.search(lines[0])
        if m is None and len(lines) > 1:
            idx = 1
            m = _TIME_RE.search(lines[1])
        if m is None:
            continue
        try:
            number = int(lines[0].strip())
        except ValueError:
            number = len(blocks) + 1
        start = _to_ms(*m.group(1, 2, 3, 4))
        end = _to_ms(*m.group(5, 6, 7, 8))
        text = " ".join(ln.strip() for ln in lines[idx + 1:]).strip()
        blocks.append(SrtBlock(number, start, end, text))
    return blocks


@dataclass
class Sentence:
    start_ms: int
    end_ms: int
    text: str
    speaker: str | None


def _load_words(path: str) -> list[dict]:
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh).get("words", [])


def _clean(text: str) -> str:
    return re.sub(r"\s+", " ", text).strip()


def _group_scribe(path: str, *, max_chars: int | None, gap_s: float) -> list[Sentence]:
    """Group Scribe word tokens into units.

    A unit breaks on: sentence-ending punctuation, speaker change, a pause >=
    gap_s, or (when max_chars is set) once the visible length reaches max_chars.
    Spaces come from Scribe's explicit "spacing" tokens, so Korean/English get
    spaces and Japanese/Chinese do not.
    """
    words = _load_words(path)
    out: list[Sentence] = []
    buf: list[str] = []
    start: float | None = None
    end: float | None = None
    spk: str | None = None
    prev_end: float | None = None
    pending_space = False

    def visible_len() -> int:
        return len("".join(buf).replace(" ", ""))

    def flush() -> None:
        nonlocal buf, start, end, spk, pending_space
        text = _clean("".join(buf))
        if text and start is not None and end is not None:
            out.append(Sentence(int(start * 1000), int(end * 1000), text, spk))
        buf = []
        start = end = None
        pending_space = False

    for w in words:
        wt = w.get("type")
        if wt == "spacing":
            if buf:
                pending_space = True
            continue
        if wt not in ("word", "audio_event"):
            continue
        s = w.get("start")
        e = w.get("end")
        if s is None or e is None:
            continue
        if wt == "audio_event":
            flush()
            prev_end = e
            continue
        txt = w.get("text", "")
        sp = w.get("speaker_id")
        # break before adding this word?
        if buf and (
            (spk is not None and sp != spk)
            or (prev_end is not None and (s - prev_end) >= gap_s)
            or (max_chars is not None and visible_len() >= max_chars)
        ):
            flush()
        if start is None:
            start = s
            spk = sp
        if buf and pending_space:
            buf.append(" ")
        buf.append(txt)
        end = e
        prev_end = e
        pending_space = False
        if txt and txt[-1] in _SENT_END:
            flush()
    flush()
    return out


def sentences_from_scribe(path: str) -> list[Sentence]:
    """Sentence-level units (for SRS cards + translation).

    Breaks on sentence-ending punctuation or speaker change; only a long pause
    (>=2.5s) splits, so natural sentences aren't chopped by short reading pauses.
    Consecutive identical sentences (a common slow-teacher repetition) are merged
    into one unit spanning both utterances — one card whose audio repeats.
    """
    raw = _group_scribe(path, max_chars=None, gap_s=2.5)
    merged: list[Sentence] = []
    for s in raw:
        if merged and merged[-1].text == s.text:
            prev = merged[-1]
            merged[-1] = Sentence(prev.start_ms, s.end_ms, s.text, prev.speaker)
        else:
            merged.append(s)
    return merged


def display_lines_from_scribe(path: str) -> list[Sentence]:
    """Short on-screen subtitle lines: break on punctuation, speaker change, a
    >=0.5s pause, or ~22 visible chars."""
    return _group_scribe(path, max_chars=_DISPLAY_MAX_CHARS, gap_s=_DISPLAY_GAP_S)


def overlap_ms(a_start: int, a_end: int, b_start: int, b_end: int) -> int:
    return max(0, min(a_end, b_end) - max(a_start, b_start))


def align_translation(
    target_start: int, target_end: int, translation_blocks: list[SrtBlock]
) -> str | None:
    """Return the translation text whose block overlaps the target span the most."""
    best: SrtBlock | None = None
    best_ov = 0
    for tb in translation_blocks:
        ov = overlap_ms(target_start, target_end, tb.start_ms, tb.end_ms)
        if ov > best_ov:
            best_ov = ov
            best = tb
    return best.text if best is not None else None

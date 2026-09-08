"""Data contract for a Dose. Mirrors web/src/types/dose.ts (schemaVersion 1).

See docs/dose-contract.md. These dataclasses serialize to the exact JSON the
web app consumes. Keep field names in sync with the TypeScript types.
"""
from __future__ import annotations

from dataclasses import dataclass, field, asdict
from typing import Optional

SCHEMA_VERSION = 1


@dataclass
class SourcePart:
    """Um vídeo de origem, na ordem em que aparece no media.src concatenado."""
    url: str
    startMs: int
    title: Optional[str] = None


@dataclass
class Source:
    platform: str = "local"
    url: Optional[str] = None
    creator: Optional[str] = None
    creatorHandle: Optional[str] = None
    parts: list[SourcePart] = field(default_factory=list)


@dataclass
class Media:
    kind: str  # "audio" | "video"
    src: str
    durationSec: float
    condensedAudioSrc: Optional[str] = None
    posterSrc: Optional[str] = None


@dataclass
class Difficulty:
    cefr: Optional[str] = None
    comprehensibilityHint: Optional[str] = None
    newVocabCount: Optional[int] = None


@dataclass
class Segment:
    id: str
    index: int
    startMs: int
    endMs: int
    target: str
    translation: Optional[str] = None
    speakerId: Optional[str] = None
    # Palavras de conteúdo da fala, com posição em `target` e forma de dicionário:
    # [{"lemma": "있다", "surface": "있", "start": 7, "end": 8}]. `lemma` é a mesma
    # string do id do card (`w-<lemma>`) — é por ela que o app pinta a legenda
    # "conhecido/novo" e mede a compreensão da lição. Ver frequency.content_tokens.
    tokens: list[dict] = field(default_factory=list)


@dataclass
class PrimeChunk:
    id: str
    startMs: int
    endMs: int
    summary: str
    segmentIds: list[str] = field(default_factory=list)


@dataclass
class SentenceCard:
    id: str
    segmentId: str
    target: str
    translation: str
    startMs: int
    endMs: int
    reading: Optional[str] = None
    context: Optional[str] = None
    audioClipSrc: Optional[str] = None      # FRONT: word TTS clip
    exampleAudioSrc: Optional[str] = None   # BACK: pre-cut example-sentence fragment
    freqRank: Optional[int] = None          # rank in the language frequency list (1 = top)
    topikLevel: Optional[str] = None        # "A" | "B" | "C" — faixa TOPIK/국립국어원 (ver levels.py)
    imageSrc: Optional[str] = None
    sceneSrc: Optional[str] = None          # quadro do vídeo no momento da frase-exemplo (dose_factory frames)
    newWords: list[str] = field(default_factory=list)


@dataclass
class VocabItem:
    term: str
    meaning: str
    reading: Optional[str] = None
    exampleSegmentId: Optional[str] = None


@dataclass
class Dose:
    id: str
    language: str
    languageName: str
    level: str
    lessonNumber: int
    title: str
    synopsis: str
    media: Media
    segments: list[Segment]
    cards: list[SentenceCard]
    source: Source = field(default_factory=Source)
    difficulty: Difficulty = field(default_factory=Difficulty)
    primePreview: list[PrimeChunk] = field(default_factory=list)
    vocab: list[VocabItem] = field(default_factory=list)
    grammarPoints: list[str] = field(default_factory=list)
    tags: list[str] = field(default_factory=list)
    titleTarget: Optional[str] = None
    premise: Optional[str] = None
    createdAt: str = ""
    schemaVersion: int = SCHEMA_VERSION

    def to_dict(self) -> dict:
        d = asdict(self)
        # Put schemaVersion first for readability; dataclass asdict is fine otherwise.
        return {"schemaVersion": self.schemaVersion, **d}


def validate(dose: Dose) -> list[str]:
    """Lightweight structural validation. Returns a list of problems (empty = ok)."""
    problems: list[str] = []
    if not dose.id:
        problems.append("missing id")
    if not dose.segments:
        problems.append("no segments")
    if dose.media.kind not in ("audio", "video"):
        problems.append(f"bad media.kind: {dose.media.kind}")
    seg_ids = {s.id for s in dose.segments}
    for c in dose.cards:
        if c.segmentId and c.segmentId not in seg_ids:
            # Not fatal (sentence cards may span/merge segments) — warn only.
            pass
    # timeline sanity
    for s in dose.segments:
        if s.endMs < s.startMs:
            problems.append(f"segment {s.id} end<start")
    return problems

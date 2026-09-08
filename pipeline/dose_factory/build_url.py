"""URL -> dose orchestrator. Reuses the dojo skills' deterministic scripts.

Stages:
  1. download        (yt-dlp, mp4/audio)
  2. transcribe      (ElevenLabs Scribe v2 -> <stem>.json)     [needs ELEVENLABS_API_KEY]
  3. target SRT      (dojo srt_watch.py: bunsetsu segmentation)
  4. translation SRT (dojo translate-srt SKILL — LLM; run via the agent, or supply --translation-srt)
  5. prime summaries (dojo primed-summaries SKILL — LLM; optional, supply --prime-summaries)
  6. assemble        (build_local.build_dose)

Steps 4 and 5 are LLM steps in the dojo (they spawn translation/summary passes) and
are NOT pure scripts, so this orchestrator produces the deterministic artifacts
(media + Scribe JSON + target SRT) and then assembles. Provide the translation SRT
(and optional prime summaries JSON) produced by those skills, or run without them
for an immersion-only dose.
"""
from __future__ import annotations

import glob
import os
import subprocess
from typing import Optional

from .build_local import build_dose

DOJO_DIR = os.environ.get(
    "DOJO_DIR",
    os.path.abspath(os.path.join(os.path.dirname(__file__), "../../../immersion/dojo-prompts")),
)


def _run(cmd: list[str]) -> None:
    print("  $", " ".join(cmd))
    subprocess.run(cmd, check=True)


def download(url: str, workdir: str) -> str:
    os.makedirs(workdir, exist_ok=True)
    out_tmpl = os.path.join(workdir, "%(title)s.%(ext)s")
    _run(["yt-dlp", "-f", "bv*[ext=mp4]+ba[ext=m4a]/b[ext=mp4]",
          "--merge-output-format", "mp4", "-o", out_tmpl, url])
    files = sorted(glob.glob(os.path.join(workdir, "*.mp4")),
                   key=os.path.getmtime, reverse=True)
    if not files:
        raise RuntimeError("download produced no mp4")
    return files[0]


def transcribe(media: str) -> str:
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        raise RuntimeError("ELEVENLABS_API_KEY not set — required to transcribe")
    out = os.path.splitext(media)[0] + ".json"
    _run(["curl", "-s", "-X", "POST", "https://api.elevenlabs.io/v1/speech-to-text",
          "-H", f"xi-api-key: {key}", "-F", "model_id=scribe_v2",
          "-F", f"file=@{media}", "-F", "language_code=auto",
          "-F", "timestamps_granularity=word", "-F", "diarize=true", "-o", out])
    return out


def target_srt(scribe_json: str) -> str:
    stem = os.path.splitext(scribe_json)[0]
    script = os.path.join(DOJO_DIR, "scripts", "srt_watch.py")
    _run(["python3", script, "-o", stem, scribe_json])
    return stem + ".srt"


def build_from_url(
    *,
    content_root: str,
    url: str,
    language: str,
    language_name: str,
    level: str,
    lesson: int,
    title: str,
    synopsis: str = "",
    translation_srt: Optional[str] = None,
    prime_summaries: Optional[str] = None,
    workdir: Optional[str] = None,
    **kwargs,
) -> str:
    workdir = workdir or os.path.join(content_root, ".work", f"{language}-{level}-{lesson:02d}")
    print(f"→ download {url}")
    media = download(url, workdir)
    print(f"→ transcribe {os.path.basename(media)}")
    scribe = transcribe(media)
    print("→ target SRT (bunsetsu)")
    tsrt = target_srt(scribe)
    print("→ assemble dose")
    return build_dose(
        content_root=content_root, media_path=media, language=language,
        language_name=language_name, level=level, lesson=lesson, title=title,
        synopsis=synopsis, target_srt=tsrt, translation_srt=translation_srt,
        scribe_json=scribe, prime_summaries_path=prime_summaries,
        source_platform="youtube", source_url=url, **kwargs,
    )

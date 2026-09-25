"""Per-word TTS for the FRONT of SRS cards — native neural voices via edge-tts
(Microsoft Edge online TTS; free, high quality, no API key)."""
from __future__ import annotations

import asyncio
import hashlib
import os

# Native neural voice per language.
VOICES = {
    "ko": "ko-KR-SunHiNeural",
    "ja": "ja-JP-NanamiNeural",
    "en": "en-US-AriaNeural",
    "es": "es-ES-ElviraNeural",
    "fr": "fr-FR-DeniseNeural",
    "de": "de-DE-KatjaNeural",
    "it": "it-IT-ElsaNeural",
    "zh": "zh-CN-XiaoxiaoNeural",
    "pt": "pt-BR-FranciscaNeural",
    "ru": "ru-RU-SvetlanaNeural",
}


def tts_filename(lemma: str) -> str:
    """Stable, ASCII-safe filename for a word's TTS clip."""
    return "w" + hashlib.md5(lemma.encode("utf-8")).hexdigest()[:12] + ".mp3"


def synth_words(words: list[dict], lang: str, out_dir: str, force: bool = False) -> int:
    """Generate an mp3 per word into out_dir; set each word's `ttsFile`.
    Skips words whose clip already exists (unless force). Returns clips created."""
    import edge_tts

    voice = VOICES.get(lang, "en-US-AriaNeural")
    os.makedirs(out_dir, exist_ok=True)

    async def run() -> int:
        made = 0
        for w in words:
            fn = tts_filename(w["lemma"])
            path = os.path.join(out_dir, fn)
            if force or not os.path.isfile(path) or os.path.getsize(path) == 0:
                # japonês: fala a grafia exibida (綺麗), não a chave UniDic (奇麗)
                await edge_tts.Communicate(w.get("display") or w["lemma"], voice).save(path)
                made += 1
            w["ttsFile"] = fn
        return made

    return asyncio.run(run())

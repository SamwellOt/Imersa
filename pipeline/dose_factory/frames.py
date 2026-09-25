"""Quadros do vídeo para a interface: a capa da dose e a cena de cada card.

O app usa o quadro como matéria visual (capa no Hoje e na Biblioteca, cena ao
lado da frase-exemplo no verso do card). Um `ffmpeg -ss` por quadro, JPEG de
480 px, ~10 KB cada. Roda sobre doses já publicadas, sem remontar mídia.
"""
from __future__ import annotations

import hashlib
import json
import os
import subprocess

FRAMES_DIR = "media/frames"
# A capa é tirada um pouco depois da primeira fala com tradução: na abertura
# costuma haver vinheta/título, e o quadro da primeira frase é o que resume a
# história (ex.: a menina na frente da escola em "윤지는 학교에 가요").
POSTER_LEAD_MS = 2500
# A cena de um card sai de dentro da frase-exemplo, um pouco depois do início,
# para o desenho daquela frase já estar na tela.
SCENE_LEAD_MS = 800


def _grab(video: str, ms: int, out: str, width: int = 480) -> bool:
    if os.path.exists(out):
        return True
    cmd = [
        "ffmpeg", "-loglevel", "error", "-y",
        "-ss", f"{max(0, ms) / 1000:.3f}", "-i", video,
        "-frames:v", "1", "-vf", f"scale={width}:-2", "-q:v", "4", out,
    ]
    return subprocess.run(cmd).returncode == 0 and os.path.exists(out)


def _name(prefix: str, ms: int) -> str:
    return f"{prefix}{hashlib.sha1(str(ms).encode()).hexdigest()[:12]}.jpg"


def add_frames(dose_path: str) -> dict | None:
    """Preenche media.posterSrc e cards[].sceneSrc; devolve o dose (dict) ou None se não é vídeo."""
    with open(dose_path, encoding="utf-8") as fh:
        dose = json.load(fh)
    if dose["media"]["kind"] != "video" or not dose["segments"]:
        return None
    folder = os.path.dirname(dose_path)
    video = os.path.join(folder, dose["media"]["src"])
    frames_dir = os.path.join(folder, FRAMES_DIR)
    os.makedirs(frames_dir, exist_ok=True)
    used: set[str] = set()

    first = next((s for s in dose["segments"] if s.get("translation")), dose["segments"][0])
    poster_ms = first["startMs"] + POSTER_LEAD_MS
    poster = _name("p", poster_ms)
    if _grab(video, poster_ms, os.path.join(frames_dir, poster), width=640):
        dose["media"]["posterSrc"] = f"{FRAMES_DIR}/{poster}"
        used.add(poster)

    # cards de palavra, cards de frase (i+1) e os do glossário ("+ card")
    every = list(dose["cards"]) + list(dose.get("sentenceCards") or []) + [
        g["card"] for g in dose.get("glossary") or [] if g.get("card")]
    n = 0
    for card in every:
        dur = max(0, card["endMs"] - card["startMs"])
        ms = card["startMs"] + min(SCENE_LEAD_MS, dur // 2)
        name = _name("s", ms)
        if _grab(video, ms, os.path.join(frames_dir, name)):
            card["sceneSrc"] = f"{FRAMES_DIR}/{name}"
            used.add(name)
            n += 1
    # quadro de um build anterior (outros tempos) que ninguém mais referencia
    stale = [f for f in os.listdir(frames_dir) if f.endswith(".jpg") and f not in used]
    for f in stale:
        os.remove(os.path.join(frames_dir, f))
    with open(dose_path, "w", encoding="utf-8") as fh:
        json.dump(dose, fh, ensure_ascii=False, indent=2)
    print(f"{dose['id']}: capa + {n} cenas" + (f", {len(stale)} quadros velhos removidos" if stale else ""))
    return dose


def update_course_posters(content_root: str, lang: str) -> None:
    """Copia posterSrc (e condensedAudioSrc) de cada dose para o DoseRef do course.json."""
    course_path = os.path.join(content_root, lang, "course.json")
    with open(course_path, encoding="utf-8") as fh:
        course = json.load(fh)
    for ref in course["doses"]:
        p = os.path.join(content_root, lang, ref["path"])
        if not os.path.exists(p):
            continue
        with open(p, encoding="utf-8") as fh:
            media = json.load(fh)["media"]
        if media.get("posterSrc"):
            ref["posterSrc"] = media["posterSrc"]
        # a Biblioteca oferece "ouvir" sem baixar a dose inteira
        if media.get("condensedAudioSrc"):
            ref["condensedAudioSrc"] = media["condensedAudioSrc"]
        else:
            ref.pop("condensedAudioSrc", None)
    with open(course_path, "w", encoding="utf-8") as fh:
        json.dump(course, fh, ensure_ascii=False, indent=2)

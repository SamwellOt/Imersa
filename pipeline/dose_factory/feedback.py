"""Compreensão REAL por lição, vinda do app: as falas que o aluno marcou «não
entendi» (tecla N no player) num backup exportado em Ajustes → Dados.

É o retorno que calibra a escada de dificuldade (`ladder.py --feedback`): a régua
prevê a dificuldade pelo texto; isto diz como a lição foi de fato.
"""
from __future__ import annotations

import json
import os

# Faixas de compreensão (falas entendidas / falas da lição) → passo sugerido na escada
TOO_HARD, COMFORTABLE = 0.80, 0.92


def lesson_feedback(backup_path: str, lang: str, content_root: str) -> list[dict]:
    with open(backup_path, encoding="utf-8") as fh:
        bundle = json.load(fh)
    marks = [m for m in bundle.get("marks") or [] if m.get("language") == lang]
    done = {p["doseId"] for p in bundle.get("doseProgress") or []
            if p.get("language") == lang and p.get("completed")}
    watched: dict[str, float] = {}
    for i in bundle.get("immersion") or []:
        if i.get("language") == lang and i.get("doseId"):
            watched[i["doseId"]] = watched.get(i["doseId"], 0) + i["ms"]
    with open(os.path.join(content_root, lang, "course.json"), encoding="utf-8") as fh:
        refs = json.load(fh)["doses"]
    rows = []
    for ref in sorted(refs, key=lambda r: (r["level"], r["lessonNumber"])):
        if ref["id"] not in done and ref["id"] not in watched:
            continue
        with open(os.path.join(content_root, lang, ref["path"]), encoding="utf-8") as fh:
            n_seg = len(json.load(fh)["segments"])
        unclear = len({m["segmentId"] for m in marks if m["doseId"] == ref["id"]})
        rows.append({"id": ref["id"], "lesson": ref["lessonNumber"], "segments": n_seg,
                     "unclear": unclear, "understood": 1 - unclear / max(n_seg, 1),
                     "minutes": watched.get(ref["id"], 0) / 60000})
    return rows


def step_advice(rows: list[dict]) -> str:
    """Passo sugerido para a próxima lição, pelas 2 últimas estudadas."""
    last = [r for r in rows if r["minutes"] >= 5][-2:]
    if not last:
        return "sem dados suficientes (assista às lições marcando «não entendi» com N)"
    u = sum(r["understood"] for r in last) / len(last)
    if not any(r["unclear"] for r in last):
        return "nenhuma fala marcada — sem sinal (marque «não entendi» com N para calibrar)"
    if u < TOO_HARD:
        return f"{u:.0%} entendido: segure o passo (≤ 2 pontos) ou repita um degrau"
    if u >= COMFORTABLE:
        return f"{u:.0%} entendido: dá para subir mais rápido (6–8 pontos)"
    return f"{u:.0%} entendido: passo normal (4–6 pontos)"


def print_feedback(backup_path: str, lang: str, content_root: str) -> None:
    rows = lesson_feedback(backup_path, lang, content_root)
    print(f"\nCompreensão real ({lang}, do backup):")
    for r in rows:
        print(f"  {r['id']}: {r['understood']:.0%} das falas entendidas "
              f"({r['unclear']} de {r['segments']} marcadas) · {r['minutes']:.0f} min assistidos")
    print("  →", step_advice(rows))

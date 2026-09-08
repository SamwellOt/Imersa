"""dose_factory CLI.

  python -m dose_factory build       --url ... --language ja --level A2 --lesson 4 --title "..."
  python -m dose_factory build-local --media x.mp3 --target-srt x.srt [--translation-srt x.pt.srt] ...
  python -m dose_factory demo        # builds the Japanese demo dose from ../../immersion
"""
from __future__ import annotations

import argparse
import json
import os
import sys

HERE = os.path.dirname(__file__)
CONTENT_ROOT = os.path.abspath(os.path.join(HERE, "../../content"))
IMMERSION_DIR = os.path.abspath(os.path.join(HERE, "../../../immersion"))


def _common(p: argparse.ArgumentParser) -> None:
    p.add_argument("--content-root", default=CONTENT_ROOT)
    p.add_argument("--language", required=True)
    p.add_argument("--language-name", default="")
    p.add_argument("--native-name", default="")
    p.add_argument("--level", required=True)
    p.add_argument("--lesson", type=int, required=True)
    p.add_argument("--title", required=True)
    p.add_argument("--title-target", default=None)
    p.add_argument("--synopsis", default="")
    p.add_argument("--premise", default=None)
    p.add_argument("--cefr", default=None)
    p.add_argument("--hint", default=None)
    p.add_argument("--creator", default=None)
    p.add_argument("--tags", default="")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="dose_factory")
    sub = ap.add_subparsers(dest="cmd", required=True)

    b = sub.add_parser("build", help="URL -> dose")
    _common(b)
    b.add_argument("--url", required=True)
    b.add_argument("--translation-srt", default=None)
    b.add_argument("--prime-summaries", default=None)

    bl = sub.add_parser("build-local", help="local files -> dose")
    _common(bl)
    bl.add_argument("--media", required=True)
    bl.add_argument("--target-srt", required=True)
    bl.add_argument("--translation-srt", default=None)
    bl.add_argument("--scribe-json", default=None)
    bl.add_argument("--prime-summaries", default=None)

    pr = sub.add_parser("prep", help="Scribe JSON -> sentences.txt + units.json")
    pr.add_argument("--scribe", required=True)
    pr.add_argument("--out-stem", required=True)

    asm = sub.add_parser("assemble", help="scribe units + translations -> dose (Korean flow)")
    asm.add_argument("--content-root", default=CONTENT_ROOT)
    asm.add_argument("--language", required=True)
    asm.add_argument("--language-name", default="")
    asm.add_argument("--native-name", default="")
    asm.add_argument("--media", required=True)
    asm.add_argument("--units", required=True)
    asm.add_argument("--translations", required=True)
    asm.add_argument("--prime", default=None)
    asm.add_argument("--words", default=None, help="JSON with the frequency words (cards)")
    asm.add_argument("--meta", required=True, help="JSON with level, lesson, title, synopsis, …")

    wd = sub.add_parser("words", help="pick top-N frequency words per lesson (deduped, i+1)")
    wd.add_argument("--lang", required=True)
    wd.add_argument("--units", nargs="+", required=True, help="units.json files IN LESSON ORDER")
    wd.add_argument("--n", type=int, default=20)

    tt = sub.add_parser("tts", help="generate per-word native TTS (edge-tts) for card fronts")
    tt.add_argument("--lang", required=True)
    tt.add_argument("--words", nargs="+", required=True, help="words.json files")
    tt.add_argument("--force", action="store_true")

    tk = sub.add_parser("tokens", help="(re)preenche segments[].tokens nas doses já publicadas")
    tk.add_argument("--content-root", default=CONTENT_ROOT)
    tk.add_argument("--lang", default=None, help="só este idioma (padrão: todos)")

    fr = sub.add_parser("frames", help="extrai capa (posterSrc) e cena de cada card (sceneSrc) das doses publicadas")
    fr.add_argument("--content-root", default=CONTENT_ROOT)
    fr.add_argument("--lang", default=None, help="só este idioma (padrão: todos)")

    sub.add_parser("demo", help="build the bundled Japanese demo dose")

    args = ap.parse_args(argv)

    if args.cmd == "demo":
        return _demo()

    if args.cmd == "frames":
        from .frames import add_frames, update_course_posters
        import glob
        langs = [args.lang] if args.lang else sorted(
            d for d in os.listdir(args.content_root)
            if os.path.isdir(os.path.join(args.content_root, d, "course")))
        for lang in langs:
            for path in sorted(glob.glob(os.path.join(args.content_root, lang, "course", "*", "dose.json"))):
                add_frames(path)
            update_course_posters(args.content_root, lang)
        return 0

    if args.cmd == "tokens":
        # Dose publicada antes de `tokens` existir: patch no lugar, sem remontar
        # mídia nem fragmentos (o assemble refaz tudo e é destrutivo).
        from .build_local import segment_tokens
        import glob
        pat = os.path.join(args.content_root, args.lang or "*", "course", "*", "dose.json")
        for path in sorted(glob.glob(pat)):
            with open(path, encoding="utf-8") as fh:
                dose = json.load(fh)
            n = 0
            for seg in dose["segments"]:
                seg["tokens"] = segment_tokens(seg["target"], dose["language"])
                n += len(seg["tokens"])
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(dose, fh, ensure_ascii=False, indent=2)
            print(f"{dose['id']}: {n} tokens em {len(dose['segments'])} falas")
        return 0

    if args.cmd == "prep":
        from .build_local import prep_scribe
        ns, nd = prep_scribe(args.scribe, args.out_stem)
        print(f"prep: {ns} sentences, {nd} display lines → {args.out_stem}.sentences.txt / .units.json")
        return 0

    if args.cmd == "words":
        from .frequency import build_lemma_freq, select_frequency_words, rank_map
        from .levels import level_of
        build_lemma_freq(args.lang)
        ranks = rank_map(args.lang)
        used: set[str] = set()
        for up in args.units:
            with open(up, encoding="utf-8") as fh:
                units = json.load(fh)
            words = select_frequency_words(units["sentences"], args.lang, used, args.n)
            for w in words:
                used.add(w["lemma"])
            # sem o sufixo esperado, o replace devolveria o MESMO caminho e a
            # escrita seguinte sobrescreveria o units.json de entrada
            if not up.endswith(".units.json"):
                print(f"  ⚠ {up}: esperado <lição>.units.json — pulando", file=sys.stderr)
                continue
            out = up[: -len(".units.json")] + ".words.json"
            prior: dict[str, dict] = {}
            if os.path.isfile(out):  # preserve meanings/reading/ttsFile across regen
                for pw in json.load(open(out, encoding="utf-8")):
                    prior[pw["lemma"]] = pw
            payload = []
            for w in words:
                pw = prior.get(w["lemma"], {})
                entry = {"lemma": w["lemma"], "surface": w["surface"], "tag": w["tag"],
                         "sentenceIndex": w["sentenceIndex"], "freqRank": ranks.get(w["lemma"]),
                         "topikLevel": level_of(w["lemma"], args.lang),
                         "meaning": pw.get("meaning", ""), "reading": pw.get("reading")}
                if pw.get("ttsFile"):
                    entry["ttsFile"] = pw["ttsFile"]
                payload.append(entry)
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=1)
            print(f"{out}: {len(words)} words")
        return 0

    if args.cmd == "tts":
        from .tts import synth_words
        for wp in args.words:
            with open(wp, encoding="utf-8") as fh:
                words = json.load(fh)
            out_dir = os.path.join(os.path.dirname(os.path.abspath(wp)), "tts")
            n = synth_words(words, args.lang, out_dir, force=args.force)
            with open(wp, "w", encoding="utf-8") as fh:
                json.dump(words, fh, ensure_ascii=False, indent=1)
            print(f"{wp}: {n} novos TTS → {out_dir}")
        return 0

    if args.cmd == "assemble":
        from .build_local import build_dose_from_scribe
        with open(args.meta, encoding="utf-8") as fh:
            m = json.load(fh)
        build_dose_from_scribe(
            content_root=args.content_root, language=args.language,
            language_name=args.language_name or m.get("languageName", args.language),
            native_name=args.native_name or m.get("nativeName", ""),
            media_path=args.media, units_path=args.units,
            translations_path=args.translations, prime_path=args.prime,
            words_path=args.words,
            level=m["level"], lesson=int(m["lesson"]), title=m["title"],
            title_target=m.get("titleTarget"), synopsis=m.get("synopsis", ""),
            premise=m.get("premise"), cefr=m.get("cefr"), hint=m.get("hint"),
            creator=m.get("creator"), source_url=m.get("sourceUrl"),
            source_parts=m.get("sourceParts"),
            source_platform=m.get("sourcePlatform", "youtube"),
            tags=m.get("tags"), grammar=m.get("grammar"), vocab=m.get("vocab"),
            max_cards=int(m.get("maxCards", 50)),
        )
        return 0

    lang_name = args.language_name or args.language
    tags = [t.strip() for t in args.tags.split(",") if t.strip()]
    common = dict(
        content_root=args.content_root, language=args.language, language_name=lang_name,
        level=args.level, lesson=args.lesson, title=args.title,
        title_target=args.title_target, synopsis=args.synopsis, premise=args.premise,
        native_name=args.native_name, cefr=args.cefr, hint=args.hint,
        creator=args.creator, tags=tags,
    )

    if args.cmd == "build":
        from .build_url import build_from_url
        build_from_url(url=args.url, translation_srt=args.translation_srt,
                       prime_summaries=args.prime_summaries, **common)
    elif args.cmd == "build-local":
        from .build_local import build_dose
        build_dose(media_path=args.media, target_srt=args.target_srt,
                   translation_srt=args.translation_srt, scribe_json=args.scribe_json,
                   prime_summaries_path=args.prime_summaries, **common)
    return 0


def _demo() -> int:
    from .build_local import build_dose
    imm = IMMERSION_DIR
    media = os.path.join(imm, "imm.mp3")
    if not os.path.isfile(media):
        print(f"demo source not found: {media}", file=sys.stderr)
        return 1
    prime_path = os.path.join(HERE, "demo_prime_ja.json")
    words_path = os.path.abspath(os.path.join(HERE, "..", ".work", "ja-demo", "imm.words.json"))
    build_dose(
        content_root=CONTENT_ROOT,
        media_path=media,
        language="ja", language_name="Japonês", native_name="日本語",
        level="A2", lesson=1,
        title="Acampamento na chuva de Hiace",
        title_target="梅雨のハイエース車中泊",
        synopsis=("Um vlogueiro decide aproveitar a estação das chuvas e sai para "
                  "acampar sozinho dentro da sua van (Hiace) a uma hora de casa, em "
                  "Kirishima. Fala calma e reflexiva sobre desacelerar e conhecer a "
                  "própria região."),
        premise=("Vlog solo em japonês, um único narrador com fala clara, pausada e "
                 "reflexiva. Ele planeja um pernoite de acampamento na van durante a "
                 "estação das chuvas (梅雨) perto de casa, em Kirishima. Tom calmo e "
                 "acolhedor, vocabulário do dia a dia sobre natureza, viagem e rotina."),
        target_srt=os.path.join(imm, "imm.srt"),
        translation_srt=os.path.join(imm, "imm.pt.srt"),
        scribe_json=os.path.join(imm, "imm.json"),
        prime_summaries_path=prime_path if os.path.isfile(prime_path) else None,
        words_path=words_path if os.path.isfile(words_path) else None,
        cefr="A2",
        hint="Fala clara, pausada e sem gíria pesada — ótimo para intermediário inicial.",
        source_platform="youtube", creator="(vlog de exemplo)",
        tags=["vlog", "natureza", "viagem", "車中泊"],
    )
    print("\nDemo pronta. Rode o app:  cd web && npm install && npm run dev")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())

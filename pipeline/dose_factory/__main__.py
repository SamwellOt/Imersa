"""dose_factory CLI.

  python -m dose_factory build       --url ... --language ja --level A2 --lesson 4 --title "..."
  python -m dose_factory build-local --media x.mp3 --target-srt x.srt [--translation-srt x.pt.srt] ...
  python -m dose_factory demo        # builds the Japanese demo dose from ../../immersion
"""
from __future__ import annotations

import argparse
import glob
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
    wd.add_argument("--frozen", nargs="*", default=[],
                    help="words.json de lições já estudadas: entram no dedup, mas não são regeneradas")

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

    en = sub.add_parser("enrich", help="glossário, cards de frase i+1, homófonos, áudio condensado e cenas das doses publicadas")
    en.add_argument("--content-root", default=CONTENT_ROOT)
    en.add_argument("--lang", required=True)
    en.add_argument("--only", nargs="*", default=None, help="só estas doses (ids); as anteriores entram no i+1")
    en.add_argument("--no-condensed", action="store_true", help="não refaz o áudio condensado")
    en.add_argument("--missing", default=None, help="grava aqui (JSON) os lemas novos sem significado PT")
    en.add_argument("--glossary-only", action="store_true",
                    help="só tokens + glossário (não refaz cards de frase, condensado nem cenas)")

    dc = sub.add_parser("dict", help="gera data/dict_en_<lang>.json (JMdict / Wiktionary) ou importa PT")
    dc.add_argument("--lang", required=True)
    dc.add_argument("--src", default=None, help="ja: JMdict_e.gz · ko: kaikki.org-dictionary-Korean.jsonl")
    dc.add_argument("--pt", default=None, help="JSON {lema: significado} para acrescentar a dict_pt_<lang>.json")

    fl = sub.add_parser("freqlist", help="refaz data/lemma_freq_<lang>.json com o analisador atual (coreano)")
    fl.add_argument("--lang", required=True)
    fl.add_argument("--content-root", default=CONTENT_ROOT)

    kn = sub.add_parser("known", help="importa as palavras marcadas «Já sei» no app para a base declarada")
    kn.add_argument("--lang", required=True)
    kn.add_argument("--import", dest="src", required=True, help="arquivo exportado em Ajustes (imersa-ja-sei-<lang>.json)")

    sub.add_parser("demo", help="build the bundled Japanese demo dose")

    args = ap.parse_args(argv)

    if args.cmd == "demo":
        return _demo()

    if args.cmd == "enrich":
        from .enrich import enrich_language, refresh_glossary
        if args.glossary_only:
            missing = refresh_glossary(args.content_root, args.lang)
        else:
            missing = enrich_language(args.content_root, args.lang, set(args.only) if args.only else None,
                                      condensed=not args.no_condensed)
        if args.missing:
            with open(args.missing, "w", encoding="utf-8") as fh:
                json.dump(missing, fh, ensure_ascii=False, indent=1)
        n = sum(len(v) for v in missing.values())
        if n:
            print(f"⚠ {n} palavras novas sem significado PT (sem '+ card' até traduzir)"
                  + (f" → {args.missing}" if args.missing else ""))
        return 0

    if args.cmd == "dict":
        from . import dictionary as dic
        if args.src:
            n = dic.build_en_ja(args.src) if args.lang == "ja" else dic.build_en_ko(args.src)
            print(f"dict_en_{args.lang}.json: {n} entradas")
        if args.pt:
            with open(args.pt, encoding="utf-8") as fh:
                print(f"dict_pt_{args.lang}.json: {dic.save_pt(args.lang, json.load(fh))} significados novos")
        return 0

    if args.cmd == "freqlist":
        # refaz a lista e atualiza o "#N em frequência" das doses publicadas (cards,
        # cards de frase); o glossário se atualiza com `enrich --glossary-only`
        from .frequency import build_lemma_freq, lemma_rank
        n = len(build_lemma_freq(args.lang, rebuild=True))
        print(f"lista {args.lang}: {n} lemas")
        for path in sorted(glob.glob(os.path.join(args.content_root, args.lang, "course", "*", "dose.json"))):
            with open(path, encoding="utf-8") as fh:
                dose = json.load(fh)
            changed = 0
            ranks = {}
            for c in dose["cards"]:
                if c["id"].startswith("w-"):
                    r = lemma_rank(c["id"][2:], args.lang)
                    ranks[c["id"][2:]] = r
                    changed += c.get("freqRank") != r
                    c["freqRank"] = r
            for sc in dose.get("sentenceCards") or []:
                r = ranks.get((sc.get("focus") or {}).get("lemma"))
                if r != sc.get("freqRank"):
                    sc["freqRank"] = r
                    changed += 1
            with open(path, "w", encoding="utf-8") as fh:
                json.dump(dose, fh, ensure_ascii=False, indent=2)
            print(f"  {dose['id']}: {changed} ranks atualizados")
        return 0

    if args.cmd == "known":
        from .frequency import DATA, KNOWN_BASE
        with open(args.src, encoding="utf-8") as fh:
            got = json.load(fh)
        if got.get("language") not in (None, args.lang):
            print(f"o arquivo é de {got.get('language')}, não {args.lang}", file=sys.stderr)
            return 1
        name = KNOWN_BASE.get(args.lang, {}).get("declared") or f"known_{args.lang}.json"
        path = os.path.join(DATA, name)
        cur = {"lemmas": []}
        if os.path.isfile(path):
            with open(path, encoding="utf-8") as fh:
                cur = json.load(fh)
        before = set(cur["lemmas"])
        cur["lemmas"] = sorted(before | set(got["lemmas"]))
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(cur, fh, ensure_ascii=False, indent=1)
        print(f"{name}: +{len(set(cur['lemmas']) - before)} palavras (total {len(cur['lemmas'])}). "
              f"Rode `tokens`/`enrich` para a legenda contar como base.")
        return 0

    if args.cmd == "frames":
        from .frames import add_frames, update_course_posters
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
        from .frequency import build_lemma_freq, select_frequency_words, lemma_rank
        from .levels import level_of
        from .dictionary import meaning_pt
        build_lemma_freq(args.lang)
        used: set[str] = set()
        # lição que o aluno já estudou tem cards no banco dele (id = lema): regerar
        # mudaria o conjunto e deixaria cards órfãos. Só entra no dedup.
        for fp in args.frozen:
            with open(fp, encoding="utf-8") as fh:
                used.update(w["lemma"] for w in json.load(fh))
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
                         "sentenceIndex": w["sentenceIndex"], "freqRank": lemma_rank(w["lemma"], args.lang),
                         "occurrences": w.get("occurrences"),
                         "topikLevel": level_of(w["lemma"], args.lang),
                         # significado: o já preenchido; senão o do dicionário PT curado
                         "meaning": pw.get("meaning") or meaning_pt(w["lemma"], args.lang) or "",
                         "reading": pw.get("reading") or w.get("reading")}
                if w.get("display") and w["display"] != w["lemma"]:
                    entry["display"] = w["display"]
                if pw.get("ttsFile"):
                    entry["ttsFile"] = pw["ttsFile"]
                payload.append(entry)
            with open(out, "w", encoding="utf-8") as fh:
                json.dump(payload, fh, ensure_ascii=False, indent=1)
            print(f"{out}: {len(words)} words — " + " ".join(
                f"{w['lemma']}×{w.get('occurrences')}" for w in words))
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

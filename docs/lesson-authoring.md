# Autoria de lição e pipeline

Movido do `CLAUDE.md` em 01/11/2026, texto intacto. Regras ditadas pelo usuário — siga à risca.

## Regras de autoria de lição (o usuário definiu — siga à risca)

- **Comece pelo mais fácil que existir.** As primeiras lições são para quem nunca viu o
  idioma: vídeo *super iniciante* (A0), fala lenta, uma ideia por frase, apoio visual e
  repetição. Só depois subir de nível, e **de forma medida** — antes de escolher um vídeo,
  meça: palavras distintas por minuto, caracteres falados por segundo e a **mediana do rank
  de frequência** das palavras dele (`frequency.rank_map`). Um vlog nativo "de A1" costuma
  dar 15+ palavras novas por minuto: é degrau demais para o dia 1.
  (Isso vale para quem começa do zero, o caso do coreano. O **japonês** é outro aluno:
  intermediário N4–N3, já fazia imersão, pediu **vlog / viagem / conversa natural de até
  30 min** e vai pedir lições **em lotes** ("faça mais 7"), então a progressão tem de ser
  uma **escada contínua entre lotes**. A régua é `.work/ja/ladder.py`: score 0–100 com
  **âncoras fixas** (média de palavras fora da base/min, % de ocorrências fora da base e
  car/s), estável quando entram candidatos novos. Regras: lição nova só **acima** da última
  publicada; passo de **~4–6 pontos** por lição (o 1º lote foi de 13 a ~40; o vlog nativo
  rápido fica em ~90–100, ou seja, umas 20 lições depois); variar gênero e canal entre
  dias seguidos; não queimar os nativos cedo. Antes de um lote novo: ampliar o conjunto de
  candidatos (`scout/search*.sh`, só legenda via Tor) e rodar `ladder.py --next N`.
  Vídeo já transcrito e traduzido que ficou forte demais para o lote vai para o **banco**
  (`.work/ja/bank/<id do vídeo>/`, meta em `lessons_meta.py` chaveada pelo id) e é
  promovido quando a escada chegar nele. Tudo em `.work/ja` é chaveado por **vídeo**, não
  pelo número da lição, para a escada poder ser reordenada.
  **Quem fala (pedido do aluno em 28/09/2026):** ele é homem e quer aprender os trejeitos
  masculinos — vídeo **só de mulheres, ou feito majoritariamente por uma mulher, não entra**
  (mulher no vídeo pode, não sozinha), e **narração roteirizada também não** (o Speak
  Japanese Naturally saiu por isso): só fala espontânea. Meça, não adivinhe pelo canal:
  `.work/ja/voice.py <áudio> <scribe.json>` dá a % de fala masculina por falante (F0);
  com música de fundo alta a F0 falha, e aí vale conferir pelos quadros do vídeo e pelos
  pronomes (俺/僕/ぞ/だろ). O que sai da trilha vai para `.work/ja/retired/<id>/`.)
- **15–20 min** por lição, pegando o trecho **otimizado** de alta compreensão. Se **e só se**
  não existir um vídeo bom de ~15 min, emende **2 ou 3** vídeos numa lição só (mesmo nível,
  mesmo canal de preferência) e tire os 20 cards do conjunto. As origens ficam registradas
  em `source.parts[]`; os tempos da dose são sempre os do vídeo **concatenado**.
- **20 cards por dose = frequência do idioma × ocorrências no vídeo** (forma de dicionário;
  `frequency.py`; ko: `data/freq_raw_ko.txt` via kiwipiepy; ja: `data/freq_bccwj_ja.tsv` via
  fugashi). O vídeo define o conjunto candidato; a nota é `−ln(rank) + 0,85·ln(falas em que
  aparece)` (`card_score`) e entram primeiro as ditas **2+ vezes** (rank ≤ 12000), depois as
  demais. A lista do idioma continua o peso principal; a ocorrência só impede que a palavra
  dita uma vez tome o lugar da que sustenta o vídeo (pedido do usuário em 24/09/2026 — antes
  era só a lista, e 充電 ×20 ficava de fora). **Nome próprio** não é token nem card (NNP,
  固有名詞, `data/names_<lang>.json`); no japonês **compostos de unidade longa** viram uma
  palavra (飛行機, 金曜日 — `data/luw_ja.tsv`, 長単位語彙表 do NINJAL; leitura do JMdict).
  **Sem repetir** palavras de lições anteriores (dedup acumulado → i+1).
  **Base já conhecida** (`KNOWN_BASE` em `frequency.py`, hoje
  `{"ja": {"top": 1000, "jlpt": ("N5", "N4"), "loanwords": True, "declared": "known_ja.json"}}`): o aluno de japonês
  está na transição N4→N3 («base de 1000 palavras»). A base é **N5 + N4 inteiros**
  (便利, 窓, 遠い ficam depois do #1000 do corpus); o top-1000 só completa com palavras que
  **nenhum nível do JLPT reivindica** — o JLPT manda: 355 das 1000 mais frequentes são
  N3+ (状態, 確認, 結果) e **não** são base (até 09/2026 eram, por engano). **外来語 não vira
  card** (fáceis demais — pedido do aluno): lema em katakana (`is_loanword`) conta como
  base, e card cuja grafia seria só katakana (マジ, コショウ) também fica de fora.
  **Palavras declaradas**: `data/known_ja.json` lista as N3+ que o aluno disse já saber
  (55 das 243 do top-1000 que faltavam, marcadas em 24/09/2026) — contam como base e
  vencem o JLPT. Ao acrescentar palavras ali, rode `words --frozen` (lições estudadas) e
  `tokens --lang ja` (atualiza o `base: true` das legendas publicadas).
  Lições já estudadas entram no dedup com `words --frozen L1.words.json …` (não são
  regeneradas: o id do card é o lema, mudar o conjunto deixaria cards órfãos). Hoje B1-01 a
  B1-03 (ja) e A1-01 a A1-04 (ko) estão congeladas (`meanings.py` ainda escreve L3+ — o L3
  não muda porque o significado é o mesmo). Significado novo vai para
  `data/dict_pt_<lang>.json` (`dict --pt`), de onde o `words` preenche `meaning`.
  **Depois de montar, rode `dose_factory enrich --lang <l>`**: glossário (dicionário da
  legenda + "+ card"), cards de frase i+1, homófonos, áudio condensado e cenas.
- **Progressivo (i+1)**: cada dia um degrau acima. Curadoria em **vlog / conversa natural**,
  no nível do aluno.
- **Tradução PT fiel** (feita para aprender, preserva a estrutura do original — não
  "aportuguesa" demais). Ver `docs/dose-contract.md` e `translate-srt`.

## Gerar conteúdo novo (pipeline)

**Fluxo curto (o das lições A0 de coreano, sem chave de API):** o canal já publica legenda
coreana **manual** no YouTube — baixe com `yt-dlp --write-subs --sub-langs ko,en` e pule o
Scribe. `.work/ko2/build.py` corta a região legendada de cada vídeo, transcodifica
(AV1→H.264, 640×360, `loudnorm`), **concatena** as partes da lição e já emite o
`<L>.units.json` com os tempos deslocados para a mídia concatenada (+ `<L>.en.json`, a
legenda inglesa do autor, útil como referência ao traduzir).

**Fluxo longo (mídia sem legenda):** baixar áudio + vídeo 360p → transcrever (ELabs Scribe) → `prep` (frases)
→ `words` (top-20 por frequência, deduped, com frase-exemplo curta) → **traduzir**
`<L>.trans.json` e preencher `meaning` em `<L>.words.json` → `tts` (TTS nativo das palavras)
→ `<L>.prime.json` + `<L>.meta.json` → transcodificar vídeo AV1→H.264 → `assemble`
→ **`frames`** (capa + cena de cada card, `media/frames/`; roda sobre a dose publicada).

```bash
export ELEVENLABS_API_KEY=...                # só para transcrever (o usuário fornece; NÃO commitar)
python -m dose_factory prep  --scribe L.json --out-stem L
python -m dose_factory words --lang ko --units L1.units.json L2.units.json L3.units.json  # em ordem, dedup
#   → preencha meaning em cada <L>.words.json (e traduza <L>.trans.json)
python -m dose_factory tts   --lang ko --words L1.words.json L2.words.json L3.words.json    # edge-tts, nativo
python -m dose_factory assemble --language ko ... --media L.h264.mp4 \
  --units L.units.json --translations L.trans.json --prime L.prime.json \
  --words L.words.json --meta L.meta.json
```
Regenerar `words` **preserva** os `meaning`/`ttsFile` já preenchidos (merge por lema).
Listas de frequência: coreano em `pipeline/data/freq_raw_ko.txt` (OpenSubtitles/OPUS, as
50 mil formas, lematizadas para `data/lemma_freq_ko.json` — **refaça com `dose_factory
freqlist --lang ko` sempre que mexer na lematização coreana**: a lista e o analisador
dependem um do outro e o cache velho deixava 사람들 separado de 사람; contrações que o
kiwi lê soltas como substantivo — 날 = 나를, 거지 = 것이지, 수도 = -ㄹ 수도 — são
desfeitas em `_KO_SURFACE_FIX`). Palavra fora da lista mas no TOPIK/JLPT (귤, 김밥)
pode virar card com peso de rara (antes era descartada); japonês em `data/freq_bccwj_ja.tsv` — o
**BCCWJ 短単位語彙表 do NINJAL**, já por lema UniDic, ordenado pelo registro coloquial
(Yahoo!知恵袋 + Yahoo!ブログ). A lista OpenSubtitles do japonês era inútil (sem espaços para
separar: 見る caía em #990, atrás de 捜査 e 殺人) e foi removida.

**Fluxo do japonês (B1, com Scribe):** `.work/ja/lessons.txt` (lição · parte · id) →
`dl.sh` (360p via Tor) → `build.py` (H.264 + loudnorm, concatena, **transcreve a mídia
concatenada** no Scribe `language_code=jpn` e roda `prep`) → `pt.tsv` por lição (tradução
fiel) → `lessons_meta.py` (meta + prime + `trans.json`) → `words` → `meanings.py` → `tts` →
`assemble.sh` (monta todas e roda `frames`). Erros do Scribe se corrigem no `units.json`
(e no `FIX` do `clauses.py`, chaveado pelo vídeo). Para medir um candidato na transcrição
real antes de baixar o vídeo: Scribe sobre o áudio + `units_rank.py` (a régua do
`ladder.py` sobre `units.json`; a legenda automática subestima os vlogs nativos em ~10 pontos).

**Notas operacionais deste ambiente** (importantes):
- **YouTube bloqueia o IP** ("Sign in to confirm you're not a bot"). Roteie o yt-dlp pelo
  **Tor** já rodando: `--proxy socks5h://127.0.0.1:9050`. O `.work/ja/yt.sh` usa um
  **usuário SOCKS novo a cada tentativa** (o Tor isola o circuito por credencial → exit
  novo sem reiniciar). O torrc do sistema só usa exits dos EUA, quase todos marcados: se
  falhar em série, suba uma instância sem `ExitNodes` (`tor --SocksPort 9060 --DataDirectory …`)
  e rode com `TOR_SOCKS=127.0.0.1:9060`. `--download-sections` não serve: o ffmpeg baixa fora do proxy (403).
  Precisa do **deno** (`--js-runtimes deno`) + **yt-dlp nightly**.
- Vídeo do YouTube vem em **AV1** → **transcodifique para H.264** (`libx264` + `aac` +
  `-movflags +faststart`) para tocar em qualquer navegador.
- Detalhes completos em `pipeline/README.md`; artefatos em `pipeline/.work/`.

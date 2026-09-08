# Fábrica de doses (pipeline)

Transforma mídia da língua-alvo em um `dose.json` que o app consome. Reaproveita os
*dojo skills* de `../../immersion/dojo-prompts`.

## Comandos

```bash
# Dose demo em japonês (dos arquivos de exemplo, sem chave de API)
python -m dose_factory demo

# Fluxo por Scribe (usado no coreano): prep → words → (traduzir) → assemble
python -m dose_factory prep  --scribe L1.json --out-stem L1
python -m dose_factory words --lang ko --units L1.units.json L2.units.json L3.units.json  # em ordem, dedup
#   → edite: L1.trans.json (frases PT) · L1.words.json (meaning das 20 palavras) · L1.prime.json · L1.meta.json
python -m dose_factory tts   --lang ko --words L1.words.json L2.words.json L3.words.json   # TTS nativo (frente)
python -m dose_factory tokens [--lang ko]   # preenche segments[].tokens em doses já publicadas (assemble já emite)
python -m dose_factory frames [--lang ko]   # capa (media.posterSrc) + cena de cada card (cards[].sceneSrc) em media/frames/, e posterSrc no course.json
python -m dose_factory assemble --language ko --language-name Coreano \
  --media L1.h264.mp4 --units L1.units.json --translations L1.trans.json \
  --prime L1.prime.json --words L1.words.json --meta L1.meta.json

# Dose a partir de arquivos locais (mídia + legendas + Scribe JSON)
python -m dose_factory build-local \
  --media video.mp4 --target-srt video.srt --translation-srt video.pt.srt \
  --scribe-json video.json \
  --language ja --language-name Japonês --level A2 --lesson 4 --title "..."

# Dose a partir de uma URL (baixa + transcreve + monta) — precisa de ELEVENLABS_API_KEY
export ELEVENLABS_API_KEY=...
python -m dose_factory build \
  --url "https://youtu.be/..." \
  --language ja --language-name Japonês --level A2 --lesson 4 --title "..." \
  [--translation-srt já_traduzido.pt.srt] [--prime-summaries chunks.json]
```

## Estágios (URL)

download (yt-dlp) → transcrição (ElevenLabs Scribe) → SRT alvo (bunsetsu, dojo
`srt_watch.py`) → **tradução PT** (skill LLM `translate-srt` — rode pelo agente ou
passe `--translation-srt`) → **prime** (skill LLM `primed-summaries` — opcional,
passe `--prime-summaries`) → montagem (`build_local`).

Tradução e prime são passos de LLM nos dojo skills, não scripts puros. O
orquestrador gera os artefatos determinísticos (mídia + JSON + SRT alvo) e monta a
dose; passe a tradução/prime prontos desses skills quando quiser incluí-los.

## Saída

`../content/<lang>/course/<LEVEL>-<NN>/dose.json` (+ `media/`), e atualiza
`../content/index.json` e `../content/<lang>/course.json`. Formato:
[`../docs/dose-contract.md`](../docs/dose-contract.md).

## Fluxo curto: canal que já publica legenda manual (lições A0 de coreano)

O canal **몰입한국어 (Immersion in Korean)** publica legenda coreana **manual** (+ inglesa)
no YouTube — dá para pular o Scribe inteiro e não precisa de `ELEVENLABS_API_KEY`:

1. **Escolher os vídeos medindo a dificuldade** (não pelo rótulo do canal). Use
   `.work/scout_rank.py '<glob de .ko.srt>'`: ele imprime, por vídeo, linhas, duração do
   corpo legendado, palavras distintas, **mediana do rank de frequência**, % no top-500/1000,
   caracteres falados por segundo e *type-token ratio*. Lição 1 = menor mediana + menor
   cps. `.work/story_dump.py <id>…` imprime a história inteira (ko | en) para curadoria.
2. **Baixar** vídeo 360p + legendas:
   `yt-dlp --write-subs --sub-langs ko,en --sub-format srt --convert-subs srt`.
3. **`.work/ko2/build.py`** — para cada lição: detecta a região legendada de cada vídeo
   (o primeiro corte grande de >20 s separa a chamada de abertura do corpo), corta,
   transcodifica AV1→H.264 640×360 com `loudnorm`, **concatena** as partes e emite
   `<L>.units.json` já com os tempos deslocados para a mídia concatenada, `<L>.en.json`
   (legenda inglesa do autor, referência para traduzir) e `<L>.parts.json` (offsets).
4. `words` → `<L>.words.json`; preencher `meaning`; escrever `pt.tsv` (frase → PT) e gerar
   `<L>.trans.json`; escrever `<L>.prime.json` e `<L>.meta.json` (com `sourceParts`).
5. `tts` → `assemble` (`.work/ko2/assemble.sh`).

Cuidado que motivou esse fluxo: esses vídeos têm **3 etapas** (história sem legenda → com
legenda **queimada na imagem** → repetição). O texto na imagem foi aceito pelo usuário;
se um dia não for, só a 1ª etapa é limpa (~3 min por vídeo).

## Gerando conteúdo real (o que foi usado no coreano)

Neste ambiente o YouTube bloqueia o IP do servidor ("Sign in to confirm you're not a
bot"). O fluxo que funciona:

1. **Runtime JS + yt-dlp nightly:** instale `deno` e use o binário nightly do yt-dlp
   (`--js-runtimes deno`).
2. **Rotear por Tor:** o Tor já roda em `127.0.0.1:9050`. Passe
   `--proxy socks5h://127.0.0.1:9050`. Se um exit estiver marcado, reinicie o Tor
   (`service tor restart`) para pegar um circuito novo — o `.work/dlvideos.sh` faz isso
   em loop automaticamente.
3. **Baixar áudio** (m4a) para transcrever e **vídeo 360p** para a imersão.
4. **Transcrever** com ElevenLabs Scribe (`language_code=kor`, `scribe_v1`).
5. **prep** → extrai frases + linhas de exibição (`<L>.units.json` / `<L>.sentences.txt`).
6. **words** (`--lang ko --units L1.units.json L2… L3…` **em ordem**) → escolhe as **top-20
   palavras por frequência** que aparecem em cada lição, **sem repetir** as das lições
   anteriores (dedup = i+1), em `<L>.words.json`. Ranqueamento por lema (kiwipiepy p/ ko,
   fugashi p/ ja) usando `data/freq_raw_<lang>.txt`.
7. **Traduzir**: `<L>.trans.json` (frases, PT fiel) + preencher `meaning` nas 20 palavras de
   `<L>.words.json` + `<L>.prime.json` (blocos de prime em PT) + `<L>.meta.json`.
8. **tts** → gera o TTS nativo (edge-tts) de cada palavra em `<L>/tts/` e grava `ttsFile`.
9. **Transcodificar** o vídeo AV1 → H.264 (`libx264` + `aac` + `-movflags +faststart`).
10. **assemble** com `--media <video.h264.mp4> --words <L>.words.json` → **20 cards de
    palavra**: frente = TTS da palavra (`media/tts/`); verso = significado PT + frase-exemplo
    curta com a palavra destacada, tocada por um **fragmento pré-cortado** (`media/frag/`,
    cortado por ffmpeg no assemble). As legendas de imersão usam TODAS as linhas, cada
    uma com `tokens` (palavras de conteúdo + posição + lema) para a legenda
    "conhecido/novo" e a compreensão por lição no app.

As lições coreanas foram montadas assim (ver `.work/` para os artefatos e
`.work/assemble_all.sh`).

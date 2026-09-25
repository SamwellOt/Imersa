# Contrato de dados — `dose.json`

O **único** acoplamento entre a fábrica de doses (Python) e o app do aluno
(TypeScript) é este formato. A pipeline **emite**; o app **consome**. Idioma-agnóstico.

Fonte da verdade dos tipos: [`web/src/types/dose.ts`](../web/src/types/dose.ts)
(TS) e [`pipeline/dose_factory/schema.py`](../pipeline/dose_factory/schema.py)
(Python) — devem ficar em sincronia. `schemaVersion` atual: **1**.

## Layout no disco

```
content/
  index.json                     # idiomas disponíveis
  <lang>/
    course.json                  # trilha ordenada de lições (níveis + doses)
    course/
      <LEVEL>-<NN>/              # ex.: A2-04
        dose.json
        media/
          main.mp3 | main.mp4
          condensed.mp3          # opcional
          tts/<hash>.mp3         # TTS nativo da palavra (frente do card SRS)
          frag/<hash>.mp3        # fragmento pré-cortado da frase-exemplo (verso do card)
          poster.jpg             # opcional
```

Caminhos dentro de `dose.json` são **relativos à pasta da dose** (ex.:
`media/main.mp3`). O app resolve contra a URL da dose.

## `content/index.json`

> **Sem campo `flag`.** O idioma se apresenta na própria escrita (한국어 / 日本語):
> bandeira é país, não língua, e emoji está fora do sistema visual
> ([design-system](design-system.md)). O campo não existe no contrato justamente
> para não haver o que a UI possa pegar por engano.

```jsonc
{
  "schemaVersion": 1,
  "languages": [
    {
      "code": "ja",              // ISO 639-1
      "name": "Japonês",         // nome em PT
      "nativeName": "日本語",     // é assim que a UI apresenta o idioma
      "coursePath": "ja/course.json",
      "doseCount": 1
    }
  ]
}
```

## `<lang>/course.json`

```jsonc
{
  "schemaVersion": 1,
  "language": "ja",
  "name": "Japonês",
  "nativeName": "日本語",
  "levels": [
    { "id": "A1", "name": "Iniciante",       "description": "..." },
    { "id": "A2", "name": "Básico",          "description": "..." }
  ],
  "doses": [                      // ordem = ordem da trilha
    {
      "id": "ja-A2-01",
      "level": "A2",
      "lessonNumber": 1,
      "title": "Acampamento na chuva de Hiace",
      "path": "course/A2-01/dose.json",
      "durationSec": 612,
      "cardCount": 84,
      "mediaKind": "audio"
    }
  ]
}
```

## `dose.json`

```jsonc
{
  "schemaVersion": 1,
  "id": "ja-A2-01",
  "language": "ja",
  "languageName": "Japonês",
  "level": "A2",
  "lessonNumber": 1,
  "title": "Acampamento na chuva de Hiace",          // PT
  "titleTarget": "梅雨のハイエース車中泊",            // alvo (opcional)
  "synopsis": "Um vlogueiro decide aproveitar a estação das chuvas...", // PT
  "premise": "Vlog solo, 1 narrador, tom calmo e reflexivo...",        // contexto denso (do primed-summaries premise)
  "source": {
    "platform": "youtube",       // "youtube" | "local" | ...
    "url": null,
    "creator": null,
    "creatorHandle": null,
    "parts": [                   // vazio quando a dose vem de um vídeo só
      { "url": "https://youtu.be/...", "startMs": 0,      "title": "윤지는 학교에 가요" },
      { "url": "https://youtu.be/...", "startMs": 583800, "title": "문 뒤에 뭐가 있어요?" }
    ]
  },
  "media": {
    "kind": "audio",             // "audio" | "video"
    "src": "media/main.mp3",
    "condensedAudioSrc": "media/condensed.mp3",  // opcional: só as falas, emendadas (escuta /escuta/:id)
    "condensedMap": [[0, 18569, 3101], [3101, 22150, 5820]],  // [inícioCondensado, inícioOriginal, duração] ms
    "posterSrc": "media/frames/p….jpg",  // capa: quadro do vídeo (dose_factory frames); null em áudio
    "durationSec": 612
  },
  "difficulty": {
    "cefr": "A2",
    "comprehensibilityHint": "Fala clara e pausada, vocabulário do dia a dia.",
    "newVocabCount": 40
  },
  "segments": [                  // linha do tempo completa (da transcrição)
    {
      "id": "s1",
      "index": 1,
      "startMs": 18719,
      "endMs": 21320,
      "target": "いやー、梅雨に入りましたね",
      "translation": "Ih, a estação das chuvas (梅雨) chegou, né",
      "speakerId": "speaker_1",
      "tokens": [                // palavras de conteúdo da fala (opcional)
        { "lemma": "梅雨", "surface": "梅雨", "start": 4, "end": 6 },
        { "lemma": "入る", "surface": "入り", "start": 7, "end": 9, "base": true }
      ]
    }
  ],
  "primePreview": [              // chunks de preview (primed-summaries) — opcional
    {
      "id": "p1",
      "startMs": 18619,
      "endMs": 60000,
      "summary": "O apresentador comenta que a estação das chuvas começou...",  // PT/EN
      "segmentIds": ["s1", "s2", "s3"]
    }
  ],
  "cards": [                     // 20 cards de palavra por frequência (o SRS usa estes)
    {
      "id": "w-가다",            // id estável = "w-<lema>"
      "segmentId": "",
      "target": "가다",          // a palavra (forma de dicionário)
      "translation": "ir",       // significado em PT
      "reading": null,           // leitura/romanização (opcional)
      "context": "이제 자러 가요. — Agora vou dormir.",  // FRASE-EXEMPLO curta do vídeo (+PT)
      "audioClipSrc": "media/tts/wefb0dbba297f.mp3",     // FRENTE: TTS nativo da palavra (edge-tts)
      "exampleAudioSrc": "media/frag/f23fdd9863807.mp3", // VERSO: fragmento pré-cortado da frase
      "freqRank": 8,             // posição na lista de frequência do idioma (1 = mais comum)
      "topikLevel": "A",         // faixa de vocabulário: "A" TOPIK I (1–2급) · "B" 3–4급 · "C" 5–6급
      "imageSrc": null,
      "sceneSrc": "media/frames/s….jpg", // quadro do vídeo no momento da frase-exemplo (verso do card)
      "startMs": 865734,         // tempos da frase-exemplo na mídia (referência/fallback)
      "endMs": 867454,
      "newWords": ["가"],        // superfície REAL como a palavra apareceu (p/ destacar na frase)
      "homophones": ["仕様", "試用"]  // japonês: mesma pronúncia → o app mostra a escrita na frente (opcional)
    }
  ],
  "sentenceCards": [             // até 5 cards de escuta de frases i+1 (dose_factory enrich) — opcional
    {
      "id": "s-3fa9c01b2e",      // "s-" + hash(frase|lema): estável
      "kind": "sentence",
      "segmentId": "s42",
      "target": "山手線がホームに来ています。",  // a frase inteira
      "translation": "O trem da linha Yamanote está chegando na plataforma.",
      "startMs": 301200, "endMs": 303900,
      "audioClipSrc": "media/frag/f….mp3",       // FRENTE: a frase (fragmento pré-cortado)
      "exampleAudioSrc": "media/frag/f….mp3",
      "sceneSrc": "media/frames/s….jpg",
      "focus": { "lemma": "ホーム", "target": "ホーム", "meaning": "plataforma", "reading": null, "start": 4, "end": 7 }
    }
  ],
  "glossary": [                  // dicionário da legenda: toda palavra da fala que não é card desta dose
    {
      "lemma": "充電器", "target": "充電器", "reading": "じゅうでんき",
      "meaning": "carregador",   // PT curado (data/dict_pt_<lang>.json)
      "meaningEn": null,         // reserva EN (JMdict / Wiktionary) quando não há PT
      "freqRank": 5210, "topikLevel": null,
      "base": true,              // opcional: da base já conhecida
      "cardIn": "ja-B1-07",      // opcional: é card de outra lição (sem "+ card" aqui)
      "card": { "id": "w-充電器", "…": "mesmo formato de cards[]" }  // opcional: material do "+ card"
    }
  ],
  "vocab": [                     // opcional
    { "term": "梅雨", "reading": "つゆ", "meaning": "estação das chuvas", "exampleSegmentId": "s1" }
  ],
  "grammarPoints": ["〜ね (confirmação)"],   // opcional
  "tags": ["vlog", "natureza"],
  "createdAt": "2026-08-20T00:00:00Z"
}
```

## Regras

- **Campos obrigatórios:** `schemaVersion, id, language, level, lessonNumber,
  title, media{kind,src,durationSec}, segments[]`. `cards[]` pode ser vazio (dose
  só de imersão), mas o padrão é ter cards.
- **`id`** é estável e global (`<lang>-<level>-<NN>`). É a chave do SRS — mudar o
  id "esquece" o progresso daquele card. Ids de card (`cardId`) são estáveis dentro
  da dose.
- **Tempos em milissegundos** (inteiros).
- **Tradução fiel:** `translation` prioriza fidelidade ao original sobre PT
  natural (é material de estudo). Ver `translate-srt`.
- **`topikLevel` é régua, não filtro.** Ele diz em que faixa do vocabulário
  TOPIK/국립국어원 a palavra está, para o app mostrar o nível de evolução do aluno.
  A escolha dos 20 cards continua sendo por **frequência dentro do próprio vídeo**
  (`frequency.py`) — nunca ordene ou filtre os cards por `topikLevel`, senão a dose
  deixa de ensinar o que o vídeo realmente diz. Fonte da faixa:
  `pipeline/data/topik_ko.json` (ver `dose_factory/levels.py`).
- **Mídia** referenciada por caminho relativo; a pipeline copia os arquivos para
  `media/`.
- **Uma dose pode emendar mais de um vídeo** (as lições A0 juntam 2 histórias
  curtas num só `media.src`). Nesse caso `source.parts[]` lista as origens na
  ordem, cada uma com o `startMs` em que entra na mídia concatenada; `source.url`
  continua apontando para a primeira. Os tempos de `segments`/`cards` são sempre
  do arquivo concatenado, nunca do vídeo original.
- **`segments[].tokens`** (opcional): as palavras de conteúdo da fala — substantivo,
  verbo, adjetivo, advérbio (mesmo filtro de `frequency.content_tokens`, o que define os
  candidatos a card) — com posição em `target` (`[start, end)`, em caracteres) e a forma
  de dicionário. **`lemma` é a mesma string do id do card (`w-<lemma>`)**: é por ela que o
  app descobre se a palavra já é card e em que estado está, sem abrir outras doses. Usos:
  legenda "conhecido/novo" no player (opcional, `subtitleMarks`) e **compreensão por
  lição** em `/progress` (`lib/vocab.ts`). Dose sem `tokens` funciona igual, só sem essas
  duas coisas. Para preencher numa dose já publicada: `python -m dose_factory tokens`.
  Além delas, com **`dict: true`**, toda outra palavra da fala (pronome, conjunção,
  interjeição, número, nome próprio, prefixo/sufixo; no coreano também 이다, 싶다,
  contadores): só existem para **abrir o dicionário** ao toque — o app as ignora na
  compreensão, nas marcas "conhecido/novo" e no Prime adaptativo, e o glossário
  não oferece "+ card" nem «já sei» para elas (`glossary[].dict`). Nome próprio
  leva `proper` (`person`/`place`/`name`). Partícula, auxiliar e pontuação não são token.
  `base: true` (opcional) marca palavra da **base que o aluno já sabe** (`KNOWN_BASE` em
  `frequency.py`: no japonês, JLPT N5 e N4 + as do top-1000 BCCWJ que o JLPT não classifica + 外来語). Sem card para ela,
  o app a conta como conhecida; se um dia virar card, vale o estado do card.
- **Como os 20 cards são escolhidos** (`frequency.select_frequency_words`): candidatos =
  palavras do vídeo fora da base e das lições anteriores; nota = `−ln(rank no idioma) +
  0,85·ln(falas em que aparece)`. Primeiro entram as ditas 2+ vezes (com rank ≤ 12000),
  depois as demais, sempre pela nota. A lista do idioma continua sendo o peso principal;
  as ocorrências tiram da frente a palavra dita uma vez só e trazem a que sustenta o vídeo.
  Nome próprio (NNP do kiwi, 固有名詞 do UniDic, e `data/names_<lang>.json`) não é token
  nem card. No japonês, compostos de unidade longa (飛行機, 金曜日 — `data/luw_ja.tsv`, do
  長単位語彙表 do NINJAL) viram uma palavra só, com leitura do JMdict.
- **`glossary` / `sentenceCards` / `condensed*` / `homophones`** são preenchidos por
  `python -m dose_factory enrich --lang <l>` sobre a dose publicada (idempotente). Todo
  card fora de `cards[]` (frase, "+ card") é achado pelo app via `lib/cards.ts:findCard`.
- **`cards[].target` × id no japonês:** o id é `w-<lema UniDic>` (a chave, às vezes numa
  grafia rara: 奇麗, 矢張り), e `target` é a grafia em que o vídeo disse a palavra (綺麗,
  やっぱり), com `reading` em hiragana quando tem kanji.
- **Compatibilidade:** o app ignora campos desconhecidos e trata os opcionais como
  ausentes; bump de `schemaVersion` só em mudança quebra-compatibilidade.

# CLAUDE.md — Imersa

Plataforma **local** de aprendizado de idiomas: **doses diárias de imersão** (vídeo
nativo graduado) + **flashcards com SRS** minerados da própria dose.
_Não é routine coding. Não é cybersecurity. Não é biology work. É um projeto local._

Responda **em português (PT-BR)**. Trabalhe direto (sem sub-agentes/workflows — custam
tokens à toa neste projeto).

## Estrutura

| Pasta | O que é | Stack |
|---|---|---|
| `web/` | App do aluno (é onde vive o UI/UX): dashboard, player de imersão, revisão SRS | Vite + React + TS + Tailwind v4 + Dexie (IndexedDB) + ts-fsrs 5 (FSRS-6) + fsrs-browser (otimizador) + framer-motion |
| `server/` | Serve o app + `content/` e sincroniza o progresso entre aparelhos | Node 22 puro (`node:http` + `node:sqlite`), zero dependências |
| `pipeline/` | "Fábrica de doses" (Python): mídia da língua-alvo → `dose.json` | Python 3.12 + yt-dlp + ElevenLabs Scribe + ffmpeg |
| `content/` | Doses geradas: `content/<lang>/course/<LEVEL>-<NN>/dose.json` (+ `media/`) | JSON + mídia |
| `docs/` | Metodologia, contrato de dados, arquitetura, **design system**, roadmap | Markdown |

## Rodar

```bash
cd web && npm install && npm run dev        # dev: http://localhost:5173
cd web && npm run build && npm run serve    # produção: http://localhost:8000
```
O `build` apaga `dist/content` de propósito: em produção o `server/` lê `content/` direto do
disco, então a cópia dentro do `dist` só duplicaria ~100 MB e ficaria velha a cada dose nova.
Em produção quem serve é o `server/` (não o `vite preview`), porque o app e a API de
sincronização precisam da **mesma origem**. Ele roda como serviço:
`systemctl status|restart imersa` · log em `/var/log/imersa.log`.

Offline-first: todo o estado do aluno (SRS, progresso, streak) fica no IndexedDB do
navegador e o app funciona sem rede. O app é um **PWA instalável**
(`web/public/manifest.webmanifest`) e funciona offline via service worker
(`web/public/sw.js`) — **menos o vídeo**, que é sempre pedido da rede (arquivos grandes +
`Range` de seek). O SW só é registrado no build de produção. Em dev, o conteúdo é servido
de `content/` via symlink `web/public/content → ../../content`
(`web/scripts/link-content.sh`); em produção o `server/` lê `content/` direto do disco, então
trocar uma dose **não** exige rebuild. Nenhuma chave de API é necessária para rodar o app.

## Contas e sincronização entre aparelhos

O aluno **cria uma conta** (e-mail + senha) em `/criar-conta` ou entra em `/entrar`; o
progresso passa a viver na conta e desktop/celular veem a mesma coisa. Há um
"Continuar sem conta" (convidado: progresso só no navegador) e o app oferece **levar o
progresso do aparelho para a conta** ao entrar. Servidor: `server/auth-store.mjs`
(scrypt, sessões por aparelho, limite de tentativas); cliente: `web/src/lib/auth.ts`
(`useAuth`: `anon` → tela de entrar · `guest` · `signed`), tela `pages/Auth.tsx`,
gestão em **Ajustes → Conta** (`components/settings/AccountSection.tsx`: sair,
sincronizar, nome, senha, aparelhos conectados, excluir conta). A sessão vale
**offline** (token em `local:auth`, lido antes do 1º render em `main.tsx`); um 401 do sync
dispara `SESSION_EXPIRED_EVENT` → volta para `/entrar` **sem apagar** o progresso.
Regras que fazem a troca de conta ser segura (`adopt`/`logout` em `auth.ts`):
- `local:dataOwner` = a conta dona do progresso deste aparelho. Entrar com **outra**
  conta limpa antes (`wipeLocalData`, **sem** tombstones — a conta antiga continua
  inteira no servidor); mesma conta retoma sem mexer no cursor.
- **Sair limpa o aparelho** (depois de um sync final; sem rede e com pendências, a tela
  pergunta antes). A limpeza **apaga também o `local:deviceId`**: o servidor não devolve
  ao mesmo `deviceId` o que ele mesmo subiu (supressão de eco), então um aparelho limpo
  precisa ser um aparelho novo para receber a conta de volta.
- O **código de sincronização** antigo continua aceito pelo servidor (conta anônima =
  hash do código) mas não tem mais UI; a sessão tem preferência (`credential()` em
  `sync.ts`). Detalhes do protocolo e das regras de merge em [`server/README.md`](server/README.md).

**Ao mexer no estado do aluno, respeite a forma de cada tabela** (é ela que faz o merge
funcionar sem servidor esperto — ver `docs/architecture.md`):
- `reviewLog` / `immersionLog` são **eventos imutáveis** com `uid` global → nunca edite um
  evento no lugar; crie outro (e um tombstone, se for apagar).
- `cards` / `doseProgress` / `settings` são **estado**: toda escrita precisa atualizar
  `updatedAt`, senão a alteração perde o last-write-wins e some (vale inclusive para
  backfill de campo novo — ver `backfillCardTiers`).
- **Abrir uma dose não grava `doseProgress`**: a linha nasce na primeira fase concluída
  (`markPhaseDone`). Uma linha vazia carimbada só por abrir vencia, no last-write-wins,
  a conclusão feita pouco antes no outro aparelho ainda offline.
- **Ler-alterar-gravar de estado vai dentro de `db.transaction("rw", …)`.** Duas
  escritas soltas no mesmo tick leem a mesma versão e a última apaga a outra
  (foi assim que `completed`/`completedAt` da dose se perdiam). Ver
  `updateProgress` em `lib/progress.ts`.
- **Nunca volte a guardar contador do dia.** Agregados (revisões, palavras novas, minutos,
  doses concluídas) são derivados dos eventos em `dailyStats()` — um contador somado à mão
  dá número errado quando dois aparelhos estudam no mesmo dia.
- Apagar precisa virar `tombstone(kind, id)`, senão a próxima sincronização ressuscita.
  Ao aplicar um tombstone que **chega** do servidor, estado obedece ao mesmo
  last-write-wins (versão local mais nova que o apagar fica); evento é apagado de vez,
  salvo se foi restaurado de backup depois do apagar (`local:importedAt`).
- Configuração que não deve sair do aparelho usa o prefixo `local:` na chave. A **posição
  do vídeo** é uma dessas (`local:mediaPos:<doseId>`, `saveMediaPosition`): dentro de
  `doseProgress` ela carimbava a linha inteira a cada 5 s e fazia `completed` perder o
  last-write-wins para quem só estava revendo o vídeo.
- **Importar backup** carimba o estado com `updatedAt` de agora, zera o cursor da
  sincronização e limpa tombstones locais — o restaurado vence o servidor (`importAll`).

## Design (siga ao mexer no UI)

Regras em `docs/design-system.md`; tokens em `web/src/index.css`. Resumo:
**um acento** (teal — gradiente é proibido como decoração), **fundo chapado**
(nada de blob/aura; `.frosted` só nas barras fixas), **hierarquia por tamanho e
cor** (títulos em serifa Newsreader 400/500 — `font-extrabold` não existe),
**raio contido** (a escala `--radius-*` re-tuna todo `rounded-*`), **no máximo
dois acentos por tela**, **sem emoji na UI** (idioma se apresenta na própria
escrita: 한국어 / 日本語, nunca bandeira) e **ícone é sempre lucide** — nenhum
glifo de texto faz papel de ícone (o usuário rejeita explicitamente qualquer
coisa com "cara de IA": emoji, caixa alta espaçada, grade de tiles).
**O quadro do vídeo é a matéria visual** (redesign de 09/2026): capa da dose
(`media.posterSrc`) no Hoje, na trilha e na Biblioteca; cena da frase-exemplo
(`cards[].sceneSrc`) no verso do card — `python -m dose_factory frames` extrai.
**Duas vozes tipográficas**: idioma-alvo em sans (serifa coreana
`.font-target-display` só em destaque), tradução PT **sempre** em Newsreader
itálico (`.line-trans`). Neutros com tom: escuro verde-grafite `#12181a`, claro
papel `#f4f2ec`. `Card` só para objetos; seções vivem no fundo com filete.
**A linha da dose é o átomo visual**: fala em idioma-alvo + tradução + timecode
(`components/ui/DoseLine.tsx`) — abre o Hoje, estrutura o Prime, é a transcrição
e volta no verso do card. Telas de dados carregam com **esqueleto**, não spinner.
**Nunca use `layoutId` (framer-motion) dentro do `DosePlayer`**: a troca de fase é um
`AnimatePresence mode="wait"`, e um `layoutId` na subárvore trava a saída (tela vazia).
Na imersão a transcrição é **colapsável** (`T`; preferência `transcriptOpen`) e,
fechada, o vídeo volta ao centro. **Cinema** (`F` / botão de tela cheia, e automático
no celular em paisagem): player `fixed` preto com paleta escura forçada, legenda no
rodapé do quadro. No celular: régua de notas do card **`sticky`** no rodapé, dica de
tecla só com a variante `fine` (`md:fine:flex` — nunca `md:` sozinho, um celular em
paisagem passa de `md`), e `:active` esmaece botões em `(hover: none)`.

## Nível: TOPIK como régua (não como filtro)

Cada card carrega `topikLevel` (`"A"` TOPIK I 1–2급 · `"B"` 3–4급 · `"C"` 5–6급), vindo de
`pipeline/data/topik_ko.json` (국립국어원 + lista TOPIK 2015). Serve **só para medir** o nível
de evolução: a escolha dos 20 cards continua pela **frequência (de corpus) das palavras que
aparecem no próprio vídeo** — nunca ordene/filtre cards por `topikLevel`, senão a dose deixa
de ensinar o que o vídeo diz.
A pipeline publica a escada em `course.json` (`vocabLadder`) e o app lê de lá (`lib/levels.ts`,
seção "Nível" em `/progress`), então **nenhum número de nível fica embutido no app**.
Hoje: 140 palavras, 136 na faixa Básica = 7,3% do TOPIK I; ~94 lições fecham o A1–A2.

## Metodologia (cada Dose = 1 lição diária)

`Prime` (preview em PT ativa o contexto) → `Imersão` (vídeo nativo + legendas: alvo / PT /
ambas / **primed**) → `SRS` (flashcards FSRS das frases da dose) → `Produção` (planejado:
output + análise de erros). Ver `docs/methodology.md`. Espelha os *dojo skills* em
`../immersion/dojo-prompts/`.

## Regras de autoria de lição (o usuário definiu — siga à risca)

- **Comece pelo mais fácil que existir.** As primeiras lições são para quem nunca viu o
  idioma: vídeo *super iniciante* (A0), fala lenta, uma ideia por frase, apoio visual e
  repetição. Só depois subir de nível, e **de forma medida** — antes de escolher um vídeo,
  meça: palavras distintas por minuto, caracteres falados por segundo e a **mediana do rank
  de frequência** das palavras dele (`frequency.rank_map`). Um vlog nativo "de A1" costuma
  dar 15+ palavras novas por minuto: é degrau demais para o dia 1.
- **15–20 min** por lição, pegando o trecho **otimizado** de alta compreensão. Se **e só se**
  não existir um vídeo bom de ~15 min, emende **2 ou 3** vídeos numa lição só (mesmo nível,
  mesmo canal de preferência) e tire os 20 cards do conjunto. As origens ficam registradas
  em `source.parts[]`; os tempos da dose são sempre os do vídeo **concatenado**.
- **20 cards por dose = as 20 palavras de maior frequência** que aparecem no vídeo (forma
  de dicionário), medida pela **lista de frequência do idioma** (`frequency.py`;
  `data/freq_raw_<lang>.txt`; ko via kiwipiepy, ja via fugashi) — o vídeo define o
  conjunto candidato, a lista define a ordem; não é contagem dentro do vídeo.
  **Sem repetir** palavras de lições anteriores (dedup acumulado → i+1).
  Card: **frente** = a palavra por **TTS nativo** (edge-tts → `media/tts/<hash>.mp3`,
  campo `audioClipSrc`); **verso** (ao revelar) = significado PT + **frase-exemplo curta**
  (`best_example` pega a frase mais curta que contém a palavra) tocada por um **fragmento
  pré-cortado** (`media/frag/<hash>.mp3`, campo `exampleAudioSrc` — evita seek num vídeo
  grande) com a **palavra destacada** na frase (superfície real via offsets do kiwi, ex.
  하다→해) e o **rank de frequência** da palavra (`freqRank`, ex. 하다 = #1) mostrado no
  verso. A imersão mostra **todas** as legendas; só o SRS usa as 20 palavras.
  `newPerDay = 20` no app (1 lição/dia). Um card **só conta como visto** (vira registro no
  IndexedDB + soma no teto diário) **quando é avaliado** (De novo/Bom/…) — abrir ou pular a
  revisão não consome nada (`gradeNew` cria o registro no 1º grade; `buildDoseQueue` oferece
  as palavras não vistas). A fase de revisão **da dose** só mostra cards **dela**; vencidos
  de outras doses vão para a revisão avulsa (`/review`) e são anunciados no fim da dose.
  **No fim da fila, cards da própria sessão que já venceram de novo** ("De novo" volta em
  ~1 min pelo passo curto do FSRS) **voltam para o fim** (`relearnDue`), como no Anki — a
  sessão só fecha quando nada dela está vencido.
  Com o teto do dia estourado a fila vem vazia mas com `heldBack > 0` — a tela avisa
  que a cota acabou e **não oferece "Concluir"**: fechar ali marcaria como concluída
  uma lição com zero palavras aprendidas, e ela sumiria da trilha para sempre.
  Registros órfãos de builds antigos são auto-limpos na revisão — **só quando a dose
  some de verdade** (404 do próprio `dose.json`, ou fora do `course.json`), com tombstone,
  e **confirmado na fonte** (`resolveDose(…, fresh = true)` → `cache: "reload"`, que o SW
  serve rede-primeiro): o `course.json` em cache pode ser de antes de a dose existir.
  Falha de rede **ou 404 de `index.json`/`course.json`** (a pasta `content/` inteira fora
  do ar) nunca apaga card (o app é offline-first).
  **Vencer é evento de tempo, não de banco**: `lib/useDue.ts` agenda um timer para o
  próximo vencimento (e reavalia ao voltar o foco), então os cards aparecem sozinhos —
  nunca exija F5 do aluno ao mexer nessas telas.
  **Desfazer** (`undoGrade`, tecla `Z`) reverte a última nota por completo: estado FSRS, log e
  contadores do dia.
- **SRS no molde do Anki** (`lib/srs.ts`, ts-fsrs 5 = **FSRS-6**, 21 parâmetros):
  - **Passos de (re)aprendizado** configuráveis, padrão do Anki `1m 10m` / `10m`
    (`learningSteps`/`relearningSteps`; o `CardRecord` guarda `learning_steps`).
  - **Fila com prioridade**: aprendendo vencidos → vencidos em revisão (ordem
    `reviewOrder`: vencimento · mais esquecidos = menor retenção · aleatória) → novos
    (`newOrder`: misturados por igual · antes · depois). Cabeçalho mostra o que **falta**
    por tipo (novos / aprendendo / a revisar), não "x de N" — a fila cresce durante a sessão.
  - **Card em aprendizado volta no meio da sessão** assim que vence (`dueLearning` depois
    de cada nota, entra logo após o card em tela). No fim da fila, sem mais nada a fazer,
    os que vencem em até `learnAheadMin` (20 min, "learn ahead" do Anki) entram
    adiantados — é assim que os 20 novos ganham a 2ª passagem (Bom → 10 min) na mesma
    sessão. A sessão (e a dose) só fecha quando nada dela está vencido nem prestes a vencer.
    **O conjunto que "volta" vem do banco** (`QueueScope`: os cards da dose, ou do idioma
    na revisão avulsa) — nunca de uma lista em memória da sessão: uma recarga/aba
    descartada no meio da lição zerava essa lista, o learn-ahead trazia só 1–2 cards
    (avaliados de novo 3 s depois) e a dose fechava com 17 em aprendizado. Na
    `ReviewSession`, cada aparição na fila tem `uid` próprio, que é a `key` do
    `<Flashcard>` (a chave do card repetia componente já avaliado → botões mortos), a
    nota é calculada sobre o registro **fresco** do banco, e falha ao gravar mostra o
    erro e remonta o card em vez de travar em silêncio.
  - **Limites contados do log**, não por sessão: `maxReviewsPerDay` conta notas dadas
    hoje em cards que estavam em **revisão** (aprendizado não conta, como no Anki).
  - **O dia de estudo vira às 4h** (`DAY_ROLLOVER_HOUR` em `utils.ts`, como no Anki):
    revisar à 0h10 ainda é "hoje" — cota, streak e `day` dos eventos seguem essa régua.
  - **Vencimento por dia, não por cronômetro** (`dueOnDay`/`snapDue`): intervalo em
    dias (`scheduled_days ≥ 1`) vence no **início do dia de estudo** (4h), como no
    Anki — "1 d" dado às 22h já está vencido na manhã seguinte, e o botão mostra
    "1 d", não "6 h". Só os passos em minutos (`1m 10m`) guardam hora exata. O
    `elapsed_days` também conta em dias de estudo (o ts-fsrs conta por data UTC —
    `toFsrs(rec, elapsedFrom)` corrige). Registros antigos, backups e cards vindos
    de um aparelho com app antigo passam por `snapDueToDay` (migração Dexie v4,
    `importAll`, `sync.ts`) — que conta em dias de estudo, não em ms, para ser
    idempotente sobre um `due` já encaixado. `shiftDay` é ancorado ao **meio-dia** — à meia-noite o
    `dayKey` ainda cai no dia anterior.
  - **Adiar** (`-`, até o próximo dia: `buriedUntil`), **suspender** (`@`) e **reiniciar**
    (forget) no menu `⋯` do card; suspensos se reativam em `/progress`. Tempo de resposta
    é cortado em 60 s (`MAX_ANSWER_MS`).
  - **Info do card** no verso (retenção agora, intervalo, estabilidade, dificuldade,
    revisões, lapsos) e em `/progress` a seção **Retenção** (`lib/srsStats.ts`): retenção
    real (acertos em cards em revisão), estimada (média de R), previsão de vencimentos
    7 dias, botões dos últimos 30 dias.
  - **Parâmetros otimizáveis**: `/otimizar?lang=ko` é uma **página à parte** (`otimizar.html`
    → `src/optimize/`) que roda o otimizador do Anki (`fsrs-browser`, WASM + threads) num
    worker e grava `w` em `settings.srs` (sincroniza). Threads WASM exigem
    `SharedArrayBuffer`, logo página **cross-origin isolated**: o `server/` manda COOP/COEP
    **só** em `/otimizar` e COEP em `/assets/*` (script de worker sem COEP é bloqueado:
    `ERR_BLOCKED_BY_RESPONSE`); em dev o plugin em `vite.config.ts` faz o mesmo. Piso de
    400 revisões (o do Anki). "Reagendar cards" (`rescheduleAll`) repete o histórico de
    notas com os ajustes atuais, como o "reagendar ao mudar" do Anki.
- **Vídeo** para a imersão (não áudio).
- **Prime** = 0,1s antes de cada fala o vídeo **pausa** e mostra a legenda no **idioma
  nativo (PT)**; o aluno lê o significado, dá play e ouve a fala em idioma-alvo "às cegas"
  (a legenda some quando a fala começa). Ver `ImmersionPlayer.tsx` (modo "primed").
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
Listas de frequência em `pipeline/data/freq_raw_<lang>.txt` (OpenSubtitles/OPUS; swappable
por uma lista oficial). Cache de lema-frequência em `data/lemma_freq_<lang>.json`.

**Notas operacionais deste ambiente** (importantes):
- **YouTube bloqueia o IP** ("Sign in to confirm you're not a bot"). Roteie o yt-dlp pelo
  **Tor** já rodando: `--proxy socks5h://127.0.0.1:9050`; se o exit estiver marcado,
  `service tor restart` pega um circuito novo (o `.work/dlvideos.sh` faz isso em loop).
  Precisa do **deno** (`--js-runtimes deno`) + **yt-dlp nightly**.
- Vídeo do YouTube vem em **AV1** → **transcodifique para H.264** (`libx264` + `aac` +
  `-movflags +faststart`) para tocar em qualquer navegador.
- Detalhes completos em `pipeline/README.md`; artefatos em `pipeline/.work/`.

## Contrato de dados (`dose.json`, schemaVersion 1)

Único acoplamento entre pipeline e app. Fonte da verdade: `web/src/types/dose.ts` (TS) e
`pipeline/dose_factory/schema.py` (Python) — mantenha em sincronia. Invariantes:
- `id` = `<lang>-<level>-<NN>`, **estável** (é a chave do SRS; mudar "esquece" o progresso).
- Tempos em **ms** inteiros. Mídia por caminho relativo à pasta da dose.
- `segments[]` = todas as legendas de imersão; `cards[]` = 20 cards de palavra (forma de
  dicionário + significado PT + frase-exemplo + `sceneSrc`, o quadro do vídeo na frase);
  `primePreview[]` = blocos de prime em PT; `media.posterSrc` = capa (também copiada para o
  `DoseRef` do `course.json`, para Biblioteca/trilha não baixarem cada dose). Ambos opcionais.
- `segments[].tokens[]` = palavras de conteúdo da fala com posição e **lema = id do card
  sem `w-`**. É a ponte legenda ↔ SRS: a **legenda "conhecido/novo"** (opcional, Ajustes →
  Imersão ou o marcador no player: fixada limpa · aprendendo sublinhada · nunca estudada
  pontilhada) e a seção **Compreensão por lição** em `/progress` (% das ocorrências já
  fixadas, i+1 da próxima lição, minutos de imersão por lição — `immersionLog.doseId`)
  vivem em `lib/vocab.ts`. Dose publicada sem tokens: `python -m dose_factory tokens`.

Detalhes: `docs/dose-contract.md`.

## Status

- **1º idioma: Coreano 🇰🇷** — trilha A1 com **7 lições em vídeo**, 15–20 min, **20 cards de
  palavra** cada (140 palavras distintas, sem repetir). Todas de **histórias ilustradas A0**
  do canal **몰입한국어**, fala lentíssima, cada história repetida 2–3 vezes dentro da própria
  aula; cada lição emenda **2–3 histórias** num vídeo só (`source.parts[]`).
  01 família/casa · 02 números e horas · 03 passado e futuro · 04 estados e rotina ·
  05 clima e -어야 되다 · 06 -ㄹ 수 있다, hobbies e -고 싶다 · 07 -러 가다, viagem e 반말.
  A curva medida (car/s falados · palavras novas/min): **1,8→2,7 · 2,6→4,4** — contra
  4,3–7,3 car/s e 15 palavras/min dos vlogs nativos que abriam o curso antes.
- Dose **demo** em japonês (áudio) com 20 cards de palavra, como vitrine de UX.
- Roda em **produção** na porta 8000 pelo `server/` (serviço `imersa`):
  `cd web && npm run build && systemctl restart imersa`.
- **Contas** (e-mail + senha, sessões por aparelho) e **sincronização desktop ↔ celular**
  pela conta (09/2026). Convidado continua possível; código de sincronização é legado.
- Próximo: continuar a trilha de coreano (dias 4+). Ver `docs/roadmap.md`.

## Navegação (contrato de URL)

`/` Hoje · `/library` · `/progress` · `/settings` · `/review` (revisão avulsa) ·
`/entrar` · `/criar-conta` (conta; `?next=` volta para onde estava) · `/onboarding` ·
`/dose/:doseId?fase=prime|imersao|revisao|fim` · `/otimizar?lang=` (página separada,
fora do SPA — otimizador do FSRS). **A fase da dose vive na URL** —
recarregar mantém o lugar e o Voltar do navegador anda entre as fases. Sem
`?fase`, dose já concluída abre na **imersão**. Ver `docs/architecture.md`.

## Reset de progresso local

O estado do aluno mora no IndexedDB do navegador. Reset por URL: `?reset=<lang>` zera um
idioma (ex.: `http://localhost:8000/?reset=ko`), `?reset=all` zera tudo — depois redireciona
pra URL limpa. Também em **Ajustes → Reiniciar este idioma / Apagar tudo** (`resetLanguage`/`resetAll` em `db.ts`).
Com sincronização ligada, o reset **se propaga** (grava tombstones), então zerar num aparelho
zera nos outros — é para ser assim, mas vale avisar antes de sugerir um reset.

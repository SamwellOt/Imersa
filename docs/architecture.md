# Arquitetura & decisões técnicas

## Visão geral

```
                 ┌──────────────────────── pipeline/ (Python) ───────────────────────┐
   vídeo/URL ──▶ │ download → Scribe → frases → tradução PT → prime → words(freq) │──┐
                 └────────────────────────────────────────────────────────────────────┘  │
                                                                                          ▼
                                                                          content/<lang>/<level>/<NN>/dose.json + media
                                                                                          │
                 ┌──────────────────────── web/ (React SPA) ──────────────────────────┐   │
   navegador ◀── │ Dashboard · ImmersionPlayer(primed) · SRS(FSRS) · Progresso        │◀──┘
                 │ estado local: Dexie/IndexedDB  ·  agendamento: ts-fsrs             │
                 └───────────────────┬───────────────────────────────────────────────┘
                                     │ POST /api/sync (conta logada ou código)
                 ┌───────────────────▼───────────────────────────────────────────────┐
                 │ server/ (Node, sem dependências) — serve o app + content/ +       │
                 │ contas (/api/auth/*) + espelha o progresso num SQLite por conta   │
                 └───────────────────────────────────────────────────────────────────┘
```

O app é **offline-first**: todo o conteúdo é estático (JSON + mídia) e todo o
estado do aluno (agendamento SRS, progresso, streak, settings) mora no navegador
via IndexedDB. O servidor **não está no caminho crítico**: sem rede (ou sem conta —
o aluno pode seguir como convidado) o app funciona igual; a sessão da conta vale
offline e a sincronização é um espelho oportunista por cima. Ao entrar/sair, o
progresso local segue a conta dona dele (`local:dataOwner`) — ver `web/src/lib/auth.ts`. A pipeline roda offline pelo mantenedor para produzir conteúdo.

## Decisões

**Por que SPA local (Vite) e não Next/full-stack?**
É um projeto local, mono-usuário. Zero backend no caminho do aluno = funciona
offline, e o estado do aluno é privado por natureza. Conteúdo estático servido do
disco. O multi-device chegou como uma camada opcional por cima (ver abaixo), sem
mexer em como o app lê e escreve o próprio estado.

**Como o multi-device funciona sem virar um backend de verdade?**
Três decisões seguram a complexidade:
1. **O servidor é burro.** Ele guarda registros `(conta, tipo, id)` com um `seq`
   crescente e não entende nada de FSRS. Toda a lógica continua no cliente.
2. **Cada tabela tem uma forma de merge decidida no desenho do dado**, não em
   runtime: `reviewLog`/`immersionLog` são **eventos imutáveis** com id global
   (merge = união); `cards`/`doseProgress`/`settings` são **estado** com
   `updatedAt` (last-write-wins). Empate de relógio nunca corrompe: no pior caso
   um `updatedAt` mais novo ganha, e o histórico de eventos fica intacto.
3. **Contador do dia virou derivado.** Antes existia uma tabela `dailyStats` com
   `reviews`/`newCards`/`immersionMs` somados à mão. Isso é justamente o tipo de
   dado que quebra em dois aparelhos (5 no desktop + 4 no celular daria 5 ou 4,
   nunca 9). Agora os agregados são calculados dos eventos (`dailyStats()` em
   `lib/db.ts`), então somam sozinhos e o "desfazer" se corrige de graça.

O cursor da sincronização é o `seq` **do servidor**, não um horário — assim os
relógios dos aparelhos não precisam estar em sincronia para nada além do
desempate de last-write-wins. Ele só é zerado quando o **código ou a URL mudam de
valor** (conta nova = `seq` sem relação com o antigo): o campo de Ajustes salva a
cada `blur`, e zerar em toda saída de foco fazia o aparelho rebaixar a conta
inteira do servidor sem motivo. Apagar também viaja (tabela `tombstones`), senão a
próxima sincronização traria de volta o que você acabou de zerar.

Ao **aplicar** um tombstone que chega do servidor, estado (`cards`, `doseProgress`,
`settings`) obedece ao mesmo last-write-wins: uma versão local **mais nova** que o
apagar fica (antes o apagar vencia sempre, e um reset num aparelho engolia o que o
outro estudou offline — que depois subia e ressuscitava lá). Evento é apagado de
vez, salvo se foi restaurado de backup depois do apagar (`local:importedAt`).

**Importar backup** (`importAll`) trata o restaurado como a verdade: estado recebe
`updatedAt` de agora (vence o servidor), o cursor volta a zero (tudo sobe e tudo
desce de novo) e os tombstones locais pendentes somem. Antes os carimbos antigos
eram mantidos e nada subia — a primeira descida do servidor desfazia a importação.
A subida no `pagehide` usa `fetch({ keepalive })` em lotes < 60 KB, e um pedido de
sincronização feito durante outra em curso roda logo em seguida (o que foi gravado
durante a subida não estava no lote).

**Por que Dexie/IndexedDB e não localStorage?**
O SRS precisa de consultas por "vencido até agora", contadores, e potencialmente
milhares de registros de review — IndexedDB indexa e escala; localStorage não.

**Por que `ts-fsrs` e não SM-2 caseiro?**
FSRS é o algoritmo de agendamento moderno (padrão atual do Anki), com melhor
retenção por review. Reimplementar a matemática à mão é fonte de bugs sutis;
`ts-fsrs` é a implementação de referência em TypeScript. Encapsulado em
`src/lib/srs.ts` para poder trocar depois.

**Por que a fábrica de doses é separada (Python)?**
Os *dojo skills* já são Python + CLIs (yt-dlp, subs2cia, fugashi, ffmpeg). Manter a
pipeline em Python reaproveita tudo isso diretamente, sem reescrever. O app não
depende dela em runtime — só do `dose.json` resultante.

**Contrato explícito (`dose.json`).**
As duas metades só se falam pelo formato em [`dose-contract.md`](dose-contract.md).
Isso permite evoluir pipeline e app de forma independente e testar cada um isolado.

## `web/` — camadas

| Camada | Arquivos | Responsabilidade |
|---|---|---|
| **Tipos/contrato** | `src/types/dose.ts` | Espelha o `dose.json`. |
| **Dados** | `src/lib/content.ts` | Carrega `index.json` / `course.json` / `dose.json`, resolve caminhos de mídia. |
| **Persistência** | `src/lib/db.ts` | Schema Dexie: `cards` (estado SRS, com `learning_steps`, `suspended`, `buriedUntil`), `reviewLog`, `immersionLog`, `lineMarks` (evento «não entendi»), `doseProgress`, `settings`, `tombstones`. Card também guarda `known` («já sei») e `origin` ("extra" = "+ card", "sentence" = frase i+1 — fora do teto de novos). |
| **SRS** | `src/lib/srs.ts` | Agendador FSRS-6 (ts-fsrs 5) com passos de aprendizado, fila com prioridade (aprendendo → vencidos → novos), learn-ahead, notas/desfazer, adiar/suspender/reiniciar, reagendamento por histórico. |
| **Vocabulário pela legenda** | `src/lib/vocab.ts` | Junta `segments[].tokens` (lema = id do card sem `w-`) ao estado FSRS: status por palavra (fixada / aprendendo / nunca), cortes para marcar a legenda, cobertura por lição (ocorrências e distintas). |
| **Estatísticas SRS** | `src/lib/srsStats.ts` | Retenção real/estimada, previsão de vencimentos, botões, estados — derivado do log, nunca armazenado. |
| **Otimizador** | `otimizar.html`, `src/optimize/*`, `src/lib/fsrsTrain.ts` | Página isolada (COOP/COEP) que treina os parâmetros do FSRS com `fsrs-browser` (WASM + threads) num worker. |
| **Estado de UI** | `src/lib/store.ts` | Zustand: idioma ativo, sessão em andamento, preferências de legenda. |
| **UI** | `src/components/ui/*` | Primitivas do design system (Button, Card, Segmented…). Ver [`design-system.md`](design-system.md). |
| **Telas** | `src/pages/*`, `src/components/{layout,player,srs}/*` | Shell, player de imersão, sessão de SRS. |
| **Tokens** | `src/index.css` | Cores/tipografia/raio como CSS vars + `@theme inline`. |

## Fluxo de uma sessão diária

1. App lê `index.json` → idioma ativo → `course.json` → próxima dose não concluída.
2. **Prime**: renderiza `primePreview`.
3. **Imersão**: `ImmersionPlayer` toca `media.src`, sincroniza `segments[]` por
   `currentTime`, aplica o modo de legenda escolhido. A posição é salva a cada ~5s
   na chave **local** `local:mediaPos:<doseId>` (`saveMediaPosition`) e **relida ao
   reabrir a dose** (o player oferece "voltar ao início"). Ela morava em
   `doseProgress.lastMediaPositionMs`, mas cada gravação carimbava o `updatedAt` da
   linha inteira e, no last-write-wins, rever o vídeo num aparelho apagava o
   `completed` que o outro tinha acabado de gravar; retomar o vídeo é coisa de cada
   aparelho, então a chave não viaja (o campo antigo só é lido como fallback).
   Chegar ao **fim** do vídeo (`ended`) grava posição 0 — senão a próxima abertura
   "retomava" no último segundo. A legenda de uma fala sobrevive só 1,5 s depois do
   `endMs` dela (`STICKY_MS`): cobre o vão entre falas sem ficar presa por cima de
   uma vinheta de 20 s.
   No modo **primed** a pausa 0,1 s antes de cada fala é um `setTimeout` calculado
   do tempo da mídia e da velocidade — o caminho por quadro (rAF) fica como
   reserva, porque em aba de fundo o rAF para e a fala passava sem pausar.
   O rAF de sincronia só roda enquanto a mídia toca.
4. **Review**: a fila (`buildDoseQueue`) tem **escopo fechado nesta dose** — as
   palavras ainda **não vistas** dela (dentro do teto diário) + as **dela** que
   venceram. Vencidos de outras doses ficam para `/review`; a tela de conclusão
   avisa quantos são (`countDueElsewhere`) para eles não sumirem da vista. Um card **só vira registro no IndexedDB (e conta no teto diário)
   quando é avaliado** (De novo/Bom/…) — abrir ou pular não conta nada (`gradeNew` cria o
   registro no 1º grade). Registros órfãos (de builds antigos) são auto-limpos — mas
   **só quando o conteúdo respondeu que a dose/card não existe mais** (`DoseMissingError`:
   404 do próprio `dose.json`, ou id fora do `course.json`), nunca quando a busca falha
   por rede nem quando `index.json`/`course.json` dão 404 (é a pasta `content/` inteira
   fora do ar — disco desmontado, deploy pela metade): sendo o app offline-first, apagar
   aí destruiria progresso real e a perda ainda viajaria na sincronização. E a resposta
   tem de vir **da fonte**: antes de apagar, a revisão refaz a busca com
   `resolveDose(lang, id, fresh = true)` (`cache: "reload"`, que o service worker
   honra como rede-primeiro) — o `course.json` guardado pelo SW e pela sessão pode ser
   de antes de a dose existir, e os cards que o outro aparelho estudou nela chegavam
   pela sincronização e eram apagados na primeira abertura de `/review`. A limpeza grava `tombstone("card", key)`, senão a próxima
   sincronização ressuscitaria o órfão. Cada `grade` chama ts-fsrs e
   persiste o próximo `due` — **por dia** quando o intervalo é em dias
   (`scheduled_days ≥ 1`): o card vence no **início do dia de estudo** (4h,
   `dueOnDay`), não na mesma hora da revisão, como no Anki; só os passos em minutos
   têm hora exata. `toFsrs(rec, elapsedFrom)` faz o `elapsed_days` contar dias de
   estudo (o ts-fsrs conta `floor(ms / 24 h)`). Vencimentos gravados com hora exata
   (antes desta regra, backup, aparelho com app antigo) passam por `snapDueToDay`
   na migração Dexie v4, em `importAll` e ao receber cards na sincronização — e por
   isso ela conta em **dias de estudo** (`daysBetween` de `dayKey`), não em ms: é
   idempotente sobre um `due` já encaixado (em ms, um card revisado depois das 16h
   perdia um dia de intervalo a cada aparelho que o recebia).
   A fila segue o **Anki** (`assemble` em `srs.ts`): cards em aprendizado vencidos
   primeiro, depois os vencidos em revisão na ordem escolhida (vencimento com sorteio
   dentro do dia · menor retenção primeiro · aleatória), novos misturados por igual (ou
   antes/depois). Depois de **cada nota**, `dueLearning` confere os cards em aprendizado
   do **escopo** que já venceram de novo (um "De novo" volta em ~1 min pelo passo `1m`)
   e os insere logo após o card em tela. No **fim da fila**, sem mais nada a fazer,
   entram também os que vencem em até `learnAheadMin` (20 min, "learn ahead") — é a 2ª
   passagem dos novos (Bom → passo `10m`) na mesma sessão. A sessão (da dose ou avulsa)
   só termina quando nada do escopo está vencido nem prestes a vencer. O cabeçalho
   mostra o que **falta** por tipo, não "x de N", porque a fila cresce e encolhe.
   O escopo (`QueueScope`) é **lido do banco** a cada conferência — os cards da dose na
   fase da dose, os do idioma na revisão avulsa. Antes era um `Set` em memória com o
   que a sessão tinha avaliado: uma recarga (ou a aba descartada pelo celular) no meio
   da lição zerava o conjunto, o learn-ahead só trazia o que foi avaliado depois da
   recarga (1–2 cards, reapresentados 3 s depois da nota) e a dose fechava com quase
   todos os cards em aprendizado. Detalhes da `ReviewSession`: cada aparição na fila
   tem um `uid` (a `key` do `<Flashcard>` — com a chave do card, um card que voltava
   em seguida ou o "desfazer" reaproveitava um componente já avaliado, e os botões
   morriam); a nota é calculada sobre o registro fresco do banco (`db.cards.get`), não
   sobre o `rec` guardado no item; a tela de fim só aparece depois de a conferência
   terminar (`settledFor`), e uma falha ao gravar/consultar vira aviso com "tentar de
   novo" em vez de card morto.
   Se o teto diário de palavras novas já acabou, a fila da dose vem **vazia com
   `heldBack > 0`**: a tela diz que a cota do dia acabou e **não oferece
   "Concluir"** — fechar ali marcaria como concluída uma lição com zero palavras
   aprendidas, e ela sumiria da trilha para sempre.
5. Ao concluir as 3 fases, marca `doseProgress` e atualiza streak.

**Toda escrita em `doseProgress` passa por uma transação** (`updateProgress` em
`lib/progress.ts`). Ler-alterar-gravar solto se atropelava: `markPhaseDone` e
`completeDose` disparados no mesmo tick liam a mesma versão da linha e a última
a gravar apagava a alteração da outra — dose concluída que voltava a aparecer
como pendente, com `completedAt` perdido (some do streak e de `dailyStats`). O
IndexedDB serializa transações `rw` de mesmo escopo, então agora elas entram em
fila. O `mutate` devolve `null` quando não há o que mudar, para ler não virar
escrita nem gerar mudança à toa para a sincronização carregar.

**A fase vive na URL** (`/dose/:id?fase=prime|imersao|revisao|fim`): recarregar
mantém o lugar, o botão Voltar do navegador anda entre as fases em vez de sair da
dose, e dá para linkar direto para a imersão. Sem `?fase`, uma dose **já
concluída** abre na **imersão** (rever o vídeo é o motivo de reabrir); as demais,
no Prime. O idioma da dose sai do prefixo do id (`langOfDoseId` em `lib/content.ts`,
`ko-A1-01` → `ko`), não do idioma ativo: um link de lição do outro idioma abre em vez
de dar "Dose não encontrada".

**Atalhos de tecla** (player, flashcard, escuta) ignoram teclas com Ctrl/⌘/Alt
(`hasShortcutModifier` em `lib/hooks.ts`; Ctrl+Alt = AltGr passa): antes Ctrl+F
também abria a tela cheia, Ctrl+R repetia a fala e Ctrl+1…4 dava nota ao card.
A exceção é o Ctrl+Z da revisão, que é desfazer de propósito.

**Dia de estudo às 4h** (`DAY_ROLLOVER_HOUR`, `utils.ts`). `dayKey()` desloca 4 h
antes de pegar a data, como o "next day starts at" do Anki: a cota de novos, o teto de
revisões, a sequência e o `day` gravado nos eventos seguem a mesma régua. Eventos
antigos mantêm o `day` que já tinham (só o futuro muda). **"Dia com estudo"** tem
uma régua só, `dayIsActive` em `lib/progress.ts` (alguma nota, ≥ 1 min de imersão
ou dose concluída): sequência, faixa da semana no Hoje e quadro de 28 dias leem
dela — antes divergiam e dava "3 dias seguidos" com quadradinho cinza. `nextDayStart()` é o alvo do
"adiar para amanhã" (`buriedUntil`).

**Limites diários vêm do log.** `newPerDay` conta primeiras notas de hoje;
`maxReviewsPerDay` conta notas de hoje em cards que estavam em **revisão** (aprendizado
não conta) — abrir a tela três vezes não triplica o teto. Tempo de resposta gravado é
cortado em 60 s (`MAX_ANSWER_MS`), como no Anki.

**Otimizador do FSRS em página isolada** (`/otimizar`). O `fsrs-browser` (fsrs-rs, o
mesmo motor do Anki) roda em WASM com threads, o que exige `SharedArrayBuffer` e,
portanto, um documento *cross-origin isolated*. Ligar COOP/COEP no app inteiro
bloquearia qualquer recurso externo sem CORP; por isso a página é um segundo entry do
Vite (`otimizar.html`), fora do SPA, e o `server/` só manda `Cross-Origin-Opener-Policy:
same-origin` + `Cross-Origin-Embedder-Policy: require-corp` nela. **Todo `/assets/*`**
também sai com COEP: o script de um worker criado por página isolada precisa trazer o
cabeçalho, senão o navegador o bloqueia (`ERR_BLOCKED_BY_RESPONSE`) — foi por isso que
o `VERSION` do service worker subiu para v2 (cache antigo sem o cabeçalho). O treino roda
num worker (`train.worker.ts`) que devolve a memória compartilhada para a página ler o
progresso (`getProgress`); o log vai no formato de revlog do Anki (`fsrsTrain.ts`:
cid/ease/id/type + `minute_offset` = fuso − 4 h). O resultado grava `w` em
`settings.srs` (viaja na sincronização) e, se pedido, `rescheduleAll` repete o histórico
de cada card com os novos parâmetros (`fsrs.reschedule`).

**Reatividade temporal** (`web/src/lib/useDue.ts`). `useLiveQuery` reage a
escritas no IndexedDB, mas um card *vencer* não é uma escrita — é o relógio
passando. Sem isso o aluno precisava recarregar a página para os cards
aparecerem. `useDueTick` agenda um `setTimeout` para o **exato instante do
próximo vencimento** (`nextDueAt`), reagendado sempre que o banco muda (avaliar
um card muda qual é o próximo, e um "De novo" pode adiantá-lo de 10 min para 1),
com teto de 10 min por soneca, piso de 1 min quando não há nada agendado, e
reavaliação imediata em `visibilitychange` / `focus` (timers sofrem throttling
em aba de fundo e não sobrevivem a suspensão do aparelho). `useDueCount` compõe
os dois.

O relógio é **um por idioma, compartilhado** por todos os componentes: o
contador aparece em três lugares ao mesmo tempo (barra lateral, barra de baixo
no celular e o Hoje), e um timer por componente eram três despertadores e três
varreduras da tabela `cards` por tique, todos para chegar ao mesmo número. Ele
acorda por dois motivos e precisa dos dois — o tempo passou (`setTimeout`) e o
banco mudou (`liveQuery`, fora do React).

Quem usa: badge da navegação, dashboard e a `ReviewSession` avulsa. Na tela
"nada para revisar" a fila **carrega sozinha**; na tela de conclusão aparece uma
oferta *"Revisar mais N"* — reiniciar a sessão sozinho na cara de quem acabou de
terminar seria hostil. A fase de revisão **da dose** não participa: a fila dela
é fechada e terminar significa fim da lição.

**Desfazer.** `gradeCard`/`gradeNew` devolvem um `GradeResult` com o estado
anterior do card e o id da linha de log; `undoGrade` restaura o card (ou o apaga,
se ele nasceu naquela nota), remove o log e devolve os contadores do dia. A
`ReviewSession` mantém a pilha da sessão.

**Animação de fase.** As fases da dose trocam dentro de um `AnimatePresence
mode="wait"` (`DosePlayer`). **Nada com `layoutId` (framer-motion) pode viver dentro
dessa subárvore**: um `layoutId` no indicador do `Segmented` fazia a saída da imersão
nunca "completar" depois de qualquer clique no seletor de legendas — a fase seguinte
não montava e a tela ficava vazia. O `Segmented` é CSS puro por isso.

**Offline / PWA.** `public/manifest.webmanifest` (instalável, `display: standalone`)
+ `public/sw.js`, registrado só em produção. Política de cache:

| Recurso | Estratégia |
|---|---|
| App shell (`/`, `index.html`) | rede primeiro, cache como reserva offline (só a navegação do SPA; `/otimizar` é outra página e **não** vira shell nem poda assets) |
| `/assets/*`, `/icons/*` (hash no nome) | cache primeiro |
| `/content/**.json` | stale-while-revalidate (regerar dose atualiza sozinho); com `cache: "reload"` no fetch, rede primeiro — é como o app confirma que uma dose sumiu |
| Áudio curto dos cards (`.mp3`) | cache primeiro |
| Capas e cenas (`/content/**.jpg`) | cache primeiro (pequenas, nome com hash) |
| **Vídeo (`.mp4`) e qualquer `Range`** | **nunca passa pelo SW** |

O vídeo fica de fora de propósito: são dezenas de MB pedidos por `Range` (seek).
Cacheá-lo estouraria a cota e quebraria a barra de progresso.

**Ritmo diário.** O dashboard detecta se alguma dose foi concluída **hoje**
(`doseProgress.completedAt`) e troca o hero por "dose de hoje concluída", com
acesso a revisar, rever a imersão ou adiantar a próxima — informa, não bloqueia.

## Rodando

- App (dev): `cd web && npm install && npm run dev` (http://localhost:5173).
- App (produção): `cd web && npm run build && npm run serve` (http://localhost:8000) — quem
  serve é o `server/`, que entrega app + `content/` + `/api/sync` na mesma origem. Como
  serviço: `systemctl restart imersa` (log em `/var/log/imersa.log`).
- Conteúdo: em dev, servido de `content/` via symlink `web/public/content → ../../content`;
  em produção, lido direto de `content/` pelo `server/` (trocar uma dose não pede rebuild).
- Pipeline: `cd pipeline && ./setup.sh` (venv + deps: fugashi, unidic-lite, kiwipiepy, genanki).

# Roadmap & status

## Feito (estrutura e moldes)

- [x] Monorepo + documentação (metodologia, contrato de dados, arquitetura).
- [x] Contrato `dose.json` idioma-agnóstico (v1) + `index.json` / `course.json`.
- [x] **App do aluno** (Vite + React + TS + Tailwind), UI/UX completo:
  - [x] Onboarding / seleção de idioma e nível.
  - [x] Dashboard (dose do dia, streak, cards vencidos, progresso).
  - [x] Fluxo da Dose: **Prime → Imersão → Review**.
  - [x] `ImmersionPlayer`: legendas sincronizadas, 5 modos (alvo/PT/ambas/**primed**/off),
        **barra de progresso arrastável** (mouse + toque), velocidade, loop/repetição de linha.
  - [x] **Prime**: pausa 0,1s antes de cada fala e mostra a legenda em **PT (nativo)**;
        play → ouve a fala em idioma-alvo "às cegas".
  - [x] SRS com **FSRS** (ts-fsrs): **20 cards de palavra por frequência** (dedup entre lições),
        fila de vencidos, intake de cards novos.
  - [x] Progresso/estatísticas, settings, export/import de progresso.
  - [x] **Design system** editorial (um acento, fundo chapado, serifa nos títulos,
        sem gradiente/glass) — ver [`design-system.md`](design-system.md).
  - [x] **Fluxo**: fase da dose na URL (`?fase=`), retomada da posição do vídeo,
        dose concluída reabre na imersão, dashboard reconhece o ritmo diário.
  - [x] **Revisão**: desfazer a última nota (reverte FSRS + log + contadores).
  - [x] **SRS no molde do Anki**: FSRS-6 (ts-fsrs 5) com passos de aprendizado
        (`1m 10m` / `10m`), fila aprendendo → vencidos → novos com ordens configuráveis,
        card em aprendizado volta no meio da sessão, learn-ahead (20 min), limites contados
        do log, dia virando às 4h, adiar/suspender/reiniciar card, info do card no verso,
        seção **Retenção** (retenção real/estimada, previsão, botões) e **otimizador de
        parâmetros** (`/otimizar`, fsrs-browser em página isolada) + reagendar por histórico.
  - [x] Erro de mídia com retry, atalhos de teclado visíveis, `<title>` por rota,
        tema aplicado antes da primeira pintura (sem flash).
  - [x] **Fila da dose com escopo fechado** nas palavras dela (vencidos de outras
        doses vão para `/review`, com aviso na tela de conclusão).
  - [x] **Biblioteca**: busca sem acento + filtro (todas/pendentes/concluídas),
        atalhos `/` e `Esc`.
  - [x] **PWA**: instalável (manifest + ícones) e utilizável offline via service
        worker — vídeo sempre da rede.
  - [x] **Cards vencidos aparecem sozinhos** (sem F5): timer agendado para o
        próximo vencimento + reavaliação ao voltar o foco (`lib/useDue.ts`).
  - [x] **Relearn na sessão**: card reprovado volta no fim da mesma fila
        (`relearnDue`); nota dupla barrada; "Próxima dose" remonta a dose
        (`key={doseId}`); `?fase=fim` só em dose concluída; Prime por `setTimeout`.
  - [x] **Sync mais seguro**: tombstone recebido respeita o last-write-wins,
        importar backup vence o servidor (cursor zerado), posição do vídeo é
        local (`local:mediaPos:*`), `keepalive` no fechamento, limpeza de órfãos
        só com 404 do próprio `dose.json`.
- [x] **Contas** (09/2026): cadastro e-mail + senha, sessões por aparelho (scrypt, token
      hasheado, limite de tentativas), `Ajustes → Conta` (sair, senha, aparelhos, excluir),
      convidado sem conta, "levar o progresso do aparelho para a conta" ao entrar. A
      sessão vale offline; 401 no sync manda para `/entrar` sem apagar nada.
- [x] **Sincronização entre aparelhos** (desktop ↔ celular): `server/` em Node puro
      (sem dependências) serve o app + `content/` + `POST /api/sync`; conta = código de
      sincronização (hash, sem cadastro). Offline-first preservado — o servidor não está
      no caminho crítico. Merge sem CRDT: eventos imutáveis (`reviewLog`/`immersionLog`)
      + last-write-wins com `updatedAt` (`cards`/`doseProgress`/`settings`) + tombstones;
      contadores do dia viraram **derivados** dos eventos (dois aparelhos no mesmo dia
      somam em vez de sobrescrever). Roda como serviço `imersa`.
- [x] **Fábrica de doses** (Python): `prep` → `words` (top-20 por frequência) → `assemble`,
      além de `build` (URL) e `build-local`; emite `dose.json` + mídia.
- [x] **Dose demo** em japonês gerada do material de exemplo (`../immersion/`).
- [x] Roda em **produção** (build otimizado servido na porta 8000).

## 1º idioma oficial: Coreano 🇰🇷 (feito)

Trilha **A1 (iniciante)** com 7 lições em **vídeo**, 15–20 min, **20 cards de
palavra** (as de maior frequência que aparecem no vídeo, sem repetir entre lições)
cada. O curso foi **refeito do zero para quem começa do absoluto zero**:
saíram os vlogs nativos (densos demais — a A1-01 antiga tinha 237 palavras distintas
em 15 min, a 15,3 palavras novas por minuto) e entraram **histórias ilustradas A0**
do canal **몰입한국어 (Immersion in Korean)**: fala lentíssima, uma ideia por frase,
cada história repetida 2–3 vezes na própria aula, e desenho na tela para cada frase.

Cada lição emenda **2 histórias** num só vídeo (nenhuma história sozinha chega aos
15 min) — ver `source.parts[]` no [contrato](dose-contract.md).

| # | lição | min | gramática nova | car/s | palavras novas/min |
|---|---|---|---|---|---|
| 01 | Em casa com a família da Yunji | 18:22 | 이에요 · 에 있어요 · 에 가요/와요 · 안 | 1,8 | 2,6 |
| 02 | Contando: cinco sorvetes, dez tangerinas e as horas | 15:55 | números nativos + 개 · 주세요 · 몇 시 | 1,9 | 2,6 |
| 03 | Ontem, hoje e amanhã | 17:22 | **passado** -았/었어요 · **futuro** -(으)ㄹ 거예요 · -한테 | 2,4 | 2,7 |
| 04 | A noite antes da prova (e um dia cheio) | 15:15 | adjetivos de estado · -하고 (com) · -고 (e) | 2,1 | 4,4 |
| 05 | Que tempo faz — e o que você precisa fazer | 15:18 | **-어야 되다** (precisar) · 어때요 · 그래서 | 2,2 | 4,0 |
| 06 | O que você consegue fazer, o que você gosta de fazer | 20:09 | **-(으)ㄹ 수 있다** · -는 거 · -고 싶다 · -(으)면 | 2,3 | 4,4 |
| 07 | Viajar: para quê, como e quanto | 15:10 | **-(으)러 가다** · -까지 · 얼마나 걸리다/들다 · **반말** | 2,7 | 3,6 |

São **140 palavras distintas**, sem nenhuma repetida entre lições. A curva sobe onde
deve: a velocidade de fala vai de **1,8 a 2,7 caracteres por segundo** e a densidade de
vocabulário de **2,6 a 4,4 palavras novas por minuto** — contra os **4,3–7,3 car/s e 15,3
palavras/min** dos vlogs nativos que abriam o curso antes. A 07 é a primeira com fala
informal (반말) e ritmo perto do natural: é o degrau para o A2.

Uma exceção anotada: a 06 tem 20:09 (emenda 3 histórias) — 9 segundos acima da regra dos
15–20 min, mantidos porque a terceira história é o que fecha os 20 cards novos.

Regras adotadas: imersão mostra **todas** as legendas; o SRS usa as **20 palavras de
maior frequência** que aparecem no vídeo (forma de dicionário, via lista de
frequência — kiwipiepy/fugashi), **sem repetir** entre lições (i+1). Mídia em vídeo
H.264. Geração documentada em `pipeline/README.md`.

### Régua de nível: TOPIK

O progresso do aluno é medido contra uma **escada de vocabulário real**, não contra
um rótulo. A tabela vem de duas listas públicas — 국립국어원 «한국어 학습용 어휘 목록»
e a lista oficial do TOPIK de 2015 — unidas em `pipeline/data/topik_ko.json`; quando
elas discordam do nível de uma palavra, vale a mais básica.

| faixa | TOPIK | CEFR | palavras | já no curso | lições p/ fechar |
|---|---|---|---:|---:|---:|
| Básico | TOPIK I · 1–2급 | A1–A2 | 1.866 | 136 | 94 |
| Intermediário | TOPIK II · 3–4급 | B1–B2 | 3.874 | 4 | 194 |
| Avançado | TOPIK II · 5–6급 | C1–C2 | 902 | 0 | 46 |

**Onde as 7 lições colocam o aluno:** 140 palavras, **136 delas na faixa Básica**
(97%) — ou seja, 7,3% do vocabulário do TOPIK I, em 118 min de vídeo (16,8 min por
lição). No ritmo de 1 lição/dia (20 palavras novas), faltam **87 lições ≈ 2,9 meses**
para fechar a faixa Básica inteira e chegar ao teto do TOPIK I.

Isso também dá o alvo de conteúdo: **~94 lições cobrem o A1–A2 completo**. É o número
que orienta quantas doses ainda precisam ser produzidas antes de mudar de nível.

**`topikLevel` é régua, não filtro** — ver a regra em [`dose-contract.md`](dose-contract.md).
A escolha dos 20 cards continua sendo por frequência dentro do próprio vídeo; ordenar
os cards por nível TOPIK faria a dose deixar de ensinar o que o vídeo realmente diz.
A pipeline publica a escada em `course.json` (`vocabLadder`) e o app lê de lá — trocar
a lista de referência é mudar um arquivo de dados, não o código.

### Próximas lições de coreano
- [ ] Continuar do dia 8 em diante. Candidatas já medidas e ainda **não usadas** (mesmo
      canal, com o rendimento de palavras novas já calculado por
      `pipeline/.work/scout_next.py`): `q4T71z00wn0` 생일 선물 (33 novas — o maior
      rendimento restante), `en2bzdALQYo` 주사를 안 좋아해요 (27), `zlqdzMH5xNs` 한 입만 (23),
      `ct57VMooh3s` 룸메이트 (18), `SjLWGeIbvEI` 까만 고양이 (19), `ffXdENqhAJ4`
      달리면서 노래해요 (15, traz -(으)면서), `83P2JgWeKBs` Yoonji & Dad (honorífico -시-),
      `Ql1iv81vSFM` 스테이크를 뭐로 먹어요 (partícula -로), `1czfXitUggU` 당근 빼고 주세요.
      **Atenção:** o rendimento cai a cada lição (as palavras mais frequentes já foram);
      rode o `scout_next.py` antes de escolher, para não montar uma lição que não fecha
      20 cards novos.
- [ ] Revisar traduções pontuais e adicionar romanização/leitura opcional.
- [x] ~~Trocar a lista de frequência por uma oficial~~ — resolvido de outro jeito: a lista
      oficial entrou como **régua de nível** (TOPIK/국립국어원), e a frequência continua
      escolhendo os cards dentro do vídeo. São papéis diferentes.
- [ ] Estender a régua ao japonês (JLPT) — `course.py` já tem o gancho (`_TIER_LABELS`),
      falta a tabela `data/topik_ja.json` equivalente.

## Depois

- [ ] Fase **Produção** no app (gravar output → `find-mistakes` → cards de correção).
- [ ] *Style guide* de "pai linguístico" por idioma.
- [x] **Legenda "conhecido/novo"** (opcional) + **compreensão por lição** em `/progress`
      (`segments[].tokens` na pipeline, `lib/vocab.ts` no app, `immersionLog.doseId`).
- [ ] Furigana/romaji automático e dicionário pop-up por palavra na legenda (os
      `tokens` por fala já existem — falta o significado por lema).
- [ ] Mais ideias em [`ideas.md`](ideas.md).
- [ ] Áudio condensado como modo "escuta passiva" no player.
- [ ] Descoberta de conteúdo assistida dentro do app (curadoria por gosto+nível).
- [ ] Empacotar como app desktop (Tauri).
- [ ] **HTTPS** na frente do servidor (Caddy/nginx + Let's Encrypt): hoje o :8000 fala HTTP
      puro, então o código de sincronização viaja em claro e o celular não instala o app
      como PWA (service worker exige contexto seguro). É o próximo passo do multi-device.
- [ ] Backup automático do `server/data/imersa.sqlite` (hoje o backup é o exportar/importar
      do app).

## Notas de conteúdo

- MeCab CLI não está instalado, mas `fugashi` (usado pelos scripts) cobre a
  segmentação. Instale o dicionário se for gerar japonês em escala.
- `ELEVENLABS_API_KEY` só é necessária para **transcrever** conteúdo novo; o app
  roda sem nenhuma chave.

# Imersa — Immersion Doses + SRS

> Uma plataforma de aprendizado de idiomas baseada em **doses diárias de imersão**
> com conteúdo natural na língua-alvo, acopladas a **flashcards com SRS** (repetição
> espaçada, estilo Anki) minerados **da própria dose**.

A tese: você não aprende com listas de gramática — você aprende **compreendendo
input natural, todos os dias, no nível certo**, e fixando o que apareceu com
repetição espaçada. Cada lição ("**Dose**") entrega as duas coisas no mesmo lugar:
uma imersão graduada + os cards que saíram dela.

Este repositório é um **monorepo** com duas metades:

| Pasta | O que é | Stack |
|---|---|---|
| [`web/`](web/) | **App do aluno** — a experiência diária: dashboard, player de imersão com legendas *primed*, e revisão SRS. É onde vive o UI/UX. | Vite + React + TypeScript + Tailwind v4 + Dexie (IndexedDB) + ts-fsrs |
| [`pipeline/`](pipeline/) | **Fábrica de doses** — transforma um vídeo da língua-alvo em uma `dose.json` pronta (transcrição, tradução fiel, *priming*, **20 cards de palavra por frequência**). Reaproveita os *dojo skills*. | Python 3.12 + yt-dlp + ElevenLabs Scribe + kiwipiepy (ko) / fugashi (ja) |
| [`content/`](content/) | **Doses geradas**, organizadas por `idioma / nível / lição`, servidas ao app. | JSON + mídia |
| [`docs/`](docs/) | Especificações: metodologia, contrato de dados, arquitetura, roadmap. | Markdown |

## A metodologia em 4 fases (cada Dose)

```
  ┌─ 1. PRIME ────────┐   ┌─ 2. IMERSÃO ───────┐   ┌─ 3. SRS ──────────┐   ┌─ 4. PRODUÇÃO ─┐
  │ Preview em PT do  │   │ Assiste/ouve o     │   │ Revisa os cards   │   │ (opcional)     │
  │ que vem a seguir  │──▶│ conteúdo natural   │──▶│ minerados DESTA   │──▶│ shadowing +    │
  │ → ativa o cérebro │   │ com legendas       │   │ dose + os cards   │   │ análise de     │
  │ para o áudio      │   │ primed (PT→alvo)   │   │ vencidos (FSRS)   │   │ erros de output│
  └───────────────────┘   └────────────────────┘   └───────────────────┘   └────────────────┘
```

Cada fase mapeia para a metodologia dos *dojo skills* (ver [`docs/methodology.md`](docs/methodology.md)):
`primed-listening` (agora: pausa + legenda em **PT** 0,1s antes da fala) → **Prime**;
`create-srt`+`translate-srt` → **Imersão**; **20 palavras de maior frequência** (kiwipiepy/fugashi)
+ FSRS → **SRS**; `find-mistakes`/`style-guide` → **Produção**.

## Começando

### App do aluno
```bash
cd web
npm install

# desenvolvimento (com hot-reload)
npm run dev                                             # http://localhost:5173

# produção (build otimizado + servidor com sincronização)
npm run build
npm run serve                                           # http://localhost:8000
```
Em produção quem serve é o `server/` (Node puro, sem dependências): ele entrega o app,
o `content/` e a API de sincronização na mesma porta. Para usar em **mais de um
aparelho**, gere um código em *Ajustes → Sincronização* e cole o mesmo código no outro —
o progresso passa a ir e voltar sozinho. Ver [`server/README.md`](server/README.md).
Já vem com a **trilha A1 de coreano** (7 lições em vídeo) e a **trilha B1 de
japonês** (7 lições em vídeo para intermediário), para você experimentar o fluxo completo. Nenhuma chave de API é necessária
para rodar o app (só para gerar conteúdo novo).

Em **Ajustes → Repetição espaçada → Escrita na frente do card**, você pode exibir
a palavra no idioma estudado junto do áudio, antes de revelar a resposta. A opção
vem desligada e fica salva neste navegador. Funciona na revisão da dose e na
revisão avulsa; a tradução continua no verso.

### Fábrica de doses (quando for adicionar conteúdo novo)
```bash
cd pipeline
./setup.sh                                    # cria venv + instala deps
export ELEVENLABS_API_KEY=...                 # necessário só para transcrever
python -m dose_factory build \
  --url "https://youtu.be/..." \
  --language ja --level A2 --lesson 4 \
  --title "Café da manhã de um freelancer"
```
Isso baixa, transcreve, traduz, gera priming + cards e escreve
`content/ja/course/A2-04/dose.json` — que o app carrega automaticamente.

Sem chave / a partir de arquivos locais (o que gerou a demo):
```bash
python -m dose_factory build-local \
  --media ../immersion/imm.mp3 \
  --target-srt ../immersion/imm.srt \
  --translation-srt ../immersion/imm.pt.srt \
  --scribe-json ../immersion/imm.json \
  --language ja --level A2 --lesson 1 --title "..."
```

## Status

**1º idioma: Coreano 🇰🇷** — trilha **A1** com **7 lições em vídeo**, 15–20 min e **20 cards
de palavra** cada (140 palavras distintas, sem repetir), em progressão i+1: histórias
ilustradas A0 de fala lentíssima, subindo de «isto é / está em» até fala informal e
planejamento de viagem.

**2º idioma: Japonês** — trilha **B1** com **7 lições em vídeo** de 16–25 min para quem
está na transição **N4 → N3** (base: vocabulário JLPT N5 e N4 + as palavras frequentes sem nível JLPT;
estrangeirismos em katakana não viram card): vlog de viagem, conversas e dois vlogs 100% nativos no fim. Os 20 cards de cada
lição começam no N3, a régua de nível é o JLPT (N3 · N2 · N1), e as lições seguem uma
escada de dificuldade contínua para os próximos lotes. A arquitetura
segue idioma-agnóstica. Roda em **produção** na porta 8000, com **sincronização entre
aparelhos**. Veja [`docs/roadmap.md`](docs/roadmap.md).

Detalhes de cada peça:
- [`docs/methodology.md`](docs/methodology.md) — a metodologia e o mapeamento com os dojo skills
- [`docs/dose-contract.md`](docs/dose-contract.md) — o formato `dose.json` (contrato entre pipeline e app)
- [`docs/architecture.md`](docs/architecture.md) — decisões técnicas e por quê
- [`docs/roadmap.md`](docs/roadmap.md) — o que existe e o que vem depois

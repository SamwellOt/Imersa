# 03 — Escrita do estado (ledger)

Status: ready-for-agent
Blocked by: 02

Spec: `.scratch/aprofundar-modulos/spec.md` — seções "Escrita do estado (ledger)" (User Stories
34–42, Implementation Decisions, Testing Decisions). Regras de forma das tabelas em `CLAUDE.md`
("Ao mexer no estado do aluno…") e `docs/architecture.md`.

Pontos de partida: `web/src/lib/srsRepo.ts` (~15 escritas de card), `progress.ts`
(`updateProgress`), `db.ts` (`getSetting`/`setSetting`, `tombstone`, reset/wipe),
`levels.ts`/backfill de nível, `sync.ts` (`scheduleSync`; aplicar do servidor continua direto),
`importAll` (continua direto).

Pronto quando: todas as escritas sincronizáveis passam pelo ledger; testes do ledger + teste-trava
que varre o fonte por escrita direta; `npm test`, `npm run test:web` e `npm run typecheck` verdes.

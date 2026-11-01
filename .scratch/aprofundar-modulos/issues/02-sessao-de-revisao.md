# 02 — Sessão de revisão sem React

Status: ready-for-agent
Blocked by: —

Spec: `.scratch/aprofundar-modulos/spec.md` — seções "Sessão de revisão" (User Stories 12–33,
Implementation Decisions, Testing Decisions).

Pontos de partida: `web/src/components/srs/useReviewSession.ts` (estado atual espalhado),
`reviewQueue.ts` e `resolveItems.ts` (viram internos), `ReviewSession.tsx` (tela, passa a
usar `useSyncExternalStore`), `web/src/lib/srsRepo.ts`, `srsQueue.ts`, `useDue.ts`.
Testes: `web/test/ui/ReviewSession.test.tsx` e o golden master em `web/test/__snapshots__/`
**não podem mudar**. Testes novos pela interface da sessão em `web/test/unit`.
Inclui criar `GLOSSARY.md` na raiz com o termo **Sessão de revisão**.

Pronto quando: tela só lê a visão e chama comandos; testes novos listados na spec passam;
`npm test`, `npm run test:web` e `npm run typecheck` verdes.

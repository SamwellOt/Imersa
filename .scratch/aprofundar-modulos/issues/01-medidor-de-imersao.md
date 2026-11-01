# 01 — Medidor de imersão

Status: ready-for-agent
Blocked by: —

Spec: `.scratch/aprofundar-modulos/spec.md` — seções "Medidor de imersão" (User Stories 1–11,
Implementation Decisions, Testing Decisions).

Pontos de partida: `web/src/components/player/useMediaController.ts` (regra atual, `onListened`,
cap 2 s), `web/src/pages/DosePlayer.tsx` (`listenedRef` + flush), `web/src/pages/Listen.tsx`
(acumulador próprio a ser removido), `logImmersion` em `web/src/lib/db.ts`/`srsRepo.ts`.
Testes: `web/test/unit`, `web/test/ui/ImmersionPlayer.test.tsx`, harness `web/test/harness.ts`.

Pronto quando: um módulo só (núcleo sem React + hook fino) conta para vídeo e Escuta;
testes do medidor novos; `npm test`, `npm run test:web` e `npm run typecheck` verdes.

# 05 — useImmersionMeter: reanexar só quando o elemento muda

Status: needs-triage
Blocked by: —

Achado 9 da code review de 01/11 (não corrigido em `0fd5bdd`): `web/src/lib/useImmersionMeter.ts`
roda um `useEffect` sem dependências a cada render (no player, a cada quadro) só para conferir o
elemento. Dependência no elemento quebra a Escuta (`pages/Listen.tsx` monta o `<audio>` depois do
`blobUrl`); o certo é um callback ref, que muda a assinatura do hook e os dois chamadores
(`Listen.tsx` e `ImmersionPlayer` via `ctl.mediaRef`). Só desempenho, sem efeito para o aluno.

# Aprofundar módulos: medidor de imersão, sessão de revisão e escrita do estado

Status: ready-for-agent

Origem: revisão de arquitetura de 01/11/2026 (candidatos 1–4) + grilling Q1–Q19.

## Problem Statement

O aluno perde coisas sem perceber, e quem mantém o app tropeça nas mesmas regras em
lugares diferentes:

- **Minutos de imersão somem.** A Escuta (áudio condensado) conta o tempo ouvido com uma
  regra diferente da imersão em vídeo: com a aba em segundo plano, ela descarta as amostras
  longas e não credita nada — exatamente o bug que o player de vídeo já corrigiu. Esses
  minutos alimentam o streak e as estatísticas do dia, então o aluno que ouve com a tela
  apagada "não estudou".
- **A sessão de revisão é frágil.** A fila da sessão (cards que voltam, desfazer, adiar,
  learn-ahead, fecho da dose, cota do dia) está espalhada em uma dúzia de estados e refs de
  React e vaza setters e refs para a tela. Foi aí que caíram os bugs de 31/10 (último card
  adiado caindo em "Nada para revisar", fecho duplo, posição pulando um card). Cada
  correção exige entender o hook inteiro, e só dá para testar montando a tela.
- **As regras do estado sincronizado são disciplina, não código.** "Estado carimba
  `updatedAt`", "ler-alterar-gravar vai em transação", "apagar vira tombstone" e "agende o
  sync" são repetidos à mão em cerca de 15 escritas de cards, no progresso da dose, no
  backfill de nível e nos ajustes. Esquecer uma vez faz a alteração do aluno perder o
  last-write-wins e sumir em outro aparelho — e há escrita de apagar + tombstone fora de
  transação.

## Solution

Três módulos profundos, entregues nesta ordem, cada um num commit:

1. **Medidor de imersão** — um só módulo conta o tempo ouvido para a imersão em vídeo e
   para a Escuta, com a regra que já funciona no player. O aluno passa a ganhar os minutos
   da Escuta em segundo plano.
2. **Sessão de revisão** — a fila da sessão vira um módulo sem React, com poucos comandos e
   uma visão derivada que a tela só desenha. O comportamento para o aluno não muda; muda
   que ele para de quebrar.
3. **Escrita do estado (ledger)** — todo estado e evento sincronizável é gravado por um
   módulo que carimba, transaciona, grava tombstone e agenda o sync. Um teste impede que
   alguém volte a escrever direto.

O candidato 4 (Prime dentro do relógio da mídia) fica **estacionado** no roadmap.

## User Stories

### Medidor de imersão

1. Como aluno, quero que o tempo da Escuta conte mesmo com a aba em segundo plano, para que ouvir com a tela apagada some no meu streak.
2. Como aluno, quero que o tempo da imersão em vídeo continue contando como hoje, para que nada do que eu já estudava mude de valor.
3. Como aluno, quero que a Escuta em 1,5× conte o tempo que eu realmente passei ouvindo, para que acelerar não infle nem esvazie meu dia.
4. Como aluno, quero que um aparelho que dormiu uma hora com a mídia "tocando" não credite uma hora, para que o número seja honesto.
5. Como aluno, quero que fechar a aba no meio da escuta ou do vídeo registre o que já tocou, para não perder o fim da sessão.
6. Como aluno, quero que uma sessão longa grave o tempo aos poucos (a cada minuto), para que um travamento do navegador não apague a meia hora inteira.
7. Como aluno, quero que um toque acidental de meio segundo não vire evento de imersão, para que o histórico não se encha de ruído.
8. Como aluno com dois aparelhos, quero que os minutos de cada aparelho se somem no mesmo dia, para que o total seja a soma real (os eventos continuam imutáveis).
9. Como aluno, quero que os minutos fiquem atribuídos à lição certa, para que a "Compreensão por lição" mostre o tempo de imersão de cada uma.
10. Como mantenedor, quero que a regra de contagem viva num lugar só, para que a próxima correção valha para as duas telas.
11. Como mantenedor, quero testar a contagem com um relógio falso e eventos de mídia reais, para não depender de esperar segundos de verdade.

### Sessão de revisão

12. Como aluno, quero que um card em que dei "De novo" volte logo depois do card em tela quando vencer, como no Anki.
13. Como aluno, quero que, no fim da fila, os cards que vencem nos próximos minutos entrem adiantados (learn-ahead), para que os novos ganhem a 2ª passagem na mesma sessão.
14. Como aluno, quero que a sessão só feche quando nada dela estiver vencido nem prestes a vencer, para não terminar a lição com cards pendurados.
15. Como aluno, quero que recarregar a página no meio da lição não faça a sessão esquecer quais cards voltam, para que a dose não feche com 17 em aprendizado.
16. Como aluno, quero desfazer a última nota (botão ou Z) e ver o card voltar exatamente como estava, inclusive como "novo" se ele nasceu nessa nota.
17. Como aluno, quero desfazer duas vezes seguidas e mexer nos dois cards certos.
18. Como aluno, quero desfazer na tela de "Revisão concluída" e a sessão reabrir, para corrigir a última nota.
19. Como aluno, quero marcar «Já sei» e o card sair sem nota e sem gastar a cota, e poder desfazer.
20. Como aluno, quero adiar, suspender ou reiniciar o card em tela e ele sair da sessão (o reiniciado volta como novo), sem encurtar o que já passou.
21. Como aluno, quero que adiar o último card feche a sessão como qualquer fim de fila, não mostre "Nada para revisar agora".
22. Como aluno, quero que um toque duplo nunca avance a fila duas casas nem dê duas notas.
23. Como aluno, quero que uma falha ao gravar a nota mostre o motivo e deixe o card na tela com os botões vivos.
24. Como aluno, quero que uma falha ao conferir o fim da fila não feche a dose sozinha e me ofereça "Conferir de novo".
25. Como aluno, quero que, com a cota de palavras novas do dia estourada, a tela avise e não ofereça "Concluir", para a lição não sumir da trilha.
26. Como aluno, quero que o "Concluir" da fila vazia não chame o fecho duas vezes com dois toques, e mostre o erro se o fecho falhar.
27. Como aluno, quero ver quanto falta por tipo (novos / aprendendo / a revisar), não "x de N".
28. Como aluno na revisão avulsa, quero que a tela acorde sozinha quando um card vence, sem F5.
29. Como aluno, quero que a nota seja calculada sobre o estado mais novo do card no banco (depois de um desfazer ou de um sync), não sobre uma cópia velha.
30. Como mantenedor, quero que a tela de revisão só leia uma visão e chame comandos, sem setters nem refs da sessão, para mexer no layout sem risco.
31. Como mantenedor, quero testar a fila da sessão chamando os mesmos comandos que a tela, com IndexedDB real e a dose de fixture, sem montar componente.
32. Como mantenedor, quero avançar um relógio falso para testar "De novo em 1 min" e o learn-ahead sem esperar.
33. Como mantenedor, quero que o termo "Sessão de revisão" esteja definido no glossário, para que as próximas revisões falem a mesma língua.

### Escrita do estado

34. Como aluno, quero que toda alteração de card, progresso de dose e ajuste sincronizado vença no last-write-wins quando é a mais nova, para que nada que eu fiz suma no outro aparelho.
35. Como aluno, quero que apagar um card (desfazer de card novo, desmarcar «Já sei», órfão) nunca ressuscite na próxima sincronização.
36. Como aluno, quero que duas escritas no mesmo instante no mesmo registro não se apaguem uma à outra.
37. Como aluno, quero que configurações locais do aparelho (posição do vídeo, sessão, dono dos dados) nunca subam para a conta.
38. Como aluno, quero que o que eu faço seja sincronizado alguns segundos depois, sem eu pedir.
39. Como aluno que restaura um backup, quero que o restaurado continue vencendo o servidor como hoje.
40. Como aluno que recebe dados de outro aparelho, quero que o carimbo original deles seja respeitado (não reescrito com "agora").
41. Como mantenedor, quero que uma escrita direta nas tabelas de estado fora do módulo de escrita faça um teste falhar, para que a regra do CLAUDE.md seja verificada, não lembrada.
42. Como mantenedor, quero que operações compostas (desfazer nota mexe em card e log) continuem atômicas.

## Implementation Decisions

### Medidor de imersão

- Novo módulo de domínio com um núcleo sem React e um hook fino por cima. O núcleo recebe um alvo de eventos de mídia (o próprio elemento), o idioma, a dose e um relógio injetado.
- O medidor **escuta sozinho** os eventos do elemento (`play`, `pause`, `timeupdate`, fim e `pagehide` da página); as telas só lhe entregam elemento, idioma e dose.
- Regra única (a do player de hoje): intervalo medido pelo **relógio de parede** enquanto toca; cada amostra credita **no máximo 2 s**; acumulado abaixo de **500 ms** não grava; grava no `pagehide`, a cada **60 s** e ao desmontar.
- Grava por `logImmersion` (evento imutável `immersionLog`, com `doseId`).
- O controlador de mídia do player **perde** o callback de tempo ouvido; a página da dose perde as refs e o flush próprios; a Escuta perde o acumulador e o flush próprios.
- A Escuta muda de "tempo da mídia ÷ velocidade" para relógio de parede — o valor é o mesmo em qualquer velocidade; o ganho é parar de descartar amostras em segundo plano.

### Sessão de revisão

- Novo módulo de domínio, **sem React**: um objeto com `subscribe`/`getView` e comandos; a tela se liga por `useSyncExternalStore`.
- Comandos: `grade(rating, elapsedMs)`, `known()`, `undo()`, `act(bury | suspend | forget)`, `close()`, `reload()`, `retry()` (reconferir o fim da fila).
- Visão: `estado ∈ carregando | card | conferindo | fim | cota`, mais campos à parte: `falha` (string ou nada, convive com qualquer estado), `atual` (item em tela, com `uid` que é a `key` do card), `faltam` por tipo, `resumo`, `podeDesfazer`, `fechando`, `erroAoFechar`, `heldBack`.
- Entrada: o escopo (`QueueScope`: idioma, ou idioma + dose), a dose a introduzir (fase da dose) e o callback de fecho.
- **Só o relógio é injetado.** O repositório SRS (IndexedDB) e o resolver de dose são importados direto — cada um tem um adapter só, logo seam hipotético.
- Regras que passam a ser internas: inserir os que voltaram sem repetir o que está à frente; remontar o card após falha; desfazer reabrindo a sessão e tirando a volta já enfileirada; adiar/suspender só daqui para a frente; conferir o fim da fila pelo banco (learn-ahead), com cota segurando o fecho; trava do fecho e erro próprio; nota sobre o registro fresco.
- As funções puras de fila e o resolver de itens deixam de ser interface (viram internas do módulo).
- Fica **no hook/tela**: o timer de vencimento da revisão avulsa (que chama `reload()` quando a fila está vazia e algo venceu, e calcula os "pendentes"), e o atalho `Z`.
- `GLOSSARY.md` (criado na raiz) recebe **Sessão de revisão**: a fila de uma dose (ou do idioma, na revisão avulsa) do carregar ao fechar, incluindo os cards que voltam e o learn-ahead.

### Escrita do estado (ledger)

- Novo módulo de escrita com: `putState(kind, rec)` (carimba `updatedAt`), `updateState(kind, id, fn)` (ler-alterar-gravar em `db.transaction("rw")` — único caminho para isso), `removeState(kind, id)` (apaga + tombstone na mesma transação), `appendEvent(kind, ev)`, `removeEvent(kind, uid)` (apaga + tombstone).
- O ledger chama `scheduleSync()` em toda escrita sincronizável; chave `local:` é gravada com carimbo mas nunca gera tombstone nem agenda sync.
- `getSetting`/`setSetting` passam para o ledger (`putState("setting", …)`).
- Cada operação abre transação `rw` sobre a sua tabela + tombstones; dentro de uma transação externa o Dexie aninha, então operações compostas (`undoGrade`, `markKnown`, `unmarkKnown`) mantêm a transação externa e chamam o ledger por dentro.
- **Escrevem direto (de propósito):** aplicar o que veio do servidor e importar backup (preservam o `updatedAt` de origem) e reset/wipe (apagam em massa com regra própria).
- Fora de escopo neste passo: uma descrição por tipo da qual sync/backup/reset derivem as tabelas (fica para depois que o ledger assentar).

## Testing Decisions

- Bom teste aqui = comportamento externo pela interface do módulo, igual ao que a tela usa. Nada de chamar funções internas de fila; nada de mock do IndexedDB.
- **Medidor**: teste unitário no harness do app (Chrome headless), com um `<audio>` de verdade disparando eventos e relógio falso: amostra de 5 s credita 2 s; menos de 500 ms não grava; `pagehide` grava; pausa não conta; a cada 60 s grava; o evento tem idioma e `doseId`. Os testes do `ImmersionPlayer` continuam passando.
- **Sessão de revisão**: testes novos pela interface da sessão, com IndexedDB real, a dose de fixture e relógio falso — "De novo volta depois do atual quando vence", "learn-ahead no fim", "desfazer na tela de fim reabre", "desfazer duas vezes mexe nos dois cards", "adiar o último fecha a sessão", "cota segura o fecho", "falha ao gravar mantém o card", "close() com trava", "nota sobre o registro fresco". Os testes de UI da `ReviewSession` e o golden master **não mudam**; mudança neles é regressão.
- **Ledger**: testes do ledger (carimbo, transação, tombstone, `local:` sem tombstone) e um **teste-trava** que varre o código-fonte por escrita direta nas tabelas de estado (`put`, `bulkPut`, `update`, `delete` em cards, progresso da dose e ajustes) fora do ledger, do sync e do módulo do banco.
- Prior art: os testes de caracterização em `web/test/ui` (ReviewSession, ImmersionPlayer, Settings) e os unitários em `web/test/unit` (srs, playerLogic), rodados por `npm run test:web`; integração do servidor por `npm test`.
- Cada entrega exige `npm test`, `npm run test:web` e typecheck verdes.

## Out of Scope

- Candidato 4 (Prime dentro do relógio da mídia): estacionado no roadmap; só volta se o Prime der bug de novo.
- Descrição por tipo do formato das tabelas consumida por sync/backup/reset.
- Qualquer mudança no protocolo de sync, no servidor, no contrato `dose.json` ou no FSRS.
- Mudança visual nas telas de revisão, imersão e Escuta.

## Further Notes

- Ordem de entrega: medidor → sessão de revisão → ledger, um commit por módulo; build + `systemctl restart imersa` no fim de cada um.
- A árvore de trabalho tem muita alteração anterior não commitada, inclusive nos arquivos que estes módulos tocam; decidir com o usuário como separar os commits antes do primeiro.

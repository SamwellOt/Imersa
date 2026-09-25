# Ideias de funcionalidades (backlog de aprendizado)

Lista levantada em 2026-09-05 com foco em **otimizar o aprendizado** (progressão natural,
imersão). Não é compromisso — é um banco para revisitar. O que já está no
[`roadmap.md`](roadmap.md) aparece marcado. ★ = prioridade sugerida.

## 1. Fechar o ciclo de aquisição

- ★ **Fase Produção "shadowing"** — antes do output livre já planejado: o aluno repete cada
  fala do vídeo logo após ouvir (modo do player que pausa após cada segmento, grava com
  `MediaRecorder`, toca original × sua voz lado a lado). Zero IA, zero servidor; técnica com
  boa evidência para pronúncia/prosódia. Ficaria em `?fase=producao`, entre imersão e SRS.
- **Cloze de escuta (dictation)** como 2º tipo de card: a frase-exemplo toca, o aluno
  digita/escolhe a palavra que falta. Usa o `exampleAudioSrc` que já existe. Recuperação
  ativa > reconhecimento passivo; pode ser introduzido só a partir da 2ª graduação do card
  (card de palavra gradua → gera o cloze).
- **Cards de sentença (i+1)** além dos 20 de palavra: as 3–5 frases da dose em que todas as
  palavras já são conhecidas menos uma. O `words` já sabe o vocabulário acumulado, então a
  pipeline consegue marcar as frases i+1 de graça (subs2srs filtrado). *(implementado em
  2026-09-24: `sentenceCards`, até 5 por dose)*
- **Output guiado com correção** (`find-mistakes`, roadmap): o aluno escreve 2–3 frases com
  palavras da dose; a correção vira card de erro. Precisa de LLM (chave opcional).

## 2. Tornar a imersão mais ativa

- ★ **Dicionário pop-up na legenda** (roadmap): tocar numa palavra mostra lema + significado
  + rank. A pipeline tem os offsets do kiwi por token → `segments[].tokens[]` no `dose.json`.
  Extensão: **"+ card"** — adicionar ao SRS uma palavra fora das 20 (card extra, sem furar o
  `newPerDay` da dose). *(implementado em 2026-09-24, com «Já sei»)*
- **Legenda "conhecido/novo" colorida** (opcional): com tokens por segmento + estado do SRS,
  pintar o que o aluno já domina vs. está aprendendo vs. nunca viu. Feedback de compreensão
  contínuo; mostra o i+1 na tela. *(implementado em 2026-09-05)*
- **Teste de compreensão** no player: 3–5 perguntas em PT sobre o trecho (geradas na
  pipeline, no `dose.json`), respondidas ao fim da imersão. Mede compreensão, não só tempo.
- **Re-imersão programada**: reassistir a dose N (ou só os fragmentos das frases-exemplo)
  3 e 10 dias depois, com legenda só em alvo. SRS aplicado ao input; item na aba Hoje.
- **Áudio condensado** (roadmap) para escuta passiva — a pipeline já corta fragmentos.
  *(implementado em 2026-09-24: `/escuta/:id`)*

## 3. Progressão adaptativa (hoje é linear)

- ★ **Gate de avanço por retenção**: só liberar a próxima dose quando os cards da atual
  passaram da 2ª graduação e a retenção real do idioma está ≥ X. Evita empilhar 20 novas/dia
  sobre uma base ruindo.
- **`newPerDay` adaptativo**: baixar para 10–15 quando a carga de revisões prevista
  (`srsStats`) passa do limite confortável; subir de volta quando cai.
- **Placement / pular lição**: teste com 10 palavras da dose (áudio → significado). Se ≥ 8,
  os cards nascem como "revisão" com estabilidade inicial maior e a dose fica só como imersão.
- **Dificuldade percebida por dose**: ao terminar, um toque (fácil / ok / difícil). Cruzado
  com car/s e palavras-novas/min da pipeline, calibra o passo do curso para o aluno e
  alimenta a descoberta assistida (roadmap).

## 4. Sequência e memória

- **Introduzir os 20 novos ao longo da dose**: card da palavra logo depois da 1ª frase em
  que ela aparece (intercalar imersão e SRS por trecho). Encoding com contexto quente.
- **Hint progressivo no card**: 2º toque mostra a palavra escrita, 3º mostra a frase — e a
  nota máxima cai (Bom → Difícil). Ajuda quem trava e ainda informa o FSRS.
- **Revisão em 2 blocos** (manhã/noite) com lembrete — `useDue` já tem o timer; falta
  notificação (PWA instalável).
- **Qualidade de sessão** (tempo médio por card, % "De novo" na 1ª passagem) para a
  otimização do FSRS e para o gate de avanço.

## 5. Plataforma / adesão

- **Streak com "freeze"** (1/semana) e meta semanal em minutos de input, não só doses.
- **Notificações locais** (service worker + Notification API) no horário habitual.
- **Modo "5 min"**: só revisões, sem dose, para dia ruim — mantém streak e curva do FSRS.
- **Estatísticas de compreensão por lição** em `/progress`: % de palavras conhecidas por
  dose, tempo de imersão acumulado, horas de input. *(implementado em 2026-09-05)*

## Ordem sugerida

1. Dicionário pop-up + tokens por segmento (desbloqueia legenda colorida, "+ card" e i+1).
2. Shadowing (fecha Produção sem chave de API).
3. Cloze de escuta.
4. Gate de avanço + `newPerDay` adaptativo.
5. Re-imersão programada.

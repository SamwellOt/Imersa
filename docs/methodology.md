# Metodologia — Imersa

O aprendizado é organizado em **Doses**. Uma Dose é uma lição diária construída em
torno de **um único trecho de conteúdo natural** na língua-alvo, graduado para o
nível do aluno, com todo o material de estudo derivado desse mesmo trecho.

O princípio central (baseado no *comprehensible input* + immersion + SRS):

> **Input compreensível todos os dias > estudo de regras.** A gramática e o
> vocabulário são adquiridos ao entender mensagens reais. O SRS existe só para
> impedir que o que já apareceu seja esquecido — não para "ensinar" do zero.

## As 4 fases de uma Dose

### 1. Prime (ativação)
Antes de ouvir, o aluno lê um **preview curto em português** do que vem a seguir.
Isso "carrega" o contexto para que o áudio na língua-alvo caia sobre significado já
ativado — a compreensão dispara e o input vira aquisição em vez de ruído.

- **Dojo skill:** [`primed-summaries`](../../immersion/dojo-prompts/primed-summaries.md)
  (resume trechos em preview PT/EN) + [`primed-listening`](../../immersion/dojo-prompts/primed-listening.md)
  (o *flash* da tradução imediatamente antes da fala).
- **No app:** a tela **Prime** mostra os *chunks* de preview; no player, o modo
  *primed* **pausa o vídeo 0,1s antes de cada fala** e mostra a legenda no **idioma
  nativo (PT)**. O aluno lê o significado, dá play e ouve a fala em idioma-alvo "às
  cegas" (a legenda some quando a fala começa).

### 2. Imersão (input)
O coração da dose. O aluno **assiste/ouve** o conteúdo natural com legendas
sincronizadas. Controles de legenda: só língua-alvo, só PT, ambas, ou *primed*
(pausa + preview em PT antes de cada fala → escuta às cegas). Repetição de linha,
loop de trecho, velocidade, e **barra de progresso arrastável** (mouse e toque).

- **Dojo skills:** [`create-srt`](../../immersion/dojo-prompts/create-srt.md)
  (transcrição ElevenLabs Scribe + segmentação bunsetsu natural) +
  [`translate-srt`](../../immersion/dojo-prompts/translate-srt.md) (tradução
  **fiel**, não "bonita" — feita para aprender, preserva a estrutura do original).
- **No app:** o **ImmersionPlayer** com trilha de legendas e sincronização por
  timestamp. Opcionalmente, a legenda **marca cada palavra pelo que o aluno sabe
  dela** (fixada = limpa · em aprendizado = sublinhada · nunca estudada = pontilhada),
  com a porcentagem da lição já fixada — o i+1 visível na tela. Desligado por padrão:
  é apoio para quem quer ver onde está a lacuna, não a regra da imersão.

### 3. SRS (retenção)
Cada dose vira **20 cards de vocabulário**: as **20 palavras de maior frequência**
que aparecem no vídeo (na forma de dicionário), ranqueadas por uma lista de
frequência e **sem repetir** as palavras de lições anteriores (dedup = i+1). O card
tem **frente** = a palavra falada por um **TTS nativo** (edge-tts) e **verso** (ao
revelar) = significado em PT + a **frase-exemplo curta** do vídeo, tocada por um
**fragmento pré-cortado** (áudio exato, sem seek) e com a **palavra destacada** na
frase. A revisão diária mistura **cards novos desta dose** + **cards vencidos de doses
passadas**, agendados por **FSRS** (padrão moderno do Anki). Um card só é considerado
**visto** (entra no SRS e conta no teto diário) quando recebe uma avaliação — abrir a
revisão ou pular não consome nada.

- **Base:** análise morfológica (kiwipiepy p/ coreano, fugashi p/ japonês) para
  extrair os lemas de conteúdo; ranqueamento por [`frequency.py`](../pipeline/dose_factory/frequency.py).
  Herda o espírito do dojo [`anki`](../../immersion/dojo-prompts/anki.md) (áudio +
  texto + contexto), mas com **cards de palavra por frequência** em vez de subs2srs.
- **No app:** a fase **Review** com flashcards de escuta e botões
  *De novo / Difícil / Bom / Fácil*, além de uma fila global de revisão. O agendamento
  segue o **Anki**: FSRS-6 com **passos de aprendizado** (`1m 10m`, reaprendizado `10m`),
  então um card novo é visto **duas vezes na mesma sessão** (Bom → 10 min) antes de
  graduar para dias; um *De novo* volta em ~1 min **no meio da sessão**; e quando não
  há mais nada, os que vencem nos próximos 20 min entram adiantados (*learn ahead*).
  A sessão só fecha quando nada da dose (ou do idioma, na fila global) está vencido
  nem prestes a vencer — e isso é conferido no banco, então recarregar a página no
  meio da lição não perde a segunda passagem. Intervalos
  em **dias** vencem no **início do dia de estudo** (4h), como no Anki: um "1 d"
  dado à noite já está vencido de manhã — o intervalo é uma data, não um cronômetro.
  Cards em aprendizado vêm primeiro, depois os vencidos (por vencimento, ou os mais esquecidos
  primeiro), com os novos misturados. Dá para **adiar** (`-`), **suspender** (`@`) e
  **reiniciar** um card, e desfazer a última nota (`Z`).
- **Compreensão por lição** (`/progress`): para cada lição, que fração do que é *dito*
  (cada ocorrência de palavra de conteúdo) o FSRS já considera fixada, quantas palavras
  distintas faltam e os minutos de imersão nela. A próxima lição mostra em número quanto
  já vem sabido antes de começar.
- **Retenção alvo** 90% (ajustável 70–99%). A tela de Progresso mostra a **retenção
  real** (acertos em cards já fixados), a **estimada agora** (média da probabilidade de
  lembrar) e a previsão de vencimentos — os mesmos números do *Stats* do Anki.
- **Parâmetros otimizados**: com 400+ revisões, *Ajustes → Otimizar parâmetros* roda o
  otimizador do Anki (fsrs-browser) sobre o seu próprio histórico e, opcionalmente,
  **reagenda** todos os cards repetindo o histórico com os novos parâmetros.
- **O dia vira às 4h** (como no Anki): revisar depois da meia-noite ainda conta como o
  mesmo dia — cota de novos e sequência incluídas.

### 4. Produção (output, opcional)
Depois de bastante input, o aluno grava a si mesmo falando; o sistema aponta erros
recorrentes e padrões não-naturais, e pode virar cards de correção. Um *style
guide* de um "pai linguístico" (falante nativo modelo) orienta as correções.

- **Dojo skills:** [`find-mistakes`](../../immersion/dojo-prompts/find-mistakes.md)
  + [`style-guide`](../../immersion/dojo-prompts/style-guide.md).
- **No app:** planejado (ver roadmap). Alta precisão: **não inventa erros**.

## Graduação (o "nível certo")

A dose precisa cair no ponto ótimo: **envolvente o bastante** para o aluno querer
assistir e **compreensível o bastante** para adquirir língua (i+1). A
[`content-discovery`](../../immersion/dojo-prompts/content-discovery.md) casa gosto
pessoal com nível. Cada Dose carrega metadados de dificuldade (CEFR aproximado,
nota de ritmo/gíria, contagem de vocabulário novo) e é posicionada numa trilha
ordenada (`nível → lição`).

## Por que "dose"

Uma dose é pequena, diária e consistente — a unidade que constrói o hábito. O
objetivo não é uma sessão longa e ocasional, mas a **exposição regular** que a
aquisição de idiomas de fato exige. O app é desenhado para que "fazer a dose de
hoje" seja um único gesto: prime → imerge → revisa.

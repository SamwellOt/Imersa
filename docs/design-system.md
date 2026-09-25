# Design system — Imersa

Fonte da verdade: **`web/src/index.css`** (tokens + utilitários) e
**`web/src/components/ui/*`** (primitivas). Este documento explica as decisões;
o CSS explica os valores.

## Princípios

1. **Um acento.** O teal da marca é a única cor decorativa. Gradiente é proibido
   como enfeite — não existe `brand-gradient`. Cor só aparece onde significa algo:
   ação primária, estado do card, nota do SRS.
2. **Fundo chapado.** Nada de blobs radiais, aura ou `backdrop-blur` em card.
   Profundidade vem de `surface` + 1px de `line`. Blur (`.frosted`) é exclusivo
   das barras fixas do desktop. No celular as barras (navegação de baixo,
   cabeçalho, topo da dose/revisão/escuta) são **opacas** (`.bar-solid`): com o
   vidro, o texto da página atravessava os rótulos da navegação.
   **Navegação no celular**: barra de baixo com alvo de 56 px, ícone de 20 px,
   rótulo de 11 px, aba ativa = traço de 2 px na borda de cima e o número de
   vencidos na Revisão; o cabeçalho traz o **seletor de idioma** (한국어 / 日本語 —
   antes só existia na barra lateral do desktop) e o tema; botões de fechar têm
   40 px no celular.
3. **Hierarquia por tamanho e cor, não por peso.** Títulos são serifa
   (Newsreader) em 400/500; a UI é Inter em 400/500/600. `font-extrabold` não é
   usado em lugar nenhum.
4. **Raio contido.** A escala `--radius-*` no `@theme` re-tuna todo `rounded-*`
   de uma vez (xl = 10px, 2xl = 14px). Nada de pílulas gigantes.
5. **No máximo dois acentos por tela.** Métricas são neutras; o arco-íris de chips
   pastel foi removido.
6. **A linha da dose é o átomo visual.** A peça que se repete no app inteiro é
   uma fala em idioma-alvo + tradução + o **timecode** de onde ela acontece no
   vídeo (`DoseLine`). Ela abre o Hoje, estrutura o Prime, é a transcrição e
   volta no verso do card. O timecode é o único elemento estrutural decorativo
   permitido — porque não é decoração: é a posição real dentro da mídia.
7. **Idioma se apresenta na própria escrita** (한국어 / 日本語), nunca por bandeira:
   bandeira é país, não língua — e emoji está fora do sistema. **Ícone é sempre
   lucide (SVG)**: nenhum glifo de texto (✓ ✕ ▶ ⋯) faz papel de ícone.
8. **O quadro do vídeo é a matéria visual.** A dose é um vídeo, então ela tem
   rosto: a capa (`media.posterSrc`) abre o Hoje e é a lâmina da Biblioteca e da
   trilha; a cena da frase-exemplo (`cards[].sceneSrc`) volta no verso do card.
   Estado se mostra na imagem: feita em cor com marca, próxima com contorno
   teal, futura em cinza — sem rótulo em cada linha. Dose sem quadro (build
   antigo) cai no mesmo layout, sem a imagem.
9. **Duas vozes tipográficas.** A fala em idioma-alvo é sans; a tradução em PT é
   **sempre** Newsreader itálico (`.line-trans`). O olho separa as duas línguas
   pela forma, não só pelo cinza. Em destaque (palavra do card, linha de
   abertura), o idioma-alvo vai para a serifa coreana/japonesa
   (`.font-target-display`), que pareia com a Newsreader dos títulos.
10. **Uma superfície por tela.** `Card` só onde há um objeto (a dose de hoje, o
    flashcard, a coluna lateral). Seções, listas e métricas vivem no fundo,
    separadas por `SectionLabel` e filete. Nada de card com faixa de topo e
    rodapé, nem de grade de tiles com números — métricas viram uma frase.

## Tokens

Semânticos, em CSS vars, trocados em runtime por `[data-theme="dark|light"]`
(`applyTheme` em `store.ts`) e expostos ao Tailwind via `@theme inline` — daí
`bg-surface`, `text-muted`, `border-line` lerem a variável viva.

| Grupo | Tokens |
|---|---|
| Superfícies | `--bg`, `--surface`, `--surface-2`, `--surface-3` |
| Traços | `--line`, `--line-strong` |
| Texto | `--fg`, `--muted`, `--faint`, `--sub-trans` (legenda-tradução) |
| Marca | `--brand`, `--brand-strong` (hover), `--brand-fg` (texto sobre a marca) |
| Estado | `--accent` (card novo), `--again`, `--hard`, `--good`, `--easy` (notas FSRS) |
| Elevação | `--shadow-e1`, `--shadow-e2` → `.elev-1`, `.elev-2` |

**Claro** é papel quente (`#f4f2ec`), não cinza-azulado; **escuro** é
verde-grafite (`#12181a`), não azul-marinho — o teal fica análogo ao fundo em
vez de colado por cima. `--brand-soft` é o teal a 12–14% para fundos de badge e
do botão de áudio do card.

## Tipografia

| Papel | Família | Uso |
|---|---|---|
| `--font-sans` | Inter | Toda a UI, números (`tabular-nums`) |
| `--font-display` (`.font-display`) | Newsreader (serifa) 500 | Título da dose, títulos de seção grandes, telas de conclusão |
| `.page-title` | Newsreader **400**, `clamp(2.125rem…2.625rem)`, entrelinha 1.05 | O `h1` de toda página (Hoje, Biblioteca, Progresso, Ajustes, Entrar). É o único tipo realmente grande da tela; o resto fica pequeno para ele ter ar. |
| `--font-target` (`.font-target`) | Noto Sans KR/JP | **Qualquer texto corrido em idioma-alvo** |
| `--font-target-display` (`.font-target-display`) | Noto Serif KR/JP | Idioma-alvo em destaque: a palavra do card (66 px), a linha de abertura |
| `.line-trans` | Newsreader itálico 400 | **Toda tradução em PT** ao lado de uma fala (Hoje, legenda, transcrição, card) |
| `.line-target` | `--font-target`, entrelinha 1.45 | Fala de imersão (legenda, transcrição, linha do dia) |
| `.timecode` | Mono, tabular, 11px | Posição dentro do vídeo e rank de frequência |
| `.label-eyebrow` | Inter 600, 12 px, caixa **baixa** | Rótulo de seção/estado ("Palavra nova"). Caixa alta espaçada saiu: é chapa de painel. **Não define cor** — combine com `text-faint`/`text-brand`. |

## Primitivas (`components/ui/`)

- `Button` — `primary` (fill sólido da marca), `secondary`, `ghost`, `outline`,
  `danger`. Sem gradiente, sem glow colorido.
- `Card` — superfície sólida + borda; `interactive` só muda borda/fundo no hover.
- `DoseLine` — a linha da dose: timecode em coluna fixa (ou a **cena**, via
  `scene`) + fala em idioma-alvo + tradução em itálico. Usada no Hoje; o Prime,
  a transcrição e o verso do card seguem o mesmo desenho.
- `Badge`, `Divider`, `Kbd`, `SectionLabel` (rótulo + filete até a margem).
- `Segmented` — indicador é uma superfície elevada neutra (estilo macOS), não uma
  pílula colorida.
- `ProgressBar` (1px de altura), `RingProgress` (traço sólido da marca).
- `EmptyState`, `ErrorScreen`, `Skeleton`, `Spinner`, `LoadingScreen`.
- **Esqueleto, não spinner.** Hoje/Biblioteca/Progresso carregam com
  `HomeSkeleton`/`ListSkeleton`/`StatsSkeleton`: a moldura fica de pé e o
  conteúdo entra no lugar, sem a tela piscar a cada navegação. `LoadingScreen`
  (spinner de página) fica só para a abertura de uma dose.

## Telas (o que cada uma é feita de)

- **Hoje** (`pages/Dashboard.tsx`): duas colunas a partir de `lg`. À esquerda o
  card da dose — capa 16:9 + as **20 palavras do dia** em idioma-alvo (já
  estudadas sublinhadas) numa coluna, título + linha de abertura + as três
  fases com seu peso + botão na outra. À direita, **sem caixa** (o card da
  dose é a única superfície da tela): revisão com o número de vencidos em
  serifa grande, o card mais atrasado, e os números em `<dl>` de filetes.
  Embaixo, ocupando a largura toda, a **trilha em filmstrip**: fita horizontal
  de quadros de 10,5 rem com número, duração e título, que rola de lado e
  centra a dose atual sozinha (a grade de sete miniaturas era ilegível). No
  topo, os **sete últimos dias** em quadrados com a inicial do dia embaixo.
- **Barra lateral** (`AppShell`): o item ativo é texto cheio + um traço de
  2 px da marca na margem esquerda — a mesma linguagem de filete do resto —
  não uma pílula de fundo. O idioma no rodapé é uma linha de texto (한국어 em
  cima, "Coreano" embaixo), não um campo de formulário; o tema fica ao lado
  da versão.
- **Onboarding**: o título ganha ênfase pelo **itálico da serifa** (a voz da
  tradução), não pela cor da marca pintando metade da frase; as três fases
  levam o ícone lucide que o app usa para cada uma (a revisão, o da barra
  lateral), sem "01 / 02 / 03".
- **Imersão** (`ImmersionPlayer`): o quadro num retângulo escuro com a **legenda
  por cima** (escurecimento só no rodapé do quadro; no modo Primed o quadro
  inteiro escurece e só o PT fica). Controles numa barra, não num card; a linha
  do tempo marca o início de cada história (`source.parts[]`). **Transcrição
  colapsável** (tecla `T`): a partir de `lg` é uma coluna ao lado, preferência
  salva (`transcriptOpen`), aberta por padrão; fechada, o vídeo volta ao
  centro. Abaixo de `lg` é um painel sob os controles, fechado por padrão.
  Áudio (sem quadro) mantém a faixa de legenda própria. **Cinema** (tecla `F`,
  botão de tela cheia): o player vira `fixed inset-0` preto com paleta escura
  forçada (`data-theme="dark"`), o quadro é o maior 16:9 que cabe (`cqh`) e os
  controles ficam por baixo com `safe-area`; entra **sozinho no celular em
  paisagem** (`(orientation: landscape) and (max-height: 520px)`) — antes o
  cabeçalho da dose comia um terço da altura. Pede tela cheia de verdade onde o
  navegador deixa (`requestFullscreen`; no iPhone é ignorado e fica só o
  layout). Num player com menos de `24rem` os botões encolhem para 32 px para a
  linha de controles não quebrar em duas (celular de 360 px).
- **Card** (`Flashcard`): sem faixa de cabeçalho; estado, rank e menu `⋯` numa
  linha. Alto-falante de 40 px em `brand-soft`. Frente: áudio e, quando ativado
  em Ajustes, a escrita da palavra em `.font-target-display` (sem tradução).
  Verso: palavra em
  `.font-target-display`, sentido em `.line-trans`, frase-exemplo com a **cena**
  ao lado. Notas numa **régua única** com o filete colorido de cada uma;
  "Mostrar resposta" ocupa a mesma régua, para o polegar não mudar de lugar; a
  régua é **`sticky` no rodapé** abaixo de `md` (num celular pequeno o verso
  passa da tela e a nota ficava fora do alcance), com o conteúdo esmaecendo
  por baixo. A
  info do card (retenção, estabilidade…) mora no menu, não no verso.
- **Biblioteca**: grade de lâminas 16:9 (2 / 3 / 4 colunas) **sem moldura** —
  quadro com legenda embaixo, como num catálogo, não um card com padding.
  Número e duração sobre a imagem, estado pela imagem (feita com marca, próxima
  com contorno, futura em cinza); só quem tem estado ganha a linha de rótulo
  sob o título. O cabeçalho do nível é serifa grande com a descrição em
  `.line-trans`, separado por filete.
- **Progresso**: frase-resumo no lugar dos seis tiles; calendário e escada
  TOPIK lado a lado; compreensão por lição com capa; retenção e previsão de
  vencimentos em **barras sobre uma linha de base** (sem trilho preenchido
  atrás — sete trilhos iguais liam como grade de tiles).

## Marca

`LogoMark` (`components/ui/Logo.tsx`) é um círculo preenchido até a linha d'água —
uma "dose" de imersão. Monocromático (`currentColor` → `text-brand`), legível a
16px, sem gradiente. O favicon em `web/index.html` repete a mesma forma em SVG.

## Regras de escrita (UI copy)

- Sem emoji na interface.
- Sem exclamação comemorativa ("Dose concluída", não "Dose concluída! 🎉").
- Rótulos concretos: "20 palavras", "16 min", "#1 em frequência".
- Português direto; `Dose` é o nome da unidade (`lib/brand.ts`).
- **Singular e plural sempre pelo `pluralize`** (`lib/utils.ts`): "1 dia
  seguido", não "1 dias seguidos".
- Um elemento, um trabalho: nada de dois botões com o mesmo rótulo na mesma
  tela, nem de repetir num chip o que a frase-exemplo já destaca.

## Estados com pouco dado

Tela nova é o estado mais comum no começo do curso, e ele não pode parecer
defeito: a atividade dos 28 dias é **um quadrado por dia** (com intensidade),
não barras — 27 barras zeradas liam como gráfico quebrado; a barra da escada de
vocabulário tem largura mínima visível; e a fila vazia de revisão explica que os
cards aparecem sozinhos ao vencer.

## Acessibilidade

- Foco visível global (`:focus-visible` → `outline: 2px solid var(--ring)`).
- `prefers-reduced-motion` desliga animações e transições.
- Alvos de toque ≥ 32px; barra inferior mobile com `pb-safe`.
- **Toque**: o `hover:` do Tailwind v4 só vale com `(hover: hover)`; em
  `(hover: none)` todo botão/link esmaece ao pressionar (`:active`, em
  `index.css`). Dicas de tecla (`Kbd`) usam a variante **`fine`**
  (`@custom-variant fine` = hover + ponteiro fino): `md:fine:flex`, para não
  aparecer num celular em paisagem, que é largo mas não tem teclado.
- Estados nunca dependem só de cor (ícone/rótulo acompanham).

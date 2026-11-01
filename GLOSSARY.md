# Glossário

**Sessão de revisão** — a fila de cards de uma dose (fase da dose) ou do idioma inteiro (revisão avulsa), do carregar ao fechar. Inclui os cards que **voltam** (um "De novo" que vence em ~1 min, o *learn-ahead* do fim da fila, que traz os que vencem em até 20 min) e só fecha quando nada dela está vencido nem prestes a vencer. Também cobre desfazer, «já sei», adiar/suspender/reiniciar, a cota de palavras novas do dia e o fecho da dose. Vive em `web/src/lib/reviewSession/`, sem React; a tela só lê a visão e chama comandos.

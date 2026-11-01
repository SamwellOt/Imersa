# server/ — app + sincronização entre aparelhos

Um processo Node **sem dependências** (usa `node:http` e `node:sqlite`, embutidos
no Node 22) que faz três coisas:

1. serve o app buildado (`web/dist`), com fallback de SPA — e a página **`/otimizar`**
   (otimizador do FSRS) com os cabeçalhos COOP/COEP que o WASM com threads exige; todo
   `/assets/*` sai com COEP para os scripts de worker dela poderem carregar;
2. serve `content/` **direto da pasta** (não da cópia dentro do `dist`), então
   trocar uma dose no disco reflete sem rebuildar — com suporte a `Range`, que é
   o que permite arrastar a barra do vídeo;
3. expõe `POST /api/sync`, que espelha o progresso do aluno para que desktop e
   celular vejam a mesma coisa.

```bash
node server/index.mjs --port 8000 --host 0.0.0.0     # ou: cd web && npm run serve
```

Em produção roda como serviço (`systemctl status imersa`), com log em
`/var/log/imersa.log` e o banco em `server/data/imersa.sqlite`.

## Contas

`auth-store.mjs`, no mesmo SQLite. Cadastro por **e-mail + senha** (scrypt com sal por
usuário, N=2^15), **sessões por aparelho** (token aleatório de 32 bytes; o banco guarda só
o sha256 — vazar o banco não entrega sessões vivas), prazo deslizante de 180 dias,
limites de login que bloqueiam **quem tenta**, nunca o dono: 8 erros em 15 min **por IP**;
8 erros em 15 min **por conta**, contados só de aparelhos **sem marca de confiança**
(barra o ataque espalhado por muitos IPs); e 8 por **marca**. A marca (`imd_…`,
`deviceTrust` na resposta de cadastro/login, só o sha256 no banco, tabela
`trusted_devices`, 1 ano deslizante) é entregue a cada login certo, o app a guarda em
`local:deviceTrust` (sobrevive ao sair da conta) e a manda no login: com ela o dono
entra mesmo com a conta sob ataque. Trocar a senha ou encerrar um aparelho nos Ajustes
retira a marca dos outros/daquele aparelho. Cadastro: 8 **que falharam** por IP na
janela (sucesso não conta) e um **disjuntor global** de 100 contas novas por hora
(`IMERSA_SIGNUP_MAX_PER_HOUR`). O cadastro responde 409 para e-mail já usado — sem
confirmação por e-mail isso sempre revela quem tem conta —, então há um segundo
**disjuntor global**: 20 respostas "e-mail já cadastrado" por hora
(`IMERSA_REGDUP_MAX_PER_HOUR`) e, passou disso, **todo** cadastro dá 429 até a janela
andar (bloquear só os repetidos entregaria quem existe). Trocar a senha e apagar a conta
conferem a senha com o mesmo limite do login (8 erros em 15 min, por conta): um token
roubado não chuta a senha à vontade. **Corridas** (`test/race.test.mjs`): o que foi
conferido antes de um `await` (corpo do pedido, scrypt) é conferido de novo dentro de um
`BEGIN IMMEDIATE` na hora de gravar — a troca de senha só grava se o hash ainda é o
conferido (`UPDATE … WHERE passHash=?`; duas trocas juntas → 200 + **409**), trocar a senha
ou apagar a conta exigem que a sessão ainda exista (aparelho encerrado no meio → 401), o
login não cria sessão se a senha mudou durante o scrypt dele, e as rotas com sessão leem o
corpo **antes** de conferir o token. Todo scrypt passa por uma **fila** de no máximo 4
simultâneos (`IMERSA_KDF_MAX`; fila acima de 256 → 503), então uma rajada só deixa as
respostas mais lentas, sem esgotar a memória; login com e-mail inexistente também paga um scrypt (o tempo de resposta
não revela quem tem conta). O IP é o do socket: `X-Forwarded-For` só é lido com
`IMERSA_TRUST_PROXY=1` (atrás de um proxy que reescreve o cabeçalho — hoje a :8000 é
servida direto). Toda resposta leva `nosniff`, `X-Frame-Options: DENY` e
`Referrer-Policy: same-origin`. Uma conta é dona do espaço `u:<id>` no sync-store.

| rota | corpo | faz |
|---|---|---|
| `POST /api/auth/register` | `{email, password, name?, deviceId}` | cria a conta e já devolve `{user, token, sessionId, deviceTrust}` |
| `POST /api/auth/login` | `{email, password, deviceId, deviceTrust?}` | idem, para conta existente (401 genérico se errar) |
| `POST /api/auth/logout` | — | encerra a sessão do token |
| `GET /api/auth/me` | — | `{user, sessionId, sessions[], stats}` |
| `POST /api/auth/sessions/revoke` | `{id}` ou `{others: true}` | encerra outra sessão / todas as outras |
| `POST /api/auth/password` | `{current, next}` | troca a senha e derruba os outros aparelhos |
| `POST /api/auth/profile` | `{name}` | renomeia |
| `POST /api/auth/delete` | `{password}` | apaga conta, sessões e **todo** o progresso dela |

Todas menos `register`/`login` exigem `Authorization: Bearer imt_…`. Erros voltam
como `{error}` com texto em PT-BR pronto para a tela.

### Legado: código de sincronização

Antes das contas, a "conta" era um código gerado em Ajustes e colado no outro aparelho:
`sha256("imersa:" + código)`. O servidor **continua aceitando** (`Bearer <código>`, mínimo
12 caracteres) **só para as contas por código que já existem** — código desconhecido dá
401 e não cria nada (antes, qualquer texto criava um espaço novo, sem cadastro e fora do
disjuntor). O app não oferece mais essa UI. Ao
entrar com uma conta, o app oferece levar o progresso do aparelho para ela — é assim que
se migra.

## Protocolo

`POST /api/sync` · `Authorization: Bearer <token de sessão | código legado>`

```jsonc
// pedido
{ "since": 42, "deviceId": "…", "changes": [
  { "kind": "review", "id": "<uid>", "updatedAt": 1787… , "value": { … } },
  { "kind": "card",   "id": "ko-A1-01::w-있다", "updatedAt": 1787…, "deleted": true }
]}
// resposta
{ "ok": true, "accepted": 2, "seq": 44, "records": [ … ], "hasMore": false }
```

`kind` ∈ `card · review · doseProgress · immersion · setting`. O cliente guarda o
maior `seq` que já aplicou e pede só o que veio depois.

**`deviceId` não é enfeite**: cada linha guarda quem a escreveu por último, e o
`pull` **pula as linhas do próprio remetente**. Sem isso o aparelho baixava de
volta tudo que tinha acabado de subir, e o app lia esse eco como "chegou
novidade de outro aparelho" — recarregando todas as telas a cada sincronização,
mesmo com um aparelho só. O cursor simplesmente não avança sobre as próprias
linhas, e tudo bem: elas nunca precisam voltar. Se o outro aparelho mexer numa
delas, a linha ganha `device` novo e volta a aparecer. Cliente que não mandar
`deviceId` recebe tudo, como antes.

### Regras de merge (em `sync-store.mjs`)

| tipo | forma | regra |
|---|---|---|
| `review`, `immersion`, `mark` | evento imutável, id global (`uid`) | união; um tombstone nunca é desfeito |
| `card`, `doseProgress`, `setting` | estado | last-write-wins pelo `updatedAt` do cliente; empate favorece o tombstone |

Do lado do **cliente** (`web/src/lib/sync.ts`) a mesma regra vale ao aplicar um
tombstone recebido: estado local mais novo que o apagar fica; evento é apagado de
vez, exceto o restaurado de backup depois do apagar (`local:importedAt`). Importar
backup zera o cursor e carimba o estado com `updatedAt` de agora — o restaurado
vence.

`mark` = fala marcada «não entendi» no player (tabela `lineMarks` do app).

### Limites de armazenamento

- Registro com `id` acima de 200 caracteres ou `value` acima de 256 KB é **ignorado**
  (como item malformado; os outros do lote entram).
- **Cota por conta**: 300 mil registros (tombstones contam) e 100 MB de id + json
  (`IMERSA_QUOTA_RECORDS`, `IMERSA_QUOTA_BYTES`), contados em `accounts.nrec/nbytes`
  (preenchidos a partir dos registros na primeira abertura de um banco antigo). Lote que
  deixaria a conta acima da cota → **507** e **nada** dele é gravado; o cliente mantém
  as pendências e mostra o erro. Lote que só diminui o uso (apagar, valor menor) passa
  sempre.

O servidor não recalcula nada — ele não sabe o que é FSRS. Ver
[`../docs/architecture.md`](../docs/architecture.md) para o porquê.

## O que NÃO sobe

Chaves de configuração com o prefixo `local:` (a sessão da conta `local:auth`, o dono
do progresso `local:dataOwner`, o id do aparelho, o código legado) ficam só no
aparelho, tanto na sincronização quanto no exportar/importar.

## Aviso de rede

Hoje o serviço fala **HTTP puro**. Numa rede em que você não confia, o código de
sincronização (e a senha, ao entrar) viaja em claro — e sem HTTPS o navegador também não instala o app
como PWA (service worker exige contexto seguro; `localhost` é a exceção). Para
expor na internet, ponha um proxy com TLS na frente (Caddy/nginx + Let's Encrypt)
e aponte o app para o domínio.

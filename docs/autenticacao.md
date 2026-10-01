# Autenticação e administração de usuários

Contrato iniciado em 29/09/2026; bootstrap local atualizado em 30/09/2026. As evidências de execução ficam no documento de testes e no histórico; este documento descreve o contrato implementado. O [README](../README.md) contém o procedimento de execução local.

## Organização e persistência

O backend é uma aplicação NestJS única, com adaptador Express. Os módulos `database`, `auth`, `users`, `games`, `play` e `health` separam responsabilidades. Não há serviço externo de autenticação, Redis, ORM ou microserviços. Consultas usam parâmetros do `pg`; valores de requisições não são interpolados em SQL.

A migração `backend/migrations/001-auth.sql` cria:

| Tabela | Finalidade |
| --- | --- |
| `users` | UUID, nome único, hash da senha, perfil, bloqueio, exigência de troca e data de criação |
| `sessions` | Hash SHA-256 do token opaco, usuário, criação e vencimento |
| `login_attempts` | Contadores por nome e IP, com identificadores SHA-256 e início da janela |
| `schema_migrations` | Nome, checksum SHA-256 e aplicação de cada migração; criada pelo executor |

O executor de migrações usa uma transação e bloqueio consultivo PostgreSQL para serializar execuções. Recusa migrações já aplicadas cujo conteúdo mudou ou cujo arquivo desapareceu. Para evoluir o banco, adicionar um novo arquivo numerado; não editar arquivos já aplicados. O backend não executa migrações implicitamente: no Compose, `migrate` deve concluir antes do bootstrap, que também deve concluir antes da inicialização da API.

O usuário da aplicação é proprietário do seu banco e pode aplicar seu esquema; não é o superusuário PostgreSQL. Credenciais administrativas são usadas apenas pelos serviços locais específicos de inicialização, teste e manutenção. A primeira entrega não separa uma credencial exclusiva para migrações.

## Credenciais e perfis

O nome de usuário contém entre 3 e 32 caracteres: letras ASCII minúsculas, números ou `_`. Não há normalização silenciosa do nome. Senhas novas (bootstrap, criação, redefinição e troca) têm de 12 a 128 caracteres e não são aparadas. Login e confirmação da senha atual aceitam credenciais existentes não vazias de até 128 caracteres, permitindo verificar hashes legados de senhas curtas. Os DTOs de criação e autenticação têm validações de senha separadas; flexibilizar a leitura de credenciais existentes não flexibiliza a política de novas senhas. Não há cadastro público, login social, email de recuperação ou senha padrão.

Senhas são armazenadas somente como hashes Argon2id, com sal aleatório gerado pela biblioteca, memória de 65.536 KiB, três iterações, paralelismo um e saída de 32 bytes. No processo da API, no máximo quatro operações Argon2 ocorrem simultaneamente; excesso recebe HTTP 429. Senhas escolhidas passam pela memória do processo durante a operação, sem serem registradas em logs ou argumentos de comandos. A credencial inicial do fluxo automático fica no `.env` local protegido; esse arquivo nunca é versionado nem incluído no build. Somente o hash é persistido no banco.

O primeiro `MASTER` é criado pelo serviço temporário `bootstrap` do Compose, após as migrações. Ele executa `bootstrap-master-env.js` (também disponível como `npm run bootstrap:env --workspace backend`) e lê `ADMIN_USERNAME`/`ADMIN_PASSWORD` de um arquivo montado como secret somente leitura, normalmente `.env`. `node:util.parseEnv` interpreta o arquivo sem executar seu conteúdo; as credenciais não são variáveis de ambiente do container nem argumentos. Sem master, dados ausentes, parciais ou inválidos causam falha; com master existente, o bootstrap termina sem alterar a conta. As validações de tamanho e formato são as mesmas exigidas de novas credenciais. A senha configurada deve ocupar uma linha entre aspas simples, sem apóstrofo interno nem barra invertida final; valores ambíguos e chaves duplicadas são recusados. `$`, `#`, espaços, Unicode, aspas duplas e barras invertidas internas são literais. Senhas com apóstrofo ou barra invertida final podem ser definidas pela alternativa interativa.

`BOOTSTRAP_ENV_SOURCE` seleciona o arquivo, com `./.env` definido pelo exemplo/setup. Se esse seletor estiver ausente ou vazio, o Compose usa `.env.example`, sem credenciais; master existente continua preservado sem ler credenciais. O setup acrescenta o seletor a configurações legadas quando ausente. O `.env` real tem permissão `0600`. Somente o container temporário de bootstrap usa UID root para ler o secret independentemente do UID do host; seu papel de banco continua limitado ao da aplicação. Backend e frontend permanecem sem root. Depois de confirmar o primeiro login, os campos `ADMIN_*` podem ser esvaziados.

A alternativa `npm run bootstrap:master --workspace backend` exige terminal TTY, recusa argumentos e solicita nome, senha sem eco e confirmação. Esse comando não recebe senha por variável de ambiente. Os dois caminhos compartilham a criação transacional com bloqueio consultivo e verificação de master existente; execuções concorrentes não criam dois masters. Procedimentos em [operação](operacao.md#primeiro-master-e-segredos-locais).

O master joga e administra jogadores. Apenas `JOGADOR` pode ser criado pela API; a senha inicial é temporária. Enquanto `mustChangePassword` for verdadeiro, o usuário pode consultar sua própria sessão, trocar a senha ou sair. O backend bloqueia jogos e administração nessa condição.

A administração lista contas e cria, bloqueia, desbloqueia ou redefine senha de jogadores. Não existem endpoints para exclusão de contas, promoção de perfil ou alteração administrativa de master. Assim, autoexclusão e bloqueio do último master não são operações disponíveis. O próprio banco também impede um master bloqueado. Qualquer usuário autenticado, inclusive master, pode trocar sua própria senha informando a atual; a nova deve ser diferente.

A redefinição administrativa exige nova senha temporária escolhida pelo master e exige troca pelo jogador. Esta entrega não implementa recuperação de senha esquecida do master. A entrega da senha temporária ao jogador ocorre fora do aplicativo, por um canal escolhido pelo responsável; a aplicação não envia mensagens.

## Sessões e revogação

O login gera 32 bytes aleatórios de token, codificados em base64url. Apenas seu hash SHA-256 vai para o banco. O navegador recebe `emulador_session`, cookie `HttpOnly`, `SameSite=Strict`, caminho `/api`, sem atributo `Domain`. O prazo é absoluto, sem renovação a cada acesso: 168 horas por padrão, configurável por `SESSION_TTL_HOURS` entre 1 e 720.

`COOKIE_SECURE=false` existe para o HTTP local em loopback. Uma configuração de origem HTTPS exige `COOKIE_SECURE=true`; este Compose não constitui uma implantação HTTPS. O cookie persiste no navegador e a sessão persiste no PostgreSQL, permitindo continuidade após reinício da API.

| Ação | Efeito nas sessões |
| --- | --- |
| Sair | Revoga a sessão atual e remove seu cookie |
| Trocar a própria senha | Revoga todas as sessões da conta; exige novo login |
| Redefinir senha do jogador | Revoga todas as sessões do jogador; exige troca após o novo login |
| Bloquear ou desbloquear jogador | Revoga todas as sessões do jogador; cookies anteriores não voltam a funcionar |
| Vencer o prazo | A sessão é rejeitada mesmo que seu registro ainda exista |

Login e operações que alteram dados usam bloqueios na linha do usuário. A senha e o bloqueio são conferidos novamente antes de criar uma sessão, impedindo que uma verificação Argon2 iniciada antes de uma redefinição ou bloqueio restaure acesso indevido. Operações autenticadas que alteram dados também conferem novamente a sessão e as permissões dentro da transação. A autorização não depende da interface.

Registros vencidos de sessão e contadores com mais de um dia e sem bloqueio vigente são limpos durante logins bem-sucedidos, em lotes de até 1000 linhas sem aguardar linhas ocupadas. Ainda não existe rotina agendada de limpeza. Não há limite próprio de dispositivos ou interface para listar sessões nesta entrega.

## Origem, CSRF e validação

A interface acessa `/api` pela mesma origem, usando o proxy local do frontend. Não há CORS habilitado. Toda requisição com método diferente de GET, HEAD e OPTIONS exige:

- `Origin` exatamente igual a `APP_ORIGIN`, incluindo protocolo, host e porta, sem barra final.
- `X-Requested-With: XMLHttpRequest`.
- `Content-Type: application/json`, inclusive logout com corpo `{}`; criação/edição do catálogo usam `multipart/form-data` conforme [contrato próprio](catalogo.md), mantendo origem, AJAX e CSRF.
- Ausência de `Sec-Fetch-Site: cross-site`.

As operações autenticadas que alteram dados também exigem `X-CSRF-Token`. O login e `GET /api/auth/me` devolvem esse token, derivado com HMAC-SHA-256 do token aleatório da sessão e uma finalidade fixa. A comparação aceita somente 43 caracteres ASCII no alfabeto base64url, converte os valores para buffers UTF-8 e verifica igualdade do tamanho em bytes antes de chamar `timingSafeEqual`. Comprimento de string não é usado como garantia de tamanho dos buffers. Tokens não ASCII são rejeitados com HTTP 403, sem lançar exceção nem encerrar a sessão válida. O token CSRF não autentica a sessão sozinho. O login exige as proteções de origem, cabeçalho personalizado e JSON mesmo antes de existir sessão.

DTOs validam tipos, tamanhos e formatos; campos extras são recusados. Identificadores de usuários em URLs devem ser UUID v4. O corpo JSON das rotas gerais tem limite de 16 KiB; o envio de save tem limite próprio descrito em [emulação](emulacao.md). Erros não retornam hashes, senhas, SQL, argumentos de consulta ou stack trace. Respostas da API usam `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, `X-Frame-Options: DENY`, `Referrer-Policy: no-referrer` e política CSP restrita.

## Limitação de tentativas

A migração incremental `005-login-security.sql` acrescenta `failure_times` e `blocked_until` à tabela existente `login_attempts`, preservando contadores antigos. Não há Redis ou dependência nova. Chaves SHA-256 usam namespaces separados para cada política; IPs em texto não são persistidos nesses registros.

| Política | Limite e janela | Efeito |
| --- | --- | --- |
| Falhas de login por IP | Três falhas numa janela **móvel** de duas horas | Terceira falha inicia bloqueio de login por duas horas a partir dela |
| Rajada de login por IP | 30 requisições em janela fixa de 60 segundos | 429 antes do parser/DTO/hash; inclui corpos malformados que passam pela validação de origem e tipo |
| Tentativas por conta | Dez em janela fixa de 15 minutos, compartilhadas entre IPs | Login e troca de senha; antes de Argon2 |
| Tentativas por IP | Cem em janela fixa de 15 minutos | Login e troca de senha; antes de Argon2 |
| Requisições gerais por IP | 1200 em janela fixa de 60 segundos | Todas as rotas do backend após a validação de origem/tipo; não limita os assets estáticos do Vite |
| Argon2 | Quatro operações simultâneas por processo | Contenção de memória já existente |

Login com formato válido e conta inexistente, senha incorreta ou conta bloqueada conta como falha de autenticação. DTO inválido (400), origem inválida (403) ou contenção (429) não acrescentam falhas. Conta inexistente verifica hash fictício e recebe a mesma mensagem de credenciais inválidas. A terceira falha já retorna **429**, sem cookie, com mensagem em português e `Retry-After` inicialmente de **7200 segundos**. Novos nomes e senhas corretas também são recusados durante o bloqueio. Requisições recusadas não mudam `blocked_until`; o prazo restante diminui. Depois do vencimento, o histórico daquele IP recomeça vazio. Antes de um bloqueio, somente falhas ainda dentro da janela móvel são consideradas.

Sucesso não apaga os contadores, nem as falhas anteriores do mesmo IP, de outras contas ou de outros IPs. Os contadores adicionais por conta/IP também passam a expirar pela janela, sem limpeza por sucesso. Isso pode limitar logins e trocas de senha repetidos mesmo com credenciais corretas. HTTP 429 informa o prazo restante do limite que recusou a requisição. Uma tentativa simultânea do mesmo IP recebe 429 com `Retry-After: 1`; deve ser repetida após a tentativa em andamento terminar. Rajadas podem receber o prazo menor da política de rajada antes da consulta ao bloqueio de duas horas, sem alterar esse bloqueio.

Uma trava consultiva transacional PostgreSQL por IP é adquirida **sem espera**, antes do hash. Ela cobre leitura das falhas, verificação de senha, revalidação da conta e criação de sessão/registro da falha. Falhas são confirmadas no banco antes de enviar o erro HTTP. Duas instâncias da API compartilham a trava; requisições paralelas não verificam senhas além do limite. Relógio do banco determina os prazos. Reiniciar/recriar a API não limpa os registros. Falha de banco não libera login.

O bloqueio de duas horas atua somente em login. Não revoga sessões nem bloqueia biblioteca, ROM, heartbeat ou saves de sessões existentes. O limite geral é separado: comporta a biblioteca de até 1000 capas numa carga, heartbeat a cada 30 segundos e sincronização usual do player. Permanecem o intervalo mínimo de um segundo entre alterações de save, repetição idempotente e as quotas de upload/save. O limite geral também é compartilhado por clientes sob o mesmo IP; recarregamentos repetidos ou abuso podem esgotá-lo temporariamente, sem revogar sessões.

### Identificação do IP

Cadeia local: navegador → porta loopback Docker → **Vite** → backend na rede privada. Vite remove `Forwarded`, `X-Forwarded-For`, `X-Forwarded-Host`, `X-Forwarded-Proto` e `X-Real-IP` recebidos e escreve um único `X-Forwarded-For` com o endereço válido de seu socket. Não concatena cabeçalhos enviados pelo navegador.

O backend mantém `trust proxy=false`. Somente o serviço `backend` do Compose recebe `TRUSTED_PROXY_HOST=frontend`. A cada requisição, ele resolve esse nome na rede Docker e compara os endereços exatos com o peer do socket; aceita o IP encaminhado apenas quando esse peer corresponde ao serviço confiável. Outros peers usam seu próprio socket e ignoram todos os cabeçalhos de encaminhamento. Não se confia na rede privada inteira nem em quantidade irrestrita de saltos. Um proxy reconhecido sem IP único válido, ou falha de resolução, recebe erro genérico 503. A rota `/api/health` sempre usa o socket direto, permitindo o healthcheck inicial antes de existir o frontend (que depende da API saudável).

IPv4 mapeado em IPv6 é convertido para IPv4; IPv6 é canonizado. Listas, portas, texto inválido e identificadores de zona não são aceitos como IP encaminhado. A configuração sem `TRUSTED_PROXY_HOST` é apropriada para execução direta; não habilita encaminhamento. Recriação do frontend é acompanhada pela resolução de DNS, sem manter confiança em um IP antigo.

Docker Desktop/WSL, NAT e proxies anteriores ao Vite podem apresentar vários clientes com o mesmo endereço de socket. Nesse caso, eles compartilham o bloqueio; não é seguro recuperar IPs originais a partir de cabeçalhos não confiáveis. Clientes que chegam ao Vite com sockets de IPs distintos permanecem distintos no backend, sem serem agrupados pelo IP do container Vite. Bloqueio por IP reduz abuso, mas não impede bots distribuídos por múltiplos IPs. O ambiente continua local, sem exposição externa.

### Revisão de SQL

Revisadas consultas alcançáveis por login/sessão, usuários, catálogo/capas, ROMs, reservas e saves. Valores usam parâmetros `$1…$n` de `pg`, incluindo nomes, hashes, UUIDs, booleanos e bytes. Ordenação e filtros SQL são fixos; parâmetros de URL desconhecidos não viram fragmentos SQL. Não foram encontradas concatenações vulneráveis de dados de requisição nesta revisão. Não foi adicionada blacklist nem escape manual. Nomes de jogos e bytes de saves preservam texto com sintaxe SQL como dados; identificadores inválidos são recusados pelo contrato existente. Papel limitado do banco e respostas genéricas sem SQL/segredos permanecem.

Referências técnicas: [Express e proxies confiáveis](https://expressjs.com/en/guide/behind-proxies/), [consultas parametrizadas do pg](https://node-postgres.com/features/queries) e [travas consultivas PostgreSQL](https://www.postgresql.org/docs/18/explicit-locking.html#ADVISORY-LOCKS).

## Contrato HTTP

As respostas de usuário incluem somente `id`, `username`, `role`, `blocked`, `mustChangePassword` e `createdAt`. Erros retornam `{ statusCode, message }`.

| Método e rota | Entrada | Acesso | Sucesso |
| --- | --- | --- | --- |
| `GET /api/health` | — | Público | 200, prontidão do banco e tabela de migrações |
| `POST /api/auth/login` | `{username,password}` | Público com origem validada | 200, `{user,csrfToken}` e cookie |
| `GET /api/auth/me` | — | Autenticado, inclusive senha temporária | 200, `{user,csrfToken}` |
| `POST /api/auth/logout` | `{}` | Autenticado, inclusive senha temporária | 204 |
| `POST /api/auth/password` | `{currentPassword,newPassword}` | Autenticado, inclusive senha temporária | 204 |
| `GET /api/users` | — | Master sem troca pendente | 200, `{users}` |
| `POST /api/users` | `{username,password}` | Master sem troca pendente | 201, `{user}` jogador com senha temporária |
| `PATCH /api/users/:id/status` | `{blocked:boolean}` | Master; alvo jogador | 200, `{user}` |
| `POST /api/users/:id/reset-password` | `{password}` | Master; alvo jogador | 204 |
| `GET /api/games` | — | Autenticado sem troca pendente | 200, `{games:[...]}`; master todos, jogador ativos |

HTTP 401 indica ausência ou invalidade de sessão/credenciais. Senha atual incorreta na troca recebe HTTP 400, preservando a sessão. HTTP 403 indica origem/CSRF inválido, perfil insuficiente ou troca obrigatória. Dados inválidos recebem 400; nome duplicado ou tentativa de alterar um master pela administração recebe 409; jogador inexistente recebe 404. As rotas multipart de criação/edição e leitura autorizada de capa estão em [catálogo](catalogo.md). As rotas autenticadas de entrega da ROM e persistência de save nativo estão em [emulação](emulacao.md). A interface não oferece download de ROM nem importação/exportação de saves.

## Fontes consultadas

As versões exatas estão no `package.json` de cada workspace e no `package-lock.json`. A escolha de sessões próprias persistidas em PostgreSQL e as políticas acima são decisões desta implementação, não funcionalidades automáticas do NestJS.

- [NestJS: autenticação](https://docs.nestjs.com/security/authentication).
- [node-argon2: documentação oficial](https://github.com/ranisalt/node-argon2).
- [Registro oficial npm: @nestjs/core](https://www.npmjs.com/package/@nestjs/core) e [TypeScript](https://www.npmjs.com/package/typescript), consultados também por `npm view` para versões e compatibilidade.

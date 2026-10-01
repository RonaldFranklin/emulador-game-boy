# Operação local, testes e recuperação

O [README](../README.md) contém a instalação inicial. Este guia reúne configuração, manutenção e recuperação sem depender de uma máquina ou usuário específicos. O Compose é exclusivamente local, com publicação em loopback.

## Primeiro master e segredos locais

O fluxo principal está no [README](../README.md#instalação-local): preencher `ADMIN_USERNAME` e `ADMIN_PASSWORD` no `.env` local e executar `docker compose up -d --build`. Não é necessário executar SQL nem criar uma conta pela API.

`npm run setup` preserva `.env` e segredos já existentes e aplica `0600` ao `.env`. A pasta `.local/secrets/` tem `0700`; os dois arquivos de senha do banco têm `0644` dentro dessa pasta privada para permitir leitura pelos UIDs dos containers. Não mova esses arquivos para um diretório compartilhado. Remover arquivos de segredo não altera as senhas de um banco já inicializado.

`BOOTSTRAP_ENV_SOURCE=./.env` seleciona o arquivo real. O setup adiciona essa chave quando ela está ausente, preservando qualquer valor já definido. Se o seletor estiver ausente ou vazio, o Compose monta `.env.example`, cujos campos de credencial são vazios. Esse fallback permite iniciar um banco já provisionado mesmo sem `.env`; ele não procura automaticamente outro arquivo quando um caminho explícito não existe. Para um `.env` legado sem o seletor, execute `npm run setup` antes de subir. Sem master, é necessário selecionar o arquivo real e preencher as credenciais.

O serviço temporário `bootstrap` depende do sucesso de `migrate`; o backend depende do sucesso de `bootstrap`. Apenas esse serviço recebe o arquivo selecionado como secret somente leitura em `/run/secrets/bootstrap_env`. O processo usa `node:util.parseEnv`, sem executar ou avaliar o conteúdo de um arquivo UTF-8 regular de até 64 KiB. `ADMIN_USERNAME`/`ADMIN_PASSWORD` não entram em `environment`, argumentos, build ou frontend.

O Compose executa `node backend/dist/cli/bootstrap-master-env.js`, também disponível pelo script `npm run bootstrap:env --workspace backend`. Seu usuário de sistema é root somente nesse container temporário, para conseguir ler o arquivo `0600` sem depender do UID do host. O papel PostgreSQL continua sendo `emulador`, sem superusuário nem criação de bancos; backend e frontend continuam sem root. Não há montagem de socket Docker, diretório pessoal ou arquivos externos ao projeto.

Sem master, os dois campos precisam estar presentes e válidos: nome de 3–32 caracteres `[a-z0-9_]`, senha de 12–128 caracteres. Os valores não são aparados. Use valores em uma única linha entre aspas simples: `$`, `#`, espaços, Unicode e aspas duplas permanecem literais. Essa forma não admite apóstrofo interno, mesmo escapado, nem barra invertida ao final do valor, devido à diferença de parsing entre Compose e Node. Barras invertidas internas permanecem literais. Para senhas com apóstrofo ou barra invertida final, use a alternativa interativa abaixo. Chaves `ADMIN_*` duplicadas são recusadas. Não tente escapar ou expandir valores pelo shell; não use `source .env`, `export` ou argumentos de shell para passar a senha. Exemplo sem credenciais:

```dotenv
ADMIN_USERNAME=''
ADMIN_PASSWORD=''
```

Quando já há master, o bootstrap não altera nome, senha, sessões nem dados existentes. Os campos podem ficar vazios depois de confirmar o primeiro login. Ausência, preenchimento parcial ou valores inválidos sem master fazem o serviço terminar com erro e impedem a inicialização dependente da API.

Se editar `.env` depois de uma tentativa de inicialização, recrie somente o bootstrap antes de repetir o início. Editores podem substituir o arquivo por outro inode; no Docker Desktop/WSL, reiniciar o container parado pode manter a montagem antiga. Com o banco saudável e as migrações já concluídas:

```bash
docker compose up -d --no-deps --force-recreate bootstrap
docker compose up -d
```

Isso também vale para esvaziar os campos depois do primeiro login. Não remova tabelas ou volumes para corrigir configuração. Mudar o seletor `BOOTSTRAP_ENV_SOURCE` provoca a recriação do bootstrap pelo Compose, pois o caminho não secreto também integra os labels do serviço.

Use `docker compose config --quiet` para validar a configuração sem imprimi-la. Não registre `docker compose config --environment`: esse modo exibe também variáveis lidas do `.env`. Sintaxe e mecanismo de montagem: [Node `util.parseEnv`](https://nodejs.org/api/util.html#utilparseenvcontent), [interpolação do Compose](https://docs.docker.com/compose/how-tos/environment-variables/variable-interpolation/) e [secrets locais](https://docs.docker.com/compose/how-tos/use-secrets/).

### Alternativa interativa

É possível criar o primeiro master em um terminal TTY, sem guardar sua senha no `.env`. Depois de `npm run setup`, inicie o banco, aplique as migrações e use:

```bash
docker compose up -d database
docker compose run --rm migrate
docker compose run --rm --no-deps backend npm run bootstrap:master --workspace backend
docker compose up -d
```

O comando pergunta nome e senha duas vezes, sem eco da senha, recusa argumentos e recusa uma segunda criação quando já existe master. Campos `ADMIN_*` podem permanecer vazios nesse fluxo. A aplicação normal nunca cria contas padrão. Não existe fluxo público de recuperação de senha esquecida do master; guarde a credencial escolhida com segurança.

## Configuração e operação

`.env.example` contém valores públicos e campos vazios para o primeiro master. As credenciais reais pertencem somente ao `.env` local, que tem permissão `0600`:

| Variável | Padrão | Uso |
| --- | --- | --- |
| `BOOTSTRAP_ENV_SOURCE` | `./.env` no exemplo/setup | Arquivo local do bootstrap; seletor ausente/vazio usa `.env.example` |
| `ADMIN_USERNAME` | vazio | Nome do primeiro master; lido somente pelo bootstrap |
| `ADMIN_PASSWORD` | vazio | Senha do primeiro master; lida somente pelo bootstrap |
| `APP_ORIGIN` | `http://127.0.0.1:5173` | Origem exata do navegador, sem barra final |
| `WEB_PORT` | `5173` | Porta publicada somente em loopback |
| `APP_DB_NAME` | `emulador` | Banco ativo; recuperação pode criar outro banco |
| `SESSION_TTL_HOURS` | `168` | Expiração fixa, entre 1 e 720 horas |
| `CATALOG_VOLUME` | `emulador-game-boy-dev_catalog_data` | Volume privado de ROMs/capas; recuperação usa outro volume |

Se mudar a porta, atualize também `APP_ORIGIN` e recrie os containers. Este Compose usa HTTP local e cookie sem `Secure`; `HttpOnly` e `SameSite=Strict` estão ativos. **Não é uma configuração de produção ou acesso pela rede.**

## Atualizar e diagnosticar

Use `docker compose ps -a` e `docker compose logs --tail=100 backend frontend migrate bootstrap` para diagnóstico, sem imprimir configuração/segredos. `docker compose stop` e `docker compose start` param/retomam sem remover dados. Os fontes não são montados nos serviços: alterações executáveis exigem nova imagem.

Para **somente frontend**, após validar o impacto:

```bash
docker compose build frontend
docker compose up -d --no-deps frontend
```

Não há motivo para migrar, reiniciar banco ou fazer backup completo numa mudança só de interface/documentação. Para **backend com migrações ou manutenção de dados**, primeiro encerre os jogos com sincronização confirmada, confira contexto/containers/volumes e siga, avançando somente após sucesso:

```bash
npm run backup
# Substitua PASTA pelo destino impresso:
npm run restore:verify -- .local/backups/PASTA
docker compose build backend frontend
docker compose stop backend
docker compose run --rm --no-deps migrate
docker compose up -d --no-deps backend frontend
curl --fail --retry 20 --retry-all-errors --retry-delay 1 http://127.0.0.1:5173/api/health
```

O PostgreSQL permanece iniciado. Reconstrua/recrie apenas serviços afetados; a sequência acima atende mudanças de contrato entre backend/frontend. Após manutenção de dados, faça e verifique o backup final. Se migração falhar, mantenha a API parada e investigue; não remova checksums/tabelas/volumes. Em banco ainda sem MASTER, conclua o [bootstrap](#primeiro-master-e-segredos-locais) antes de liberar a API.

Migrações em `backend/migrations/` são incrementais, transacionais e verificadas por checksum. Nunca edite uma já aplicada. A 004 criou nativos/reservas; a 005 ampliou rate limiting persistente; a 006 adicionou states e marcadores de reinício, sem converter nativos existentes. Não há rollback destrutivo automático.

Testes e seleção proporcional estão em [desenvolvimento](desenvolvimento.md#validação-por-impacto); resultados efetivamente executados em [validação](validacao.md).

## Persistência, backup e restauração

O volume `emulador-game-boy-dev_postgres_data` armazena contas, hashes, sessões, limites de tentativas, metadados de jogos, bytes/checksums/versões dos saves, reservas temporárias e migrações. ROMs e capas ficam no volume privado `emulador-game-boy-dev_catalog_data`, montado somente no backend em `/data/catalog`. Reiniciar/recriar containers preserva ambos. **Não use `docker compose down -v`, `docker volume rm` ou limpeza global do Docker** para operar o projeto. Apagar `.local/secrets` não redefine credenciais de um banco existente.

Com backend e banco iniciados:

```bash
npm run backup
# Substitua pela PASTA exata impressa pelo comando anterior:
npm run restore:verify -- .local/backups/PASTA
```

O backup é uma **pasta completa** com `database.dump`, `files/roms/`, `files/covers/`, `manifest.json` e checksum do manifesto. Guarde/transfira a pasta inteira: um dump SQL sozinho não recupera o catálogo. O comando usa a mesma trava PostgreSQL das mutações do catálogo e saves durante o dump e a cópia dos arquivos. Consultas continuam disponíveis, mas pause os jogos e evite uploads/edições durante o backup; a espera por gravação pode atingir o timeout. Arquivos são imutáveis e cada item é conferido por tamanho/SHA-256 contra os metadados. Capas antigas e eventuais órfãos de interrupções ficam retidos e também entram no backup, contando para a quota. Não existe coleta automática nesta etapa.

A pasta só recebe o manifesto final após sucesso. Backup interrompido/incompleto não pode ser restaurado. Se houver arquivo inesperado, ausente ou divergente, o comando falha: preserve a origem e investigue; não apague arquivos do volume manualmente. Não execute migração, recuperação ou manutenção manual de dados/arquivos simultaneamente ao backup.

`restore:verify` valida o manifesto e todos os arquivos, restaura o banco transacionalmente e copia os arquivos para um PostgreSQL temporário **sem rede, portas ou volume persistente**. Confere novamente referências do banco, console/extensão/tamanho e bytes restaurados. O manifesto v4 registra tamanho/checksum/versão de nativos e estados, identidade de ROM/core e marcadores de reinício; bytes, tombstones de slots e metadados ficam em `database.dump`. Manifestos v3 continuam aceitos com saves nativos e sem states. A restauração recalcula os checksums no banco. Manifestos v2 sem saves continuam aceitos e registram `console`; manifestos v1 anteriores são aceitos como GB e mantêm os arquivos `.gb` originais. A verificação não altera o esquema do dump: ao ativar uma recuperação antiga, o serviço `migrate` aplica as migrações pendentes, incluindo a identificação GB. Esse container é removido ao terminar; o banco/volume ativos não são alterados. Dumps legados `.dump` + `.sha256` continuam aceitos quando não contêm jogos.

Para recuperar em **novo banco e novo volume**, preservando os atuais:

```bash
npm run restore:recover -- .local/backups/PASTA
```

O comando restaura com o papel `emulador`, revoga as sessões/reservas recuperadas, preserva os saves e confere os arquivos em volume novo com permissões do backend. Imprime `APP_DB_NAME=...` e `CATALOG_VOLUME=...`. Para ativar, configure **ambos** no `.env`, anotando os valores anteriores. Mantenha o PostgreSQL iniciado e execute a sequência abaixo, avançando somente se cada comando terminar com sucesso:

```bash
docker compose stop backend
docker compose run --rm --no-deps migrate
docker compose run --rm --no-deps bootstrap
docker compose up -d --no-deps --force-recreate backend
docker compose up -d --no-deps frontend
curl --fail --retry 20 --retry-all-errors --retry-delay 1 http://127.0.0.1:5173/api/health
```

Entre novamente e confira contas, catálogo e progresso dentro dos jogos. O banco e o volume anteriores continuam preservados; para voltar, restaure os dois valores anteriores no `.env` e repita a recriação. Falha de recuperação deixa o destino não ativado para diagnóstico, sem alterar `.env` ou a origem. Se restaurar em outra máquina, execute `npm ci`, `npm run setup` e `docker compose up -d database` para criar o papel da aplicação e **novos segredos locais**; copie a pasta de backup inteira por meio seguro. Não é necessário recuperar segredos antigos do banco. Restaure o backup, configure os dois destinos impressos e só então inicie os serviços restantes; o master recuperado será preservado pelo bootstrap.

Política desta fase local: backup manual antes de migrações/mudanças de dados e após sessões relevantes de desenvolvimento, com restauração verificada. Pasta raiz de backups `0700`, arquivos `0600`, sem exclusão automática. Backups contêm material sensível, incluindo hashes de senhas, ROMs e saves; checksums não são criptografia nem prova de autoria. Use apenas backups de origem confiável. Agendamento, cópia externa criptografada, retenção automática e objetivos de recuperação ainda precisam ser definidos, além de um ensaio completo em outra máquina, antes de uma eventual implantação externa.

## Limites locais e diagnóstico de acesso

Este Compose usa Vite de desenvolvimento, HTTP e loopback; não é implantação externa. Backend e banco não publicam portas. Uma eventual exposição externa exige autorização e revisão própria de HTTPS, proxy, acesso e operação.

`TRUSTED_PROXY_HOST=frontend` é definido no backend pelo Compose. Vite sanitiza encaminhamento e o backend confere o peer; health não depende do proxy/DNS para permitir primeiro boot. Falha nessa validação nas demais rotas retorna 503. NAT/Docker Desktop podem compartilhar IPs entre clientes. Bloqueios de login persistem no PostgreSQL: não reinicie serviços nem apague registros para contorná-los. Aguarde `Retry-After`; regras em [autenticação](autenticacao.md#limitação-de-tentativas).

O core fixado não garante todo cartucho/periférico. States dependem da ROM/core exatos; preserve as fontes/compilação correspondentes ao planejar recuperação, conforme [saves](saves.md) e [fontes do motor](fontes-emulador.md). O backup de dados não contém automaticamente os binários do emulador. Pendências exclusivas do navegador não entram no backup do servidor.

Não há coleta automática de arquivos retidos, recuperação pública da senha de master nem auditoria administrativa completa. Limitações testadas estão em [validação](validacao.md); orientações para agentes em [AGENTS.md](../AGENTS.md). Nenhuma operação autoriza publicar segredos, ROMs ou saves pessoais.

# Emulador Game Boy

Aplicação web para **Game Boy (GB) e Game Boy Advance (GBA)**, com interface em português, temas claro/escuro e controles de teclado/toque. Inclui login, administração de jogadores, catálogo e emulação no navegador, com um save nativo por usuário/jogo.

O catálogo começa vazio. Nenhum jogo, BIOS externa ou save pessoal acompanha o projeto. O master cadastra suas ROMs e capas; jogadores acessam os jogos ativos. Não há cadastro público, login social ou senha padrão.

## Pré-requisitos

| No computador | Uso |
| --- | --- |
| Git | Clonar o repositório |
| Node.js 24.16 ou superior na linha 24 e npm 11 | Instalar dependências e executar os scripts locais |
| Docker Engine e Docker Compose | Executar aplicação, banco, migrações e motor |
| Porta 5173 livre | Acesso local à interface |

Ambiente validado: Ubuntu 24.04/WSL2, **Node 24.16.0/npm 11.13.0**, Docker Engine **29.5.3** e Compose **5.1.4**. No Windows, use WSL2 com a integração do Docker; WSL não é requisito para Linux. Compose precisa suportar `service_completed_successfully` e o build usa BuildKit.

Os containers usam **Node 24.21.0/npm 11.19.0**, PostgreSQL **18.6** e, nos testes visuais, Playwright **1.63.0**. A aplicação fixa NestJS **12.1.1**, React **19.3.0**, Vite **8.3.1** e TypeScript **6.0.3**. `package-lock.json` fixa a árvore instalada por `npm ci`.

A instalação inicial requer acesso aos registros npm/Docker e às fontes públicas no GitHub. O motor é compilado e servido localmente, sem CDN durante o jogo. Python 3 no host só é necessário para os ensaios operacionais.

## Instalação local

Substitua `URL_DO_REPOSITORIO` pelo endereço do repositório ao qual você tem acesso:

```bash
git clone "URL_DO_REPOSITORIO" emulador
cd emulador
npm ci
npm run setup
```

O setup cria `.env` a partir de `.env.example` e gera segredos aleatórios do banco em `.local/secrets/`. Reexecutá-lo preserva os valores existentes e acrescenta o seletor de arquivo do bootstrap quando ausente. `.env` fica com permissão `0600` e não deve ser versionado.

**Antes de iniciar, edite `.env` em um editor** e preencha os dois campos vazios com suas próprias credenciais:

```dotenv
ADMIN_USERNAME=''
ADMIN_PASSWORD=''
```

Usuário: 3–32 caracteres, letras minúsculas ASCII, números ou `_`. Senha: 12–128 caracteres, longa e exclusiva. Use uma única linha entre aspas simples para preservar `$`, `#` e espaços literalmente. Não use apóstrofo interno, mesmo escapado, nem barra invertida no fim; para esses casos, use o [bootstrap interativo](docs/operacao.md#alternativa-interativa). Os campos vazios acima não são credenciais utilizáveis. Não exporte a senha para o shell nem a passe em argumentos.

Confirme que o Docker está conectado ao daemon local esperado e que a porta está livre:

```bash
docker context show
docker info --format '{{.Name}} | {{.OperatingSystem}}'
docker ps --format '{{.Names}}\t{{.Ports}}'
ss -ltn
```

Em seguida:

```bash
docker compose config --quiet
docker compose up -d --build
docker compose ps -a
curl --fail --retry 20 --retry-all-errors --retry-delay 1 http://127.0.0.1:5173/api/health
```

Abra **<http://127.0.0.1:5173>** e entre com o usuário/senha definidos no `.env`. Use essa origem exata; `localhost` pode ser recusado pela proteção de origem.

O Compose **`emulador-game-boy-dev`** aguarda o banco, aplica migrações e executa o serviço de bootstrap antes de liberar a API. `migrate` e `bootstrap` terminarem em `Exited (0)` é esperado. Sem master, credenciais ausentes/incompletas/inválidas impedem a inicialização. Se já existe master, seus dados são preservados e os campos de bootstrap são ignorados.

Se corrigir `.env` depois de uma tentativa de boot, recrie a montagem do arquivo com `docker compose up -d --no-deps --force-recreate bootstrap` e repita `docker compose up -d`. O [guia de operação](docs/operacao.md#primeiro-master-e-segredos-locais) explica esse cuidado no Docker Desktop/WSL.

As credenciais são lidas diretamente do arquivo pelo serviço temporário de bootstrap; não são variáveis de ambiente do container nem entram no build/frontend. O banco recebe somente o hash Argon2id. Depois de confirmar o primeiro login, você pode esvaziar os dois campos no `.env`. Não publique esse arquivo nem use `docker compose config --environment`, que exibe seu conteúdo.

## Usar a aplicação

- **Administração:** o master cria jogadores com senha temporária, bloqueia/desbloqueia e redefine senhas. O jogador troca a temporária antes de acessar jogos.
- **Catálogo:** o master cadastra nome, `.gb`/`.gba`, capa opcional e disponibilidade. A ROM e o console são imutáveis.
- **Jogar:** escolha um jogo ativo, inicie e salve pelo menu do próprio jogo. Aguarde **Salvo no servidor** e use **Salvar e voltar** antes de trocar de aparelho.
- **Controles:** setas, A/B em X/Z, Start/Select em Enter/Shift; L/R do GBA em Q/W. Há controles de toque, pausa, áudio e tela cheia.

O progresso é memória nativa de cartucho, **não save state**. Uma reserva evita gravação simultânea do mesmo usuário/jogo. Falhas de rede deixam uma cópia pendente por conta/jogo no navegador; não limpe seus dados enquanto houver pendência. Detalhes, limites de upload e solução de conflitos no [guia de uso](docs/guia-de-uso.md).

## Operação e backup

A única porta publicada é `127.0.0.1:5173`; backend e PostgreSQL ficam privados. Este Compose usa HTTP local e o servidor de desenvolvimento Vite. Não é uma implantação de produção ou de acesso pela rede.

```bash
docker compose logs --tail=100 backend frontend migrate bootstrap
docker compose stop
docker compose start

# Com banco/backend iniciados: backup completo e verificação isolada
npm run backup
npm run restore:verify -- .local/backups/PASTA
```

Substitua `PASTA` pelo destino impresso pelo backup. Contas/saves ficam no PostgreSQL; ROMs/capas, em volume privado. Guarde a **pasta completa** de backup. Nunca use `docker compose down -v` ou remova volumes para reiniciar a aplicação.

[Operação, migrações, persistência, restauração e testes](docs/operacao.md) descreve os comandos completos, inclusive recuperação em novo banco/volume e bootstrap interativo alternativo. Faça backup verificado antes de atualizar uma instalação existente.

## Limites e documentação

Não há importação/exportação de saves, slots extras, administração de saves, exclusão definitiva de jogos ou recuperação pública de senha. GBC exclusivo e outros consoles estão fora. ROMs chegam necessariamente ao navegador autorizado: não há promessa de DRM. Compatibilidade completa, aparelhos físicos e outros navegadores ainda precisam de testes.

O núcleo mGBA usa commit de desenvolvimento fixado e fontes verificadas, com licença e código correspondente disponíveis na própria aplicação. Veja [fontes do motor](docs/fontes-emulador.md).

A etapa anterior registrou **57 testes de API e 49 cenários Chromium aprovados**, além de restauração real de saves GB/GBA. Esses resultados são históricos; a validação da mudança de bootstrap está separada em [evidências](docs/validacao.md).

- [Índice da documentação](docs/README.md)
- [Guia de uso](docs/guia-de-uso.md)
- [Operação local e testes](docs/operacao.md)
- [Arquitetura e decisões](docs/decisoes.md)
- [Autenticação](docs/autenticacao.md), [catálogo](docs/catalogo.md) e [emulação/saves](docs/emulacao.md)
- [Histórico técnico](docs/historico.md) e [orientação de desenvolvimento](docs/desenvolvimento.md)

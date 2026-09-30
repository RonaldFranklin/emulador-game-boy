# Catálogo local de GB e GBA

Esta entrega permite ao master cadastrar uma ROM `.gb` ou `.gba`, definir nome, capa opcional e disponibilidade, além de editar nome/capa/disponibilidade posteriormente. O jogador vê somente jogos ativos. O catálogo organiza arquivos e metadados; execução e saves pertencem ao módulo [emulação](emulacao.md). Não há botão de download de ROM.

A autorização desta etapa é posterior às entregas de autenticação e temas. Os comandos operacionais ficam no [README](../README.md), e os resultados efetivamente executados em [validação](validacao.md). As regras de sessão e conta continuam em [autenticação](autenticacao.md).

## Comportamento e identidade

Cada jogo recebe um UUID estável, independente do nome. Renomear, alterar a capa ou ativar/desativar preserva esse identificador. Não existe exclusão de jogo nesta entrega.

O conteúdo da ROM e seu console (`GB` ou `GBA`) são imutáveis após o cadastro. A edição não aceita o campo de arquivo `rom`; uma trigger PostgreSQL também impede alterações em UUID, console, chave, hash, tamanho e dados do cabeçalho associados à ROM. A substituição de ROM e seus efeitos sobre saves continuam fora do escopo.

O SHA-256 de todo o arquivo ROM tem restrição única no banco. Enviar os mesmos bytes com outro nome de arquivo ou título recebe HTTP 409. Nomes de exibição podem se repetir; a identidade é o UUID e a duplicidade de ROM é determinada pelo conteúdo.

O nome informado é aparado nas extremidades e deve conter de 1 a 120 caracteres, sem controles internos. A extensão e o nome original do arquivo não definem caminhos no armazenamento. O nome original não é preservado como metadado público.

Um master vê jogos ativos e inativos. Um jogador vê apenas ativos; tentar acessar a capa de jogo inativo retorna 404. Usuários com troca obrigatória de senha não acessam o catálogo até concluir a troca. As verificações são feitas no servidor.

## Contrato HTTP

Todos os endpoints exigem uma sessão válida. Respostas de jogo contêm somente:

```text
id, name, console, active, hasCover, coverUrl, createdAt, updatedAt
```

`console` é `GB` ou `GBA`, determinado e validado pelo servidor na criação. Não é aceito como campo de entrada nem de edição.

`coverUrl` é `null` ou `/api/games/<UUID>/cover`. Não são retornados nomes de arquivos internos, caminhos de disco, hash da ROM ou endereço para obtê-la. Datas usam ISO 8601.

| Método e rota | Acesso | Entrada | Sucesso |
| --- | --- | --- | --- |
| `GET /api/games` | Master ou jogador, sem troca pendente | — | 200, `{games:[...]}`; master recebe todos, jogador somente ativos |
| `POST /api/games` | Master | Multipart: `name`, `active`, `rom`; `cover` opcional | 201, `{game}` |
| `PATCH /api/games/:id` | Master | Multipart: `name`/`active` opcionais, `cover` opcional ou `removeCover` | 200, `{game}` |
| `GET /api/games/:id/cover` | Master ou jogador autorizado ao jogo | UUID v4 | 200, imagem PNG |

Na criação, `active` é obrigatório e deve ser a string `true` ou `false`. Na edição, os campos omitidos mantêm os valores existentes. `removeCover`, quando enviado, deve ser a string `true` e não pode ser combinado com um arquivo `cover`. Uma edição vazia é rejeitada. Campos repetidos que resultem em arrays, objetos aninhados, campos desconhecidos e arquivos em campos não previstos são recusados.

Os envios de criação/edição são exclusivamente `multipart/form-data`. Ao usar `FormData` no navegador, deixar o navegador gerar o `Content-Type` com o boundary. As rotas de autenticação e usuários continuam usando JSON.

A capa é entregue com `Content-Type: image/png`, `Content-Disposition: inline` e `Cache-Control: no-store`. A consulta recebe os mesmos controles de sessão e disponibilidade do catálogo; não há pasta pública de capas. Não existe exclusão definitiva. O módulo play fornece a ROM por rota autenticada somente para jogos ativos, sem servir diretórios.

| Situação | Resposta |
| --- | --- |
| Sem sessão válida | 401 |
| Perfil, troca obrigatória, origem ou CSRF sem permissão | 403 |
| Campos, UUID, ROM ou capa inválidos | 400 |
| Jogo/capa inexistente ou capa de jogo inativo para jogador | 404 |
| ROM duplicada ou limite de jogos atingido | 409 |
| Tipo de conteúdo inadequado | 415 |
| Arquivo, formulário ou quantidade de campos acima do limite | 413 |
| Dois uploads já em andamento | 429 |
| Prazo do upload excedido | A requisição é encerrada; há proteção por timeout de 60 segundos |
| Quota do armazenamento atingida | 507 |
| Capa referenciada ausente ou com integridade incorreta | 503, sem expor detalhes do arquivo |
| Falha inesperada de banco ou gravação | 500 genérico; detalhes sensíveis não são enviados |

## Admissão de ROMs

O servidor detecta os formatos pelo conteúdo do cabeçalho e exige extensão correspondente (`.gb`/`.gba`, sem diferença entre maiúsculas e minúsculas). MIME declarado não determina o console. Cabeçalho com assinaturas dos dois consoles é ambíguo e recusado. Não há conversão de formato ou substituição de bytes. GBC exclusivo continua fora.

### Game Boy (GB)

A validação usa o cabeçalho descrito no [Pan Docs, fonte do projeto gbdev](https://github.com/gbdev/pandocs/blob/master/src/The_Cartridge_Header.md). Trata-se de verificação estrutural de admissão, não de prova de autenticidade, integridade original do jogo ou compatibilidade de execução.

Regras adotadas pelo projeto:

- Extensão `.gb`, sem distinguir maiúsculas/minúsculas; tamanho entre 32 KiB e 8 MiB.
- Logo de 48 bytes em `0x0104–0x0133` e checksum do cabeçalho em `0x014D` válidos.
- Código de tamanho `0x0148` entre `0x00` e `0x08`, com quantidade exata de bytes declarada; arquivos truncados ou com bytes extras são recusados.
- Códigos `0x52`, `0x53` e `0x54` são recusados: o Pan Docs os identifica como valores legados sem casos conhecidos e de origem incerta.
- Em `0x0143`, bit 7 desativado admite o formato monocromático; `0x80` admite ROM com funcionamento também em Game Boy monocromático. `0xC0` e outros valores com bit 7 ativado são recusados.
- O checksum global `0x014E–0x014F` não é exigido. O Pan Docs distingue esse campo do checksum conferido pelo boot ROM. O projeto calcula SHA-256 integral para identificar duplicatas e verificar arquivos persistidos/restaurados.

O byte de tipo de cartucho precisa pertencer à lista conhecida adotada no código: `00`, `01`, `02`, `03`, `05`, `06`, `08`, `09`, `0B`, `0C`, `0D`, `0F`, `10`, `11`, `12`, `13`, `19`, `1A`, `1B`, `1C`, `1D`, `1E`, `20`, `22`, `FC`, `FD`, `FE` ou `FF` (hexadecimal). O código de RAM pode ser `00–05`; `01` é tolerado para cabeçalhos legados. Essas listas são uma política de admissão, não uma lista de hardware já emulado.

Não se exige título interno específico, licença comercial ou checksum global válido. Não se analisa o comportamento das instruções da ROM nem se executa o conteúdo. A matriz real de cartuchos compatíveis continua limitada aos testes descritos em validação; admissão estrutural não é prova de execução. Aceitar uma ROM dual-mode `0x80` não amplia o projeto para emulação de Game Boy Color.

### Game Boy Advance (GBA)

Fonte: [GBATEK mantido no projeto mGBA — Cartridge Header](https://github.com/mgba-emu/gbatek/blob/gh-pages/gba.md#gbacartridgeheader), consultado no arquivo-fonte `gba.md`. O cabeçalho ocupa 192 bytes; a política desta aplicação aceita arquivos entre 192 bytes e 32 MiB, sem exigir potência de dois ou preenchimento adicional. Esse mínimo permite conferir a estrutura, não prova que exista um programa executável completo.

- Logo de 156 bytes em `0x004–0x09F`, tolerando apenas os bits variáveis documentados: 2/7 em `0x09C` e 0/1 em `0x09E`.
- `0x0B2=0x96`; unidade `0x0B3=0` e dispositivo `0x0B4=0`. Recusamos dispositivos especiais/debug com outro valor por política de admissão.
- Reservados `0x0B5–0x0BB` e `0x0BE–0x0BF` zerados.
- Complemento `0x0BD` igual a `(-0x19 - soma(bytes 0x0A0..0x0BC)) & 0xFF`.

Versão `0x0BC` pode variar; não se exige título interno, código comercial ou licença específicos. Não se analisa opcode de entrada nem hardware especial. ELF, BIOS e multiboot sem esse cabeçalho são recusados; um arquivo que compartilhe a estrutura de cartucho pode passar sem garantia de execução. O complemento também aparece no [gbafix oficial do devkitPro](https://github.com/devkitPro/gba-tools/blob/master/src/gbafix.c).

O [detector do mGBA](https://github.com/mgba-emu/mgba/blob/master/src/gba/gba.c) tem políticas próprias para ELF/ROMs não corrigidas; a validação de upload não usa esse detector nem promete aceitar tudo o que esse emulador abre.

### Console e futuro player

`console` identifica o formato, sem nome de biblioteca/core persistido. O backend mapeia `GB`/`GBA` para os adaptadores mGBA definidos em código, conforme [emulação](emulacao.md). O player habilita Jogar para ativos e restaura o save nativo individual; nenhuma mudança no core deve converter bytes ou mudar o UUID/console persistido.

## Capas e limites de recursos

A validação considera os bytes recebidos, e não confia apenas em extensão ou MIME declarados. São aceitos PNG ou JPEG estáticos. SVG, GIF, outros formatos e PNG animado são recusados.

A biblioteca [Sharp, API oficial de entrada e processamento](https://github.com/lovell/sharp/blob/main/lib/index.d.ts) lê os metadados, aplica limite de pixels e decodifica integralmente a imagem. A imagem é orientada conforme seus metadados e recodificada como PNG; nome original, bytes originais e metadados não são publicados. Falhas de decodificação ou dados incompletos são rejeitados.

| Recurso | Limite desta entrega |
| --- | --- |
| ROM GB / GBA | 8 MiB / 32 MiB por arquivo |
| Capa de entrada e PNG processado | 2 MiB cada |
| Dimensões da capa | Até 2048 em cada eixo e 4.000.000 pixels no total |
| Arquivos por criação | Uma ROM e, opcionalmente, uma capa |
| Arquivos por edição | Uma capa, sem ROM |
| Campos de texto multipart | Até três; nomes de até 32 bytes e valores de até 512 bytes |
| Partes multipart | Até cinco |
| Corpo multipart total | 32 MiB + 2 MiB + 64 KiB de margem para o formulário |
| Uploads simultâneos por processo da API | Dois, contando parsing e processamento até concluir a operação |
| Recebimento do upload | Prazo absoluto de 60 segundos |
| Processamento Sharp | Timeout de cinco segundos por operação de imagem |
| Jogos cadastrados | 1000 |
| Arquivos de catálogo, incluindo capas antigas e resíduos | 10.000 e 8 GiB no total |

Uma imagem de 2048 × 2048 ultrapassa quatro milhões de pixels e é recusada, apesar de cada eixo estar no limite. Dois uploads simultâneos não significam dois uploads por minuto: não há essa quota temporal.

O [Multer, documentação oficial do Express](https://expressjs.com/en/resources/middleware/multer/), é aplicado somente às rotas de criação/edição, com contagem de campos/arquivos, profundidade de campos desabilitada e armazenamento temporário limitado em memória. Os arquivos só são gravados no volume após validação. O parser comporta até 32 MiB de ROM por envio; GB continua sujeito a 8 MiB na validação específica. Com dois envios há até cerca de 68 MiB de bytes de arquivos retidos; a concatenação pode duplicar temporariamente esses buffers (cerca de 136 MiB), além do runtime e decodificação de imagem. Não se trata de limite global de RAM do processo. Capas, prazo, concorrência e quotas permanecem limitados; o aumento do tamanho de GBA não aumenta a quota total de 8 GiB. Uploads interrompidos ou recusados liberam sua vaga; requisições lentas ou que excedam o limite total podem ter a conexão encerrada.

O limite total de armazenamento inclui arquivos antigos, porque eles são preservados. Não há limpeza automática nem expansão automática da quota. Chegar ao limite exige revisão local e uma política explícita de manutenção; não apagar arquivos manualmente sem reconciliar referências e backups.

## Autorização e persistência

Toda mutação exige a origem exata configurada, `X-Requested-With: XMLHttpRequest` e o token CSRF da sessão em `X-CSRF-Token`, além do cookie HttpOnly. Os guards globais verificam sessão, perfil master e troca obrigatória antes do interceptor que interpreta o multipart. O middleware permite multipart apenas nas rotas previstas do catálogo; a proteção das demais rotas permanece JSON.

As alterações revalidam sessão e papel dentro da transação e sob bloqueio da linha do usuário, seguindo o padrão de autenticação existente. A disponibilidade do jogo e a existência da capa são verificadas novamente ao buscar a imagem. Uma página antiga ou URL conhecida não concede acesso a um jogador após a desativação.

A migração `backend/migrations/002-catalog.sql` cria `games`, seus índices, restrições e proteção da identidade/ROM. A migração incremental `003-catalog-consoles.sql` preenche `console=GB` para jogos anteriores, preservando suas colunas/UUIDs/arquivos. O campo fica obrigatório, sem valor padrão para novas inserções, e integra a trigger de identidade. Checks vinculam console, extensão, tamanho e campos específicos GB (nulos para GBA).

A tabela guarda metadados, chaves internas, hashes SHA-256 e tamanhos de ROM e capa. Os bytes ficam fora do PostgreSQL e fora da raiz pública:

```text
CATALOG_STORAGE_DIR/
  roms/<UUID gerado>.gb
  roms/<UUID gerado>.gba
  covers/<UUID gerado>.png
```

`CATALOG_STORAGE_DIR` deve ser um caminho absoluto específico; o padrão é `/data/catalog`. As chaves são geradas pelo servidor, sem reutilizar nomes enviados pelo cliente. Diretórios novos usam `0700` e arquivos novos `0600`. Arquivos são criados exclusivamente, sincronizados em disco e referenciados no banco somente depois da gravação. A leitura de capa rejeita links simbólicos e confere tamanho/hash antes de responder.

Não há filesystem público ou rota genérica de arquivo. O armazenamento usa volume próprio conforme o Compose e deve acompanhar o banco nas operações de backup e recuperação.

## Concorrência, falhas e retenção

Todas as mutações do catálogo obtêm `pg_advisory_xact_lock(781004)` antes de verificar quota, gravar arquivos ou alterar o catálogo. A mesma chave é exportada em `backend/src/games/catalog-constants.ts` e usada pela operação de backup. Esse bloqueio serializa gravações concorrentes; a restrição única de SHA-256 fornece uma segunda garantia para duplicatas.

ROMs e capas são arquivos imutáveis com nomes exclusivos. Uma nova capa gera outro arquivo. Remover a capa pela interface remove sua referência atual no banco; capas anteriores permanecem no volume. Elas não ficam acessíveis pela API. Não existe coletor de arquivos antigos nesta entrega.

Se uma gravação ou consulta falha antes de concluir o callback da transação, os arquivos criados por aquela operação são removidos enquanto o bloqueio ainda está retido, e a transação é desfeita. Arquivos de outras operações e capas anteriores não são removidos.

Se a conexão falha durante o commit, o resultado pode ser desconhecido para a aplicação. Nesse caso os arquivos são preservados: excluir poderia remover um arquivo já confirmado pelo banco. Queda do processo ou falha de limpeza também pode deixar arquivos sem referência. Esses resíduos consomem quota e exigem reconciliação local; não significam que exista um jogo publicado ou uma rota que os exponha.

A API não tenta converter um erro de commit em sucesso nem promete ausência absoluta de resíduos após falhas do processo. O manifesto de backup lista os arquivos e as referências atuais, permitindo identificar resíduos por comparação sem exclusões silenciosas.

## Backup e recuperação conjunta

Um dump SQL sozinho deixa de ser suficiente para restaurar um catálogo populado. O procedimento vigente, documentado no [README](../README.md), gera um conjunto com `database.dump`, arquivos do catálogo e manifesto com tamanhos e checksums.

Durante o dump e a cópia dos arquivos, o backup mantém um bloqueio consultivo exclusivo de sessão na chave `781004`. As mutações do catálogo aguardam; os arquivos referenciados pelo snapshot não podem ser substituídos ou removidos durante a cópia. A operação não altera ROMs, capas, contas ou sessões do banco ativo.

O manifesto vigente v3 inclui saves nativos no dump e o console por jogo e permite `.gb`/`.gba`; a verificação compara tipo, extensão, tamanho, referências e SHA-256 após a restauração. Manifestos v2 sem saves continuam aceitos. Manifestos v1 sem console são interpretados como GB e continuam aceitos; não podem declarar GBA. Dumps antigos sem catálogo continuam aceitos pelo fluxo legado. Nenhuma chave ou byte de ROM antiga é renomeado/converso.

A verificação usa recursos isolados e confere as referências e a integridade dos arquivos. O esquema restaurado mantém sua versão até executar `migrate` na ativação; a migração de um catálogo GB populado é testada separadamente. A recuperação efetiva cria um banco e um volume novos, preservando os destinos ativos; sessões recuperadas são revogadas. A ativação deve selecionar ambos os destinos conforme o README, sem misturar banco recuperado com arquivos de outro catálogo.

Backups podem conter ROMs fornecidas pelo operador, capas, hashes de senha e outros dados privados. Permanecem fora do Git. As regras de cópia externa, retenção, criptografia e recuperação em outra máquina continuam pendentes antes de uso real; checksums detectam alteração, mas não criptografam os dados.

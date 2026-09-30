# Emulação e save nativo

Entrega autorizada após aprovação do catálogo GB/GBA. O objetivo é executar jogos no navegador e manter **um save nativo de cartucho por usuário e jogo**, sem importação/exportação de arquivos, múltiplos slots ou painel administrativo de saves. Resultados efetivamente executados ficam em [validação](validacao.md).

## Identidade e autorização

O UUID e o console vêm do catálogo persistido. O servidor escolhe o identificador do adaptador por esse console; parâmetros de core enviados pelo cliente não são aceitos. Só jogos ativos podem ser iniciados, inclusive por MASTER. Sessão válida, conta habilitada e ausência de troca obrigatória são verificadas em cada operação. Uma reserva de jogo não substitui a sessão.

`GET /api/play/:id` fornece metadados do player e a URL privada da ROM. `GET /api/play/:id/rom` revalida o acesso, abre somente a chave gerada pelo servidor e confere tamanho/SHA-256 antes da resposta. Não há diretório público ou botão de download. Respostas privadas não devem ser armazenadas em cache; downloads simultâneos são limitados.

Para emular, os bytes da ROM precisam chegar ao navegador. Um usuário autorizado pode inspecioná-los; a aplicação **não promete DRM**. Bloquear a conta ou desativar um jogo impede novas consultas e sincronizações; não recolhe bytes já recebidos. O player pausa quando detecta perda de autorização.

## Save do cartucho e save state

O botão de salvar dentro do próprio jogo grava SRAM/EEPROM/Flash emulada. É esse conteúdo nativo que a aplicação sincroniza. Não existe save state da CPU, da tela ou do ponto exato de execução. Um jogo sem memória persistente não ganha capacidade de salvar por causa do player. Use a função de salvar do jogo antes de sair e aguarde a confirmação do servidor.

O save remoto é restaurado antes do primeiro frame. A imagem inicial da memória não deve ser enviada como uma gravação nova: só mudanças observadas depois da inicialização são candidatas à sincronização. Save vazio é recusado. Falha de restauração interrompe a inicialização em vez de começar silenciosamente sem o progresso existente.

## Contrato de persistência

Todas as mutações usam JSON, cookie HttpOnly, origem exata, cabeçalho AJAX e CSRF. Nunca recebem `userId`: o proprietário é a conta da sessão.

| Método/rota | Entrada | Resposta |
| --- | --- | --- |
| `POST /api/play/:id/lease` | `{}` | Reserva exclusiva e save atual, com versão e bytes base64 ou `null` |
| `POST /api/play/:id/lease/renew` | `leaseId` | Nova expiração |
| `DELETE /api/play/:id/lease` | `leaseId` | 204; libera somente a própria reserva |
| `PUT /api/play/:id/save` | `leaseId`, `baseVersion`, `dataBase64`, `sha256` opcional | Nova versão, checksum e data confirmados |

A reserva dura 120 segundos e deve ser renovada a cada 30 segundos. Duas abas ou dispositivos da mesma conta/jogo não podem escrever simultaneamente. A reserva pertence também à sessão; logout/revogação remove sua validade. Expiração/conflito retorna 409. A versão esperada precisa coincidir com a versão atual: nunca há escolha automática pela gravação mais recente enviada pelo cliente. Repetir exatamente a última gravação confirmada é idempotente, útil quando a resposta se perde.

Save nativo: 1 byte–1 MiB, base64 canônico e checksum conferido. Até uma alteração por segundo por save; repetição idempotente não é nova gravação. Quota local global de 1 GiB/10.000 saves. 429 indica frequência excedida, 507 quota, 401 sessão inválida, 403 troca obrigatória/CSRF/origem e 404 jogo inexistente/inativo. Respostas de erro não revelam progresso de outro usuário.

PostgreSQL armazena os bytes (`bytea`), tamanho, SHA-256 e versão na mesma linha/transação, com chave única usuário+jogo. Não há janela entre gravar um arquivo e confirmar seus metadados. A migração incremental cria essas tabelas sem alterar jogos, contas ou sessões preexistentes.

## Backup e recuperação

Saves nativos ficam dentro de `database.dump`. O manifesto v3 registra usuário/jogo, versão, tamanho e checksum, sem duplicar os bytes no JSON. O backup mantém a mesma trava das mutações de catálogo e saves durante dump/snapshot/cópia. A restauração compara as referências e calcula novamente o checksum dos bytes no PostgreSQL.

Manifestos v1/v2 anteriores continuam aceitos com zero saves. A recuperação cria banco e volume novos; mantém saves, revoga sessões e libera reservas antigas. Ativar a recuperação exige selecionar os dois destinos no `.env` e aplicar migrações, conforme o [README](../README.md). Saves que existem somente no navegador ainda não fazem parte do backup do servidor.

## Limitações

Rede, fechamento abrupto, falta de espaço ou falha do navegador podem impedir a última gravação. Confirmação local e confirmação do servidor são estados distintos. O fechamento da aba não é o mecanismo principal de sincronização. Não se promete perda impossível nem compatibilidade com todo cartucho. Fontes/licenças e limites de compatibilidade estão em [fontes do motor](fontes-emulador.md); testes efetivamente executados estão em [validação](validacao.md). Aguarde a gravação interna do jogo terminar antes de pausar/sair: capturar a memória durante sua escrita não equivale a confirmação do jogo.

## Player e recuperação local

Mapeamento do servidor: `GB → mgba-gb-v1`, `GBA → mgba-gba-v1`; ambos usam a mesma compilação mGBA, com configuração explícita de plataforma e modelo DMG para GB. Versões, licença MPL-2.0, patch de restauração nativa e comandos estão em [fontes do motor](fontes-emulador.md). O catálogo não persiste nome de core.

Cada início cria uma instância WASM isolada, sem SDK com persistência automática. Restaura os bytes, confere leitura integral antes do primeiro frame e só então libera execução. Começa pausada/muda internamente; Iniciar libera vídeo e Ativar áudio solicita áudio por gesto. Canvas 160×144 no GB e 240×160 no GBA, controles de teclado/toque com L/R apenas GBA. Saída remove listeners/timers/RAF, descarrega core e fecha AudioContext. Avisos de áudio/tela cheia não bloqueiam pausa/retomada; erros de sessão/sincronização pausam o jogo.

O player compara o save a cada 2 s, guarda alterações primeiro no IndexedDB e envia uma gravação por vez, respeitando intervalo de 1,1 s entre confirmações. Pausa, ocultação da página e saída capturam novamente depois de eventual PUT pendente. Heartbeat começa ao adquirir a reserva, inclusive durante carga lenta, e uma nova renovação é exigida antes de executar ou retomar. Pedidos de save/reserva têm timeout de 12 s; ROM, 60 s. Timers do navegador podem atrasar em segundo plano; reserva expirada não é silenciosamente retomada.

IndexedDB `emulador-save-recovery-v1`, chave composta por UUID do usuário+jogo, contém somente progresso pendente. Não contém credenciais/cookie e não usa localStorage (este continua apenas com o tema). A aplicação só consulta a chave da conta autenticada e jogo atual. O registro tem revisão local comparada atomicamente para uma aba antiga não apagar a cópia escrita por outra. Não há seleção de slots. Uma resposta ambígua mantém a gravação original e, se o core avançou, seu sucessor: primeiro confirma/reenvia a original idempotentemente, depois envia o sucessor com a versão confirmada.

Antes de apagar/promover recuperação, o cliente valida a integridade do snapshot remoto. Ao voltar, conteúdo remoto idêntico confirma a pendência; versão base coincidente permite reenvio. Versão remota divergente bloqueia o início e preserva ambos, sem merge automático. O usuário pode manter a pendência ou confirmar descarte da cópia local para usar o servidor. Dados de recuperação não são criptografados contra inspeção do perfil do navegador; outro usuário da aplicação não os recebe, mas compartilhar o perfil físico do navegador exige cuidado.

O estado “Salvo no servidor” confirma bytes de cartucho, não execução recente nem save state. Memória toda zerada/`FF` e memória inicial sem mudança não sobrescrevem o remoto. Falha de IndexedDB pausa sem fingir que houve confirmação local. Saída offline oferece manter cópia local somente após sua confirmação; logout fica indisponível no player até voltar à biblioteca. `beforeunload` só solicita confirmação ao navegador, sem prometer conclusão assíncrona.

A compilação inicia com 64 MiB e permite no máximo 512 MiB de memória WASM por instância; há cópias adicionais da ROM/save no JavaScript. Dispositivos com pouca memória podem não iniciar GBA. O fechamento libera a instância para coleta pelo navegador, sem garantir devolução imediata de memória pelo processo.

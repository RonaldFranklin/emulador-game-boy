# Emulação, save nativo e estados

Entrega autorizada após aprovação do catálogo GB/GBA. O objetivo é executar jogos no navegador e manter **um save nativo de cartucho por usuário e jogo**, com save states e gerenciamento aprovados posteriormente no [contrato de saves](saves.md), sem importação/exportação de arquivos. Resultados efetivamente executados ficam em [validação](validacao.md).

## Identidade e autorização

O UUID e o console vêm do catálogo persistido. O servidor escolhe o identificador do adaptador por esse console; o cliente não escolhe outro motor; uploads de states devem declarar a identidade exata permitida. Só jogos ativos podem ser iniciados, inclusive por MASTER. Sessão válida, conta habilitada e ausência de troca obrigatória são verificadas em cada operação. Uma reserva de jogo não substitui a sessão.

`GET /api/play/:id` fornece metadados do player e a URL privada da ROM. `GET /api/play/:id/rom` revalida o acesso, abre somente a chave gerada pelo servidor e confere tamanho/SHA-256 antes da resposta. Não há diretório público ou botão de download. Respostas privadas não devem ser armazenadas em cache; downloads simultâneos são limitados.

Para emular, os bytes da ROM precisam chegar ao navegador. Um usuário autorizado pode inspecioná-los; a aplicação **não promete DRM**. Bloquear a conta ou desativar um jogo impede novas consultas e sincronizações; não recolhe bytes já recebidos. O player pausa quando detecta perda de autorização.

## Save do cartucho e save state

O botão de salvar dentro do próprio jogo grava SRAM/EEPROM/Flash emulada. É esse conteúdo nativo que a aplicação sincroniza. Separadamente, **Saves** captura/restaura o estado completo da CPU/RAM com a memória nativa correspondente. Um jogo sem memória persistente pode usar state, mas não ganha save nativo. Use a função de salvar do jogo antes de sair e aguarde a confirmação do servidor.

O save remoto é restaurado antes do primeiro frame. A imagem inicial da memória não deve ser enviada como uma gravação nova: só mudanças observadas depois da inicialização são candidatas à sincronização. Save vazio é recusado. Falha de restauração interrompe a inicialização em vez de começar silenciosamente sem o progresso existente.

## Contrato de persistência

As rotas de execução/nativo abaixo usam JSON, cookie HttpOnly, origem exata, cabeçalho AJAX e CSRF. O proprietário vem da sessão; a administração separada está em [saves](saves.md).

| Método/rota | Entrada | Resposta |
| --- | --- | --- |
| `GET /api/play/:id/lease` | — | `reservation: null` ou `{ generation, expiresAt }`, somente da conta/jogo atual |
| `POST /api/play/:id/lease` | `{}` ou `{ expectedGeneration }` após confirmação explícita | Reserva exclusiva nova e save atual, com versão e bytes base64 ou `null` |
| `POST /api/play/:id/lease/renew` | `leaseId` | Nova expiração |
| `DELETE /api/play/:id/lease` | `leaseId` | 204; libera somente a própria reserva |
| `PUT /api/play/:id/save` | `leaseId`, `baseVersion`, `epoch` de reinício (nulo antes de reset), `dataBase64`, `sha256` opcional | Nova versão, checksum e data confirmados |

A reserva dura 120 segundos e deve ser renovada a cada 30 segundos. Duas abas ou dispositivos da mesma conta/jogo não podem escrever simultaneamente. A reserva pertence também à sessão; logout/revogação remove sua validade. Expiração/conflito retorna 409. A versão esperada precisa coincidir com a versão atual: nunca há escolha automática pela gravação mais recente enviada pelo cliente. Repetir exatamente a última gravação confirmada é idempotente, útil quando a resposta se perde.

Save nativo: 1 byte–1 MiB, base64 canônico e checksum conferido. Até uma alteração por segundo por save; repetição idempotente não é nova gravação. Quota local global de 1 GiB/10.000 saves. 429 indica frequência excedida, 507 quota, 401 sessão inválida, 403 troca obrigatória/CSRF/origem e 404 jogo inexistente/inativo. Respostas de erro não revelam progresso de outro usuário.

PostgreSQL armazena os bytes (`bytea`), tamanho, SHA-256 e versão na mesma linha/transação, com chave única usuário+jogo. Não há janela entre gravar um arquivo e confirmar seus metadados. A migração incremental cria essas tabelas sem alterar jogos, contas ou sessões preexistentes.

## Backup e recuperação

Nativos e states confirmados estão no PostgreSQL e entram no backup v4; pendências somente no navegador ficam fora. Formatos anteriores e recuperação em novos banco/volume estão em [operação](operacao.md#persistência-backup-e-restauração). Compatibilidade dos snapshots em [saves](saves.md).

## Limitações

Rede, fechamento abrupto, falta de espaço ou falha do navegador podem impedir a última gravação. Confirmação local e confirmação do servidor são estados distintos. O fechamento da aba não é o mecanismo principal de sincronização. Não se promete perda impossível nem compatibilidade com todo cartucho. Fontes/licenças e limites de compatibilidade estão em [fontes do motor](fontes-emulador.md); testes efetivamente executados estão em [validação](validacao.md). Aguarde a gravação interna do jogo terminar antes de pausar/sair: capturar a memória durante sua escrita não equivale a confirmação do jogo.

## Player e recuperação local

Mapeamento do servidor: `GB → mgba-gb-v1`, `GBA → mgba-gba-v1`; ambos usam a mesma compilação mGBA, com configuração explícita de plataforma e modelo DMG para GB. Versões, licença MPL-2.0, patch de restauração nativa e comandos estão em [fontes do motor](fontes-emulador.md). O catálogo não persiste nome de core.

Cada início cria uma instância WASM isolada, sem SDK com persistência automática. Restaura os bytes, confere leitura integral antes do primeiro frame e só então libera execução. Começa pausada/muda internamente; Iniciar libera vídeo e Ativar áudio solicita áudio por gesto. Canvas 160×144 no GB e 240×160 no GBA, controles de teclado/toque com L/R apenas GBA. Saída remove listeners/timers/RAF, descarrega core e fecha AudioContext. Avisos de áudio/tela cheia não bloqueiam pausa/retomada; erros de sessão/sincronização pausam o jogo.

O player compara o save a cada 2 s, guarda alterações primeiro no IndexedDB e envia uma gravação por vez, respeitando intervalo de 1,1 s entre confirmações. Pausa, ocultação da página e saída capturam novamente depois de eventual PUT pendente. Heartbeat começa ao adquirir a reserva, inclusive durante carga lenta, e uma nova renovação é exigida antes de executar ou retomar. Pedidos de save/reserva têm timeout de 12 s; ROM, 60 s. Timers do navegador podem atrasar em segundo plano; reserva expirada não é silenciosamente retomada.

IndexedDB `emulador-save-recovery-v1`, chave composta por UUID do usuário+jogo, contém somente progresso pendente. Não contém credenciais/cookie e não usa localStorage (reservado ao tema e às preferências locais de interface do player). A aplicação só consulta a chave da conta autenticada e jogo atual. O registro tem revisão local comparada atomicamente para uma aba antiga não apagar a cópia escrita por outra. Essa recuperação é independente dos slots remotos de states. Uma resposta ambígua mantém a gravação original e, se o core avançou, seu sucessor: primeiro confirma/reenvia a original idempotentemente, depois envia o sucessor com a versão confirmada.

Antes de apagar/promover recuperação, o cliente valida a integridade do snapshot remoto. Ao voltar, conteúdo remoto idêntico confirma a pendência; versão base coincidente permite reenvio. Versão remota divergente bloqueia o início e preserva ambos, sem merge automático. O usuário pode manter a pendência ou confirmar descarte da cópia local para usar o servidor. Dados de recuperação não são criptografados contra inspeção do perfil do navegador; outro usuário da aplicação não os recebe, mas compartilhar o perfil físico do navegador exige cuidado.

O estado “Salvo no servidor” confirma bytes de cartucho, não execução recente nem save state. No autosave comum, memória toda zerada/`FF` e memória inicial sem mudança não sobrescrevem o remoto. Carregamento explícito de state também sincroniza cartucho apagado, mediante confirmação. Falha de IndexedDB pausa sem fingir que houve confirmação local. Saída offline oferece manter cópia local somente após sua confirmação; logout fica indisponível no player até voltar à biblioteca. `beforeunload` só solicita confirmação ao navegador, sem prometer conclusão assíncrona.

A compilação inicia com 64 MiB e permite no máximo 512 MiB de memória WASM por instância; há cópias adicionais da ROM/save no JavaScript. Dispositivos com pouca memória podem não iniciar GBA. O fechamento libera a instância para coleta pelo navegador, sem garantir devolução imediata de memória pelo processo.


## Tamanho, controles e preferências locais — 30/09/2026

Player ampliado somente no frontend. A área disponível é medida com `ResizeObserver`; o canvas mantém dimensões nativas 160×144/240×160 e recebe dimensões visuais proporcionais. Compacto/Médio/Grande limitam ampliação a 2×/3×/5×; Ajustar, padrão, ocupa o máximo possível preservando a proporção. Todos reduzem para caber. `image-rendering: pixelated` evita suavização; escalas fracionárias permitem aproveitar telas pequenas. Tela cheia usa o mesmo cálculo para o contêiner com canvas e controles; a barra compacta mantém pausa e saída visíveis, com opções secundárias em Mais controles. Se a API de fullscreen faltar ou recusar o gesto, usa modo expandido na página, sem esconder a interface do navegador. Safe areas e viewport dinâmica orientam o layout, sem trava de orientação; tamanho/visibilidade persistidos não são redefinidos ao sair. Uso e retorno por botão/Escape/Voltar no [guia](guia-de-uso.md#maximizar-no-celular-ou-desktop).

Controles de toque sobrepostos às bordas da área, semitransparentes no verde do projeto e alvos de pelo menos 44×44 px. O D-pad tem forma contínua em cruz, centro neutro e quatro zonas de input independentes; admite direções simultâneas e direção+A/B. L/R aparecem somente no GBA. Cada ponteiro/tecla tem identidade própria: soltar uma entrada não desliga outra fonte que mantém a mesma ação. Pointer capture acompanha o toque até soltar/cancelar; perda de captura, foco, ocultação de botões, remapeamento, pausa e saída liberam entradas. Keyup funciona mesmo depois de mover o foco. Repetições de uma tecla liberada são ignoradas até nova pressão.

Configurações → Controles usa diálogo modal, sem painel adicional de dicas. Exibe todas as ações, inclusive L/R identificados como exclusivos GBA. Captura de uma tecla física, cancelamento, conflito com troca explícita dos vínculos completos e restauração de padrões. Teclas de navegação do navegador e combinações Ctrl/Alt/Meta não são consumidas. A entrada do jogo ignora campos editáveis, botões, links e diálogos. Abertura pausa e captura o progresso pelo fluxo existente; fechamento aguarda essa captura e renova a reserva antes de retomar, somente se o estado anterior/foco/visibilidade/erros permitirem. Não altera o contrato de saves nem o core.

`localStorage`, chave `emulador-player-v1:<UUID do usuário>`, armazena apenas versão, tamanho, visibilidade, vínculos, volume e velocidade. Validação exige versão 1, tamanho conhecido, booleano e todos os vínculos válidos/sem duplicatas; dados corrompidos ou inacessíveis retornam padrões. Escrita indisponível mantém a seleção em memória neste player. Não armazena credenciais, ROM ou save; não há backend/migração nova para preferências. Sem compartilhamento de preferências entre contas nem sincronização entre navegadores. O IndexedDB de recuperação permanece separado e intacto.

## Revisão de sincronização e volume — 30/09/2026

O manifesto `GET /api/play/:id` inclui `save: null | { version, updatedAt }`, consultado somente para o usuário autenticado e jogo autorizado, sem bytes/hash. É uma indicação para a entrada; a lease continua sendo a leitura autoritativa e atômica antes de iniciar. `Continuar jogo` significa restaurar cartucho e então usar Continue no jogo, não continuar o instante da tela.

A saída pausa e libera teclas, espera o envio anterior, captura novamente e exige ACK antes de mostrar a confirmação de saída. ACK exige SHA-256 igual, versão inteira positiva igual à base ou base+1 (idempotência) e data válida. ACK inválido mantém IndexedDB e permite retry. Nenhum save confirmado permite saída consciente, sem alegar gravação. A confirmação exibe a data do servidor e não certifica validade semântica da partida. Fechar a aba não avisa se os bytes atuais coincidem integralmente com a confirmação e não há pendência; nos demais casos a proteção de saída permanece.

O adaptador mantém um único GainNode por instância, com ganho linear limitado a 0–1 (padrão 0,7), zero durante mute/pausa e desconexão/fechamento no destroy. Volume 0 não muda o estado de mute. A preferência `volume` inteira 0–100 é adicional ao formato v1 por usuário; ausente/inválida recebe 70 sem apagar demais preferências válidas. Não muda o core, saves ou schema do banco.

## Recuperação da reserva após refresh — 30/09/2026

Ctrl+R encerra a instância WASM, mas não garante execução/entrega do cleanup assíncrono. A linha de reserva no PostgreSQL não é um emulador executando: permanece válida até 120 s após a última renovação (heartbeat de 30 s); a linha expirada pode permanecer no banco até ser substituída, mas já não autoriza escrita. Cookie/login compartilhado não identifica uma aba; não há retomada automática por cookie, sessionStorage ou identificação copiável na duplicação de aba.

Após conflito, a interface consulta a reserva própria e oferece **Tentar novamente** (aquisição normal, sem tomar controle) ou **Encerrar sessão anterior e jogar aqui**, com confirmação sobre perda de controle da outra aba e possível indisponibilidade do progresso não sincronizado. A troca não exige aguardar expiração. A expiração exibida é uma observação: uma aba ativa pode renová-la. Uma falha de rede, inclusive resposta perdida da transferência, permite consultar novamente e confirmar a geração atual.

`generation` é SHA-256 do hash do token da reserva, não o token que autoriza escrita. `expectedGeneration` é comparada à linha atual sob as mesmas travas transacionais de ator/catálogo/jogo/reserva usadas por save/renew. Troca cria UUID aleatório novo, grava seu hash e vincula à sessão autenticada. Duas transferências da mesma geração têm somente um vencedor; a perdedora recebe 409 e precisa conferir/confirmar novamente. Geração de outro usuário/jogo não autoriza transferência. CSRF, limites gerais, conta habilitada, senha definitiva e jogo ativo continuam obrigatórios. Não há migração ou liberação global de reservas expiradas: a aquisição substitui somente a linha do próprio usuário/jogo.

Save/renew antigos, inclusive requisições iniciadas antes da troca mas processadas depois, recebem 409. DELETE antigo é inofensivo, condicionado ao token/sessão antigos. Se um save antigo terminar **antes** da troca adquirir as travas, seus bytes integram o snapshot devolvido à nova reserva; depois da troca, ele não pode escrever. O novo player valida checksum, recupera pendência compatível e restaura antes do primeiro frame, mantendo o caminho existente de conflito de versão.

No IndexedDB existente, uma marca `owner:usuário:jogo` contém somente digest, sem credencial. A aquisição compara atomicamente a marca observada antes da chamada: resposta atrasada não pode assumir armazenamento já reivindicado por outra instância. Gravar/apagar/promover pendências compara dono e revisão na mesma transação. Ao detectar perda, a instância pausa e impede reenvio; um snapshot não confirmado é preservado em chave `isolated:usuário:jogo:digest`, sem substituir a pendência atual. Essas cópias são recuperação de conflito, não slots selecionáveis. Ao reabrir com cópias isoladas, não há merge/envio automático: mantenha-as e volte, ou feche a aba antiga e confirme explicitamente o descarte apresentado para usar o servidor. Descarte compara as revisões vistas e não remove uma revisão nova concorrente. Storage indisponível continua falhando sem alegar persistência local.

A revogação no backend é imediata; uma aba já carregada detecta a perda na próxima operação/heartbeat (normalmente até 30 s, sujeito a suspensão do navegador). Sem conectividade, não se promete parar remotamente a CPU: ela não consegue escrever no servidor. `pagehide` pausa e tenta capturar localmente, sem depender de entrega final; `pageshow.persisted` mantém pausado e revalida a reserva antes de uma retomada explícita. Voltar de bfcache ou de queda de rede nunca concede automaticamente nova reserva. Abas carregadas antes desta atualização precisam recarregar para receber a nova UI; tokens antigos já são recusados pelo backend depois da troca.

## Velocidade de emulação — 30/09/2026

Adaptador TypeScript aceita 1/2/3/5/10×; 1× é padrão e fallback. O multiplicador aplica-se ao tempo emulado acumulado entre timestamps de `requestAnimationFrame`, mantendo a frequência nativa indicada pelo core em monitores 60/120/144 Hz. O adaptador chama a ABI existente `_mgbawasm_run_frame` mais vezes e desenha somente o último frame do lote. Não altera/recompila core, ROM, CPU nativa, reserva ou estado do cartucho.

Há uma única cadeia RAF por instância. Cada callback executa no máximo 12 frames, interrompendo o lote após atingir 8 ms de trabalho medido (um frame individual não pode ser preemptado). O saldo de frames inteiros não executados é descartado, conservando apenas a fração. Intervalos negativos ou acima de 100 ms descartam dívida; pausa/retomada/troca de velocidade reinicializam o relógio. A primeira chamada após reinicialização apenas estabelece a referência. `document.hidden` também impede execução no adaptador, além da pausa/revalidação já existentes no player. Nenhum loop/timer adicional é criado ao trocar velocidade. Velocidades são alvos limitados pelo aparelho, não benchmarks garantidos.

Acima de 1×, ganho fica zero e AudioContext é suspenso. PCM nativo continua sendo drenado e descartado por frame, com até quatro leituras de 4.096 amostras estéreo por frame; não é enviado ao worklet. Trocas limpam a fila limitada existente; retornar a 1× restaura ganho somente se não estiver pausado/mudo e tenta ativar áudio conforme política de gesto do navegador. Mute e volume escolhidos não são alterados pela aceleração. Não há time-stretch, ganho acima de 1, nós adicionais ou fila para reprodução futura.

Preferência opcional `speed` no formato local v1 por usuário aceita apenas números 1/2/3/5/10. Campo ausente/inválido recebe 1 sem apagar demais campos válidos; storage indisponível mantém escolha em memória. Não há backend ou migração. Heartbeat de 30 s, captura periódica de 2 s, intervalo mínimo de envio de 1,1 s, TTL e timeouts HTTP permanecem em tempo real. Pausa/saída continuam capturando o cartucho mais recente pelo fluxo confirmado existente; restauração permanece anterior ao primeiro frame.

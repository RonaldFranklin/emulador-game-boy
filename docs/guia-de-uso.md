# Guia de uso

Para instalar e criar o primeiro master, veja o [README](../README.md). Use a mesma conta para acessar seu progresso. Nenhum jogo acompanha o projeto.

## Qual tipo de save usar?

| Tipo | O que guarda | Como retomar |
| --- | --- | --- |
| Save nativo — um por usuário/jogo | Memória do cartucho gravada pela opção SAVE do jogo | Abra o jogo e escolha Continue/Continuar no menu dele |
| Save state — Save rápido + Slot 1, 2 e 3 por usuário/jogo | Instante da emulação, incluindo CPU/RAM e cartucho daquele ponto | No player, abra Saves e carregue o slot |

States complementam o save nativo; dependem da ROM e da compilação exata do core. **Carregar um estado antigo também volta o cartucho àquele ponto**, podendo substituir o nativo atual. Salve o instante atual em outro slot antes se quiser mantê-lo. Não há importação/exportação nem histórico recuperável de versões substituídas do mesmo slot.

## Salvar dentro do jogo e continuar depois

1. Na biblioteca, escolha **Jogar → Iniciar jogo** ou **Continuar jogo**.
2. Use a opção de salvar **dentro do próprio jogo**. No Pokémon FireRed: **Start → SAVE**, confirme e aguarde a gravação terminar.
3. Clique em **Salvar e voltar**. O player pausa e sincroniza a memória do cartucho; ele não pressiona SAVE por você.
4. Aguarde a confirmação com data/hora e escolha **Voltar à biblioteca**. Se houver erro, permaneça na sessão e siga [pendência ou erro](#pendência-ou-erro-de-gravação).
5. Ao reabrir, **Continuar jogo** restaura automaticamente o cartucho antes da execução. Escolha **CONTINUE/Continuar no menu do jogo**; esse fluxo não volta ao instante exato da tela.

“Continuar jogo” indica memória no servidor, não prova de que o jogo reconhece uma partida válida. Se não houver gravação confirmada, escolha **Permanecer no jogo** e retome para salvar, ou **Sair sem save confirmado** conscientemente. Jogos sem memória persistente podem usar states, mas não têm save nativo.

## Criar, substituir e carregar um estado

1. Com o jogo aberto, clique em **Saves**, no topo do player. O jogo pausa e sincroniza o cartucho atual.
2. Escolha **Save rápido** ou um dos três slots manuais. Informe um rótulo opcional e clique em **Salvar rápido** ou **Salvar estado**.
3. Se o slot estiver ocupado, confirme a substituição ou cancele. Aguarde **Estado confirmado no servidor** antes de sair.
4. Para carregar, clique em **Carregar rápido** ou **Carregar estado** no slot ocupado. Leia e confirme o aviso sobre substituir o instante e o cartucho atuais; **Cancelar** preserva a execução atual.
5. Aguarde a restauração, clique em **Fechar Saves** e depois **Retomar**. A imagem reaparece no próximo frame. Preferências de áudio, velocidade, tamanho e teclas não vêm do snapshot.

Os controles funcionam por teclado/toque e em tela cheia. Um slot pode aparecer vazio, ocupado ou incompatível; incompatível não pode ser carregado, mas pode ser substituído ou excluído mediante confirmação.

Limites: 32 MiB de estados por usuário e 256 MiB no total do servidor. Um state capturado antes de o GBA identificar memória de cartucho pode ser recusado se já existir nativo confirmado; nesse caso, o jogo atual é preservado. Detalhes de tamanho, compatibilidade e falhas estão no [contrato de saves](saves.md).

## Excluir e administrar Meus saves

1. Volte à biblioteca e abra **Meus saves**. Filtre por jogo, se necessário; a lista mostra somente seus dados, com tipo, rótulo e data.
2. Escolha **Excluir Save nativo**, **Excluir Save rápido** ou **Excluir Slot N**.
3. Confira dono, jogo e tipo, digite **EXCLUIR** e confirme. **Cancelar** não altera o progresso. Dentro de **Saves** no player também existe **Excluir slot**, com confirmação.

Excluir um slot não apaga nativo, outros slots, ROM, jogo ou conta. Excluir nativo reinicia o progresso no próximo início e **é recusado enquanto houver reserva ativa**. Encerre o jogo normalmente; se a reserva ficou após fechar/recarregar, use a recuperação abaixo e depois **Salvar e voltar**, ou aguarde a expiração. Pendências anteriores ao reset não são reenviadas silenciosamente. States existentes permanecem e só restauram o cartucho antigo se você os carregar conscientemente.

MASTER tem **Meus saves** para seus próprios jogos e **Administração de saves** separada, com filtros por usuário/jogo e exclusão identificando o dono. A permissão administrativa **não permite carregar estados de outra conta para jogar**. Se o dado mudar durante a confirmação, atualize a lista e confira novamente.

## Pendência ou erro de gravação

| Mensagem/situação | O que fazer |
| --- | --- |
| Sincronizando / Salvando no servidor | Aguarde; ainda não é confirmação |
| Salvo no servidor | Cartucho confirmado, com data/hora quando disponível; não é confirmação de um state |
| Estado confirmado no servidor | O slot escolhido foi persistido |
| Pendente / envio não confirmado | Mantenha a sessão, reconecte e use **Tentar sincronizar**; depois **Retomar** |
| Voltar mantendo cópia local | Só use se precisar sair e a opção estiver disponível; a cópia local ainda não está no backup do servidor |
| Conflito de versões, pendência isolada ou nativo excluído/reiniciado | Não descarte se ainda precisa dessa cópia. Mantenha-a, feche a aba antiga e só confirme descarte se aceitar usar o progresso do servidor |

Não limpe os dados do navegador, não troque de perfil/origem e não sobrescreva slots para tentar resolver uma pendência. A recuperação local é da memória nativa, separada por usuário/jogo; não guarda automaticamente a CPU/RAM de um novo state. Se um upload de state falhar, confira data/rótulo do slot após atualizar a lista antes de tentar substituir novamente: a resposta pode ter se perdido após a gravação.

Após erro ao carregar state, mantenha o player pausado e siga a mensagem. Conteúdo inválido é recusado preservando a instância anterior. Se o estado foi carregado, mas a sincronização do cartucho falhou, a instância restaurada permanece pausada e permite tentar sincronizar; não há confirmação falsa de sucesso.

Fechar/recarregar a aba, falta de energia ou falha de storage podem perder a última alteração. Prefira SAVE no jogo e confirmação antes de sair. Uma pendência local não acompanha a conta para outro navegador. Em aparelho compartilhado, o dono do perfil do navegador pode inspecionar seus dados locais.

## Depois de Ctrl+R ou aviso de outra aba

Uma reserva temporária pode sobreviver à aba recarregada. Isso não significa que o save sumiu nem que o emulador continua executando no servidor.

1. Abra **Jogar** e tente **Iniciar jogo/Continuar jogo**.
2. Se houver reserva ativa, escolha **Encerrar sessão anterior e jogar aqui**. A outra aba perderá o direito de gravar; progresso ainda não sincronizado nela pode não estar disponível aqui.
3. Confirme **Confirmar e jogar aqui**. O nativo confirmado será restaurado antes da execução; escolha Continue no jogo ou carregue um state próprio em **Saves**.

Se não quiser interromper outra aba, aguarde e use **Tentar novamente**, sem recarregar. A reserva vence até 120 segundos após a última renovação; uma aba ativa pode continuar renovando. Se outra transferência vencer a corrida, confira a nova situação antes de confirmar.

A aba que perder a reserva pausa quando detectar a perda e preserva pendências locais, sem sobrescrever a nova sessão. Se aparecer conflito de recuperação, siga [pendência ou erro](#pendência-ou-erro-de-gravação); não há fusão automática nem promessa de recuperar mudanças que nunca foram sincronizadas.

## Controles, tela, áudio e velocidade

| Controle | Uso/padrão |
| --- | --- |
| Teclado | Setas; A/B: X/Z; Start/Select: Enter/Shift; L/R do GBA: Q/W |
| Mostrar botões | Exibe/oculta controles de toque sobrepostos; direção e ação podem ser usadas juntas. L/R somente no GBA |
| Configurações → Controles | Selecione a ação e pressione uma tecla. Conflito exige **Trocar vínculos** ou **Cancelar captura**; Escape cancela. **Restaurar padrão** redefine só o teclado |
| Tamanho | **Ajustar ao espaço disponível** é o padrão; Compacto, Médio e Grande também respeitam espaço e proporção GB/GBA, sem suavizar pixels |
| Tela cheia | Maximiza jogo e controles de toque; **Mais controles** abre Saves, configurações, tamanho, áudio e saída para a biblioteca. **Sair da tela cheia** restaura o layout |
| Volume | Slider 0–100%, padrão 70%. Em 0%, continua sem som até aumentar |
| Silenciar / Ativar áudio | Silenciar preserva o volume escolhido. O player inicia silenciado; ativação depende de clique/toque |
| Velocidade | 1× padrão; 2×, 3×, 5× e 10× como alvos limitados pelo aparelho, sem reiniciar o jogo |

### Maximizar no celular ou desktop

1. Com o jogo iniciado, toque em **Tela cheia**. Gire o celular se desejar; não há trava de orientação. Use **Ajustar ao espaço disponível** para aproveitar a área sem distorcer GB/GBA.
2. **Pausar/Retomar** e **Sair da tela cheia** permanecem visíveis. Abra **Mais controles** para consultar a sincronização e acessar Saves, configurações, tamanho, velocidade, volume, Mostrar botões e Salvar e voltar. Em telas baixas, role esse painel; **Menos controles** o recolhe.
3. **Sair da tela cheia** restaura o layout, preservando tamanho e visibilidade dos botões. Escape também sai quando disponível. Sair da maximização não encerra o jogo nem substitui **Salvar e voltar**.

Se fullscreen não for suportado ou for recusado, o player avisa e usa **modo expandido dentro da página**: a interface do navegador permanece. Nesse modo, Voltar também desfaz a expansão. O acesso continua restrito ao ambiente local configurado; maximizar não disponibiliza o site na rede.

O D-pad clássico é uma cruz visual única com quatro zonas independentes: o círculo central é neutro. É possível combinar direções e usar direção junto com A/B por multitoque. Os demais botões mantêm suas funções; L/R aparecem somente no GBA.

### Áudio e preferências

**Acima de 1× o áudio fica temporariamente silenciado.** Voltar a 1× respeita mute/volume e o gesto exigido pelo navegador, sem reproduzir fila antiga. Acelerar não aumenta a frequência de requisições ou de sincronização de saves. Pausa, configuração e aba oculta interrompem o avanço; não há compensação do tempo parado.

Remapear usa a posição física das teclas. Ctrl/Alt/Meta, Tab e teclas de função ficam reservados ao navegador. Configurar pausa o jogo; ao fechar, só retoma automaticamente se ele estava executando e ainda há foco e reserva válida. Perder foco, ocultar controles ou cancelar um toque libera entradas; solte e pressione de novo teclas que estavam seguradas.

Tamanho, botões, teclas, volume e velocidade persistem **por usuário neste navegador/origem**, separados dos saves e sem credenciais. Outro navegador usa os padrões. Dados inválidos/storage indisponível usam fallback; alterações de outra aba aparecem ao reabrir o player. Mute não é uma preferência persistida: cada início começa silenciado.

O tema **Escuro** fica no login/cabeçalho. Sem escolha manual, segue o sistema; a escolha fica neste navegador/origem, compartilhada entre abas e contas. Storage indisponível mantém a escolha só durante a navegação.

## Contas, catálogo e funções do master

MASTER cria jogadores em **Administração**, entrega senha temporária por canal privado, bloqueia/desbloqueia e redefine senhas. Jogador precisa trocar a senha temporária antes de jogar. Bloqueio/reset revogam sessões; trocar a própria senha encerra todas as sessões e **Sair** encerra a atual. Não há exclusão de contas, promoção de jogador nem recuperação pública da senha esquecida do master.

Em **Catálogo**, MASTER cadastra nome, ROM `.gb`/`.gba` descompactada, capa PNG/JPEG opcional e disponibilidade. Pode editar nome/capa/disponibilidade; ROM, console e UUID são imutáveis. Não há exclusão definitiva: desative para retirar o jogo dos disponíveis. Jogador vê ativos; MASTER pode consultar todos, mas **também só joga ativos**. Limites de upload e critérios completos ficam em [catálogo](catalogo.md).

Após três falhas de login do mesmo IP em duas horas, novos logins desse IP são bloqueados por duas horas desde a terceira falha. Aguarde o prazo mostrado; recarregar/reiniciar não limpa o bloqueio. Sessões existentes continuam funcionando. NAT pode compartilhar o IP; veja [autenticação](autenticacao.md#limitação-de-tentativas).

GB dual-mode roda como Game Boy original; GBC exclusivo e outros consoles ficam fora. Os bytes da ROM chegam ao navegador autorizado, sem promessa de DRM. O motor e suas fontes/licenças são servidos localmente: [fontes do motor](fontes-emulador.md).

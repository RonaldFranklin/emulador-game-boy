# Saves nativos, estados e administração

Ampliação expressamente autorizada em 30/09/2026, substituindo a restrição anterior a save states, slots e administração. Nenhum nativo existente é convertido em state. Resultados executados em [validação](validacao.md).

## Uso e propriedade

Há um nativo e quatro slots por usuário/UUID de jogo: **Save rápido** (0) e **Slot 1–3**. Estados complementam o SAVE do jogo; dependem da ROM e do core e não são universalmente melhores. Não há importação/exportação. Rótulo opcional até 80 caracteres, data/hora e indicação vazio/ocupado/incompatível.

Passos de criar/carregar/substituir/excluir e administração ficam no [guia de uso](guia-de-uso.md). O player só carrega dados próprios; a autorização MASTER para listar/excluir dados alheios é separada. Substituir/carregar/excluir exige confirmação, e conflito de revisão não pode ser tratado como sucesso.

Nativo só pode ser excluído sem reserva ativa. Encerre normalmente o jogo; uma reserva órfã pode ser recuperada pelo takeover já existente e depois liberada, ou expirar. A confirmação compara versão e marcador de reinício. A exclusão deixa um novo marcador persistente; pendências antigas não recriam o progresso. Ao reabrir com pendência anterior, a UI preserva a cópia e exige descarte explícito para iniciar do zero. Estados existentes continuam disponíveis e podem restaurar o cartucho antigo mediante confirmação.

## Formato, limites e compatibilidade

ABI `_mgbawasm_state_size/save/load` existente; nenhuma alteração/recompilação do core foi necessária. Identidade exata: `wasm:6d9f5c0b7819bd16267a8c8ad1737ef58ad539065c52ad6ae3fabf574f0b5fa8` (SHA-256 do WASM). O adaptador verifica o binário servido antes de iniciar. Formato da aplicação 1 inclui dois blobs independentes: state bruto e cartucho correspondente.

Medidas com ROMs próprias/core real: GB 71.680 bytes + SRAM 8.192; GBA 397.312 + SRAM 32.768; GBA Flash128 397.312 + Flash 131.072. O serviço exige tamanho de state exato por console, teto absoluto 512 KiB, cartucho até 1 MiB; JSON até 2.100.000 bytes, sem compressão/inflate. Limites lógicos de payload somado: **32 MiB por usuário / 256 MiB global**, dentro de transação; HTTP 507 ao exceder. Dois uploads de estado simultâneos no processo e prazo de leitura de 30 s; guardas de autenticação, CSRF/origem e limites HTTP precedem o parser grande. Não há autosave de state por frame.

Metadados associam dono, UUID do jogo, console, hash imutável da ROM, identidade exata do core, formato, revisão e SHA-256 de ambos os blobs. Valores SQL são parametrizados. Incompatibilidade bloqueia carregar, mas permite substituir/excluir conscientemente. Atualizações futuras do core exigem nova identidade, validação e política explícita de compatibilidade; nunca rotular state antigo como compatível por inferência. Fontes/licenças continuam [auto-hospedadas e fixadas](fontes-emulador.md).

## Transações e carregamento

Migração aditiva `006-save-states.sql`: states `bytea` com restrições de tamanho/hash, quatro slots únicos e tombstones que preservam a revisão após excluir; marcadores de reset em `save_resets`. Não altera bytes nativos ou catálogo preexistentes. Escritas/leitura de state revalidam jogo ativo, sessão e token da reserva atual sob as mesmas travas das gravações nativas/takeover. Metadados/dados/versionamento são atômicos; troca de dono invalida requisições antigas. Retry de upload idêntico na revisão seguinte é idempotente. A lista administrativa nunca contém blobs.

Rotas autenticadas:

- `GET /api/play/:id/states`: metadados dos slots próprios e identidade ROM/core.
- `PUT /api/play/:id/states/:slot`: leaseId, versão esperada, rótulo e metadados/blobs/checksums.
- `POST /api/play/:id/states/:slot/load`: leaseId e versão esperada; retorna apenas state próprio compatível.
- `GET /api/saves`: lista própria paginada (100); `admin=true` exige MASTER, filtros user/game parametrizados e offset validado.
- `DELETE /api/saves/:owner/:id/:kind`: kind native ou 0–3; versão, confirmação EXCLUIR e epoch atual para nativo. Outro dono exige MASTER. Nativo com reserva ativa retorna 409. Uma operação concorrente do dono pode produzir 409 temporário na exclusão administrativa; a trava do dono é tentada antes da trava global, sem esperar por uma dependência circular.

Antes de carregar, player pausa/libera teclas, aguarda PUTs anteriores, sincroniza cartucho atual e revalida reserva. Um core candidato separado restaura o cartucho antes de carregar CPU/RAM, confere tamanho/checksum e compara memória nativa integral. Core que recusa conteúdo não danifica a instância anterior. Após validação, substitui a instância pausada e sincroniza o cartucho restaurado usando a revisão nativa atual; autosave antigo não pode ser promovido depois. Falha/ACK perdido mantém a instância restaurada pausada e a pendência nativa recuperável no IndexedDB, com retry idempotente. Só a confirmação permite retomar normalmente. Áudio antigo é descartado ao fechar a instância; a nova respeita gesto/mute/volume/velocidade.

Limite explícito: um state capturado antes de o GBA identificar qualquer memória de cartucho pode conter cartucho vazio. Se depois já houver nativo no servidor, esse ponto é recusado para não misturar CPU antiga com cartucho mais novo; capture outro estado após o jogo inicializar sua memória. Não se converte SRAM em estado fictício. Queda abrupta antes de confirmar upload pode perder o novo state. Se a resposta se perder após commit, a substituição pode já ter ocorrido; confira a revisão/data antes de repetir. O snapshot de CPU não é salvo automaticamente no IndexedDB. ROMs com RTC/periféricos e aparelhos físicos exigem testes próprios; não há promessa de compatibilidade universal.

## Backup

Backup v4 inclui dados/metadados de states, tombstones de slots e marcadores de reset no dump transacional, além de nativos e arquivos privados. Manifesto registra checksums/tamanhos/compatibilidade dos ocupados e marcadores de reset. A mesma trava global protege o snapshot contra escritas concorrentes. Restauração confere payloads no PostgreSQL isolado. v1/v2/v3 continuam aceitos; nenhum state é inventado ao restaurar formato anterior. O backup de dados não inclui automaticamente o binário do core. Preserve também sua compilação/fontes fixadas para compatibilidade futura. Procedimentos em [operação](operacao.md#persistência-backup-e-restauração).

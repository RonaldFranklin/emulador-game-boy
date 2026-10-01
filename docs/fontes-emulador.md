# Motor de emulação: fontes, compilação e limites

O navegador usa mGBA compilado para WebAssembly, com um adaptador próprio para GB e GBA. GB é iniciado explicitamente no modelo **DMG**, inclusive para cartuchos compatíveis com os dois modelos. Nenhuma BIOS externa, ROM comercial ou save de usuário acompanha o código.

## Versões fixadas

| Componente | Referência exata |
| --- | --- |
| [mGBA](https://github.com/mgba-emu/mgba/tree/c034660f007c543233f1cadeb0ca13c71afd8f41) | Commit `c034660f007c543233f1cadeb0ca13c71afd8f41` |
| [Adaptador C original mGBA-wasm](https://github.com/wasm-gaming/mGBA-wasm/tree/6b19a50a1aa45055970b46999d5cde2451f1f5d0) | Versão `0.1.1`, commit `6b19a50a1aa45055970b46999d5cde2451f1f5d0` |
| [Emscripten SDK](https://github.com/emscripten-core/emsdk/tree/main/docker) | `emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65` |

O commit do núcleo é uma revisão de desenvolvimento, **não** uma versão estável anunciada pelo mGBA. Ele foi mantido fixo para compatibilidade com a interface C do adaptador e validado com programas próprios. Atualizar núcleo, adaptador ou compilador exige repetir os testes de execução e restauração antes do primeiro quadro.

Os arquivos-fonte baixados do GitHub são conferidos por SHA-256 antes da extração:

| Arquivo | SHA-256 |
| --- | --- |
| `core-source.tar.gz` | `0d7c9b0dddeed8d94dad99eb59823edc393081ffccff27117a37532209f8160a` |
| `wrapper-source.tar.gz` | `7878e0a43ad406fadfd916ebb6cc63d3feaa6dfd8babe0ac36a56af7a44381ee` |

URLs completas e verificações estão em [vendor-emulator.mjs](../scripts/vendor-emulator.mjs). O build aborta se o conteúdo divergir. O estágio de compilação usa `RUN --network=none`; o navegador recebe todos os arquivos da própria aplicação, sem fallback para CDN.

## Adaptação para saves nativos

O SDK JavaScript original não é carregado. Assim, suas rotinas de OPFS, preferências, menus e save states não participam da aplicação. O adaptador local controla quadros, vídeo, áudio e entradas; a persistência pertence ao fluxo autenticado da aplicação.

O ensaio inicial encontrou uma falha concreta no adaptador C original: `savedataRestore(..., true)` podia retornar sucesso no GBA sem copiar os bytes quando o tipo de memória do cartucho ainda não havia sido detectado. Uma ROM própria demonstrou que o save exportado voltava a zero no próximo boot.

A alteração em [vendor-emulator-shim.c](../scripts/vendor-emulator-shim.c) usa `mCore.loadSave` com um `VFileMemChunk` antes do primeiro quadro. Cartuchos novos também recebem um arquivo virtual em memória. Não há montagem de filesystem persistente do navegador. O adaptador TypeScript compara integralmente os bytes restaurados e exige contador de quadros igual a zero antes de liberar a instância, inicialmente pausada e muda. A exportação usa `savedataClone`, copiando os bytes da memória WASM; ela não produz um save state.

O áudio usa um AudioWorklet local para converter o PCM do núcleo à frequência do navegador. Ativação depende de gesto do usuário. Pausar libera entradas e interrompe áudio/quadros; encerrar descarrega o cartucho, fecha o AudioContext e elimina referências da instância.

## Compilar e conferir localmente

Com os pré-requisitos e dependências do [README](../README.md) instalados, a partir da raiz:

```bash
npm run prepare:emulator
npm run typecheck --workspace frontend
npm run build --workspace frontend
```

Esses comandos foram executados nesta entrega. `prepare:emulator` compila o target Docker `emulator-build` e copia os resultados para `frontend/public/emulator/`, diretório gerado e ignorado pelo Git. O container temporário usado para a cópia é removido; nenhum volume de catálogo ou banco é acessado. Os targets Docker `frontend` e `browser` já fazem essa preparação e copiam os mesmos resultados durante seu build.

O Docker precisa acessar as imagens e fontes públicas durante a preparação. Depois disso, o estágio de compilação e a execução do motor não dependem de acesso externo. `SHA256SUMS`, dentro do diretório gerado, registra os hashes do JavaScript e WASM produzidos.

## Licenças e fontes correspondentes

mGBA e o adaptador original são distribuídos sob **MPL-2.0**. O arquivo C modificado e o script de compilação preservam identificação e atribuição. O build inclui o texto da licença, os arquivos-fonte completos fixados, as modificações locais e os comandos de compilação junto aos arquivos distribuídos.

Na aplicação, `/emulator/NOTICE.html` apresenta esses arquivos e links; `/emulator/source-manifest.json` registra origens e versões. As fontes completas também preservam os avisos de componentes de terceiros. Essa distribuição contém exclusivamente código do motor, sem cartuchos, credenciais ou progresso pessoal.

## Evidência e limites

O spike real em Chromium/Docker sem rede externa executou ROMs próprias geradas por [play-roms.mjs](../tests/helpers/play-roms.mjs): GB com SRAM de 8 KiB, GBA com SRAM de 32 KiB e GBA com Flash de 128 KiB. Nos três casos, o botão A alterou imagem/memória; uma nova instância restaurou os mesmos bytes antes da execução e exibiu a imagem correspondente. O caso Flash preservou também sentinelas no segundo banco de 64 KiB.

Foram exercitados pausa, entrada ignorada enquanto pausado, ativação/mudo do áudio, descarte repetido e nova instância. As evidências locais estão em `.local/spike/adapter-evidence.json`; não houve requisições externas nem erros de página. As fixtures são silenciosas: esse ensaio, isoladamente, não comprova qualidade sonora. A suíte versionada de integração do player está em [player.spec.mjs](../tests/browser/player.spec.mjs), e os resultados consolidados ficam em [validação](validacao.md).

Um smoke-test adicional, autorizado e somente para leitura, iniciou um cartucho GBA já existente no catálogo. O volume foi montado como somente leitura em container sem rede, sem chamadas à API, entradas de jogo, exportação ou gravação de progresso. Durante 14 segundos foram observadas 13 imagens diferentes em 240×160, animação de abertura e sinal PCM não nulo após gesto de ativação do áudio; nenhum erro de página. O descarte fechou o AudioContext. A evidência local `.local/spike/existing-cartridge-evidence.json` não contém bytes, nome de arquivo nem hash do cartucho. Esse teste confirma a abertura observada, não uma partida completa nem a qualidade auditiva em aparelhos reais.

Não há promessa de compatibilidade com todo o catálogo. BIOS externa, acessórios, cabo link, multiplayer, sensores e GBC exclusivo não são funcionalidades desta entrega. Save states agora usam diretamente a ABI já presente neste mesmo binário, conforme [contrato](saves.md). Saves acima do limite definido pela aplicação são recusados, sem truncamento. Comportamentos específicos de RTC e acessórios ainda precisam de testes dedicados.

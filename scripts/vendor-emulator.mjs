import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile, copyFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sources = [
  {
    name: 'core',
    commit: 'c034660f007c543233f1cadeb0ca13c71afd8f41',
    url: 'https://codeload.github.com/mgba-emu/mgba/tar.gz/c034660f007c543233f1cadeb0ca13c71afd8f41',
    sha256: '0d7c9b0dddeed8d94dad99eb59823edc393081ffccff27117a37532209f8160a',
  },
  {
    name: 'wrapper',
    version: '0.1.1',
    commit: '6b19a50a1aa45055970b46999d5cde2451f1f5d0',
    url: 'https://codeload.github.com/wasm-gaming/mGBA-wasm/tar.gz/6b19a50a1aa45055970b46999d5cde2451f1f5d0',
    sha256: '7878e0a43ad406fadfd916ebb6cc63d3feaa6dfd8babe0ac36a56af7a44381ee',
  },
];

function run(command, args, cwd = project) {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`${command} falhou (${result.status ?? result.signal}).`);
}

async function prepare(destination) {
  await mkdir(destination, { recursive: true });
  for (const source of sources) {
    const archive = resolve(destination, `${source.name}-source.tar.gz`);
    let bytes;
    try { bytes = await readFile(archive); } catch {}
    if (!bytes || createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
      console.log(`Obtendo fonte fixa ${source.name}: ${source.commit}`);
      const response = await fetch(source.url, { signal: AbortSignal.timeout(120_000) });
      if (!response.ok) throw new Error(`Falha HTTP ${response.status} em ${source.url}.`);
      bytes = Buffer.from(await response.arrayBuffer());
      if (createHash('sha256').update(bytes).digest('hex') !== source.sha256) {
        throw new Error(`SHA-256 divergente para ${source.name}; compilação cancelada.`);
      }
      await writeFile(archive, bytes);
    }
    await mkdir(resolve(destination, source.name), { recursive: true });
    run('tar', ['-xzf', archive, '--strip-components=1', '-C', resolve(destination, source.name)]);
  }
  for (const name of ['vendor-emulator-shim.c', 'vendor-emulator-build.sh', 'vendor-emulator.mjs']) {
    await copyFile(resolve(project, 'scripts', name), resolve(destination, name));
  }
  await writeFile(resolve(destination, 'source-manifest.json'), JSON.stringify({
    adapter: 'emulador-mgba-v1',
    compiler: 'emscripten/emsdk:6.0.10@sha256:e077d54e2b8970575ebc4f185ac1de0b95c05f2b266134d4ba27449af7aebf65',
    sources,
  }, null, 2) + '\n');
  await writeFile(resolve(destination, 'NOTICE.html'), `<!doctype html>
<html lang="pt-BR"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Emulador — motor e licenças</title><body>
<h1>Motor de emulação e licenças</h1>
<p>mGBA, copyright Jeffrey Pfau e colaboradores, sob <a href="LICENSE-MPL-2.0.txt">Mozilla Public License 2.0</a>.
Adaptador C derivado de wasm-gaming/mGBA-wasm 0.1.1, também MPL-2.0.
As fontes completas incluem os avisos e licenças de componentes de terceiros.</p>
<p>O motor utiliza o commit fixo de desenvolvimento c034660f007c543233f1cadeb0ca13c71afd8f41.
A adaptação local carrega a memória nativa do cartucho antes do primeiro quadro e mantém um arquivo virtual em memória.
Nenhuma ROM comercial ou BIOS externa está incluída.</p>
<ul>
<li><a href="source/core-source.tar.gz">Fontes completas do mGBA</a></li>
<li><a href="source/wrapper-source.tar.gz">Fontes originais do adaptador</a></li>
<li><a href="source/vendor-emulator-shim.c">Adaptador C com as alterações locais</a></li>
<li><a href="source/vendor-emulator-build.sh">Comandos de compilação</a></li>
<li><a href="source/vendor-emulator.mjs">Obtenção e verificação das fontes</a></li>
<li><a href="source-manifest.json">Versões, origens e hashes das fontes</a></li>
<li><a href="SHA256SUMS">Hashes dos arquivos compilados</a></li>
</ul><p>Todos estes arquivos são servidos localmente pela própria aplicação.</p>
</body></html>\n`);
}

async function installLocal() {
  const image = 'emulador-game-boy-emulator:dev';
  run('docker', ['build', '--target', 'emulator-build', '--tag', image, '.']);
  const destination = resolve(project, 'frontend/public/emulator');
  await mkdir(destination, { recursive: true });
  const name = `emulador-emulator-assets-${randomUUID()}`;
  let created = false;
  try {
    run('docker', ['create', '--name', name, '--network', 'none', '--entrypoint', '/bin/true', image]);
    created = true;
    run('docker', ['cp', `${name}:/work/public/.`, destination]);
  } finally {
    if (created) run('docker', ['rm', name]);
  }
  console.log('Motor e fontes preparados em frontend/public/emulator.');
}

if (process.argv[2] === 'prepare' && process.argv[3]) {
  await prepare(resolve(process.argv[3]));
} else if (process.argv.length === 2) {
  await installLocal();
} else {
  throw new Error('Uso: node scripts/vendor-emulator.mjs [prepare <diretório>].');
}

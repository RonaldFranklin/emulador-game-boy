import { run } from './docker.mjs';
import { normalizeGames, verifyReferences, verifySaveMetadata, verifyStateMetadata } from './catalog-backup.mjs';

export async function restoredGames(container, database) {
  const sql = (query) => run(['exec', '--user', 'postgres', container, 'psql', '-U', 'postgres', '-d', database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { quiet: true });
  if (await sql("SELECT to_regclass('public.games') IS NOT NULL") !== 't') return [];
  const typed = await sql("SELECT EXISTS (SELECT 1 FROM information_schema.columns WHERE table_schema='public' AND table_name='games' AND column_name='console')") === 't';
  const consoleColumn = typed ? 'console' : "'GB'::text AS console";
  return JSON.parse(await sql(`SELECT coalesce(json_agg(g ORDER BY id), '[]'::json) FROM
    (SELECT id, ${consoleColumn}, rom_key, rom_sha256, rom_size, cover_key, cover_sha256, cover_size FROM games) g`));
}

export async function verifyRestoredCatalogue({ games, manifest, fileContainer, directory }) {
  if (!manifest) {
    if (games.length) throw new Error('O dump contém jogos sem os arquivos correspondentes. Use o backup completo em pasta.');
    return;
  }
  if (JSON.stringify(normalizeGames(games)) !== JSON.stringify(normalizeGames(manifest.games, manifest.version))) throw new Error('Metadados restaurados divergem do manifesto.');
  verifyReferences(games, manifest.files);
  const files = manifest.files.filter((file) => file.path.startsWith('files/'));
  // Batch bounded argv lengths; file names have already passed the UUID allowlist.
  for (let offset = 0; offset < files.length; offset += 100) {
    const group = files.slice(offset, offset + 100);
    const output = await run(['exec', fileContainer, 'sha256sum', ...group.map((file) => `${directory}/${file.path.slice(6)}`)], { quiet: true });
    const hashes = output.split('\n').map((line) => line.split(/\s+/)[0]);
    if (hashes.length !== group.length || hashes.some((hash, i) => hash !== group[i].sha256)) throw new Error('Arquivo restaurado diverge do checksum.');
  }
}

export async function verifyRestoredSaves(container, database, manifest) {
  const sql = query => run(['exec', '--user', 'postgres', container, 'psql', '-U', 'postgres', '-d', database,
    '-At', '-v', 'ON_ERROR_STOP=1', '-c', query], { quiet: true });
  const present = await sql("SELECT to_regclass('public.game_saves') IS NOT NULL") === 't';
  const rows = present ? JSON.parse(await sql(`SELECT coalesce(json_agg(s ORDER BY user_id, game_id), '[]'::json)
    FROM (SELECT user_id, game_id, sha256, size, version FROM game_saves) s`)) : [];
  const expected = manifest?.version >= 3 ? manifest.saves : [];
  if (JSON.stringify(rows) !== JSON.stringify(expected)) throw new Error('Saves restaurados divergem do manifesto.');
  verifySaveMetadata(rows, manifest?.games ?? []);
  if (present && await sql("SELECT count(*) FROM game_saves WHERE size <> octet_length(data) OR sha256 <> encode(sha256(data), 'hex')") !== '0') {
    throw new Error('Conteúdo de save restaurado possui tamanho/checksum inválido.');
  }
  const hasStates=await sql("SELECT to_regclass('public.save_states') IS NOT NULL") === 't';
  const states=hasStates?JSON.parse(await sql(`SELECT coalesce(json_agg(s ORDER BY user_id,game_id,slot),'[]'::json) FROM (SELECT user_id,game_id,slot,version,label,console,rom_sha256,core_id,format,sha256,native_sha256,octet_length(data) AS size,octet_length(native) AS native_size FROM save_states WHERE data IS NOT NULL) s`)):[];
  if(JSON.stringify(states)!==JSON.stringify(manifest?.version>=4?manifest.states:[]))throw Error('Estados restaurados divergem do manifesto.');
  verifyStateMetadata(states,manifest?.games??[]);
  if(hasStates&&await sql("SELECT count(*) FROM save_states WHERE data IS NOT NULL AND (sha256<>encode(sha256(data),'hex') OR native_sha256<>encode(sha256(native),'hex'))")!=='0')throw Error('Checksum de estado restaurado inválido.');
  const resets=hasStates?JSON.parse(await sql("SELECT coalesce(json_agg(s ORDER BY user_id,game_id),'[]'::json) FROM (SELECT user_id,game_id,epoch FROM save_resets) s")):[];
  if(JSON.stringify(resets)!==JSON.stringify(manifest?.version>=4?manifest.resets:[]))throw Error('Marcadores de reinício divergentes.');
  console.log(`Estados restaurados e conferidos: ${states.length}.`);
  return rows.length;
}

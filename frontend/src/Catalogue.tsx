import { useEffect, useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from './api';
import type { Request } from './api';
import { ConsoleBadge, GameCover, GameStatus } from './Games';
import { coverHint, romHint, useGames, validateCover, validateName, validateRom } from './games';
import type { Game, GameConsole } from './games';
import { Alert, Dialog, Icon, Loading } from './ui';

export function Catalogue({ request }: { request: Request }) {
  const { games, loading, error, reload, saveGame } = useGames(request);
  const [editing, setEditing] = useState<Game | null>(null);
  const [notice, setNotice] = useState('');

  return <>
    <div className="page-heading">
      <div><span className="eyebrow">ÁREA DO MASTER</span><h1>Catálogo</h1><p>Organize jogos de Game Boy e Game Boy Advance.</p></div>
      <span className="tag neutral">GB + GBA</span>
    </div>
    {notice && <Alert kind="success">{notice}</Alert>}
    <div className="catalogue-layout">
      <section className="card catalogue-list-card" aria-labelledby="catalogue-list-title">
        <div className="card-heading"><h2 id="catalogue-list-title">Jogos cadastrados</h2>{!loading && !error && <span className="count-badge">{games.length}</span>}</div>
        <p className="muted">Jogadores veem apenas os jogos ativos. O master vê todos.</p>
        {loading ? <Loading>Carregando jogos…</Loading> : error ? <>
          <Alert>{error}</Alert><button className="button secondary" onClick={reload}>Atualizar catálogo</button>
        </> : games.length === 0 ? <div className="catalogue-empty"><Icon name="game" size={34} /><h3>Nenhum jogo cadastrado</h3><p>Preencha o formulário para começar seu catálogo.</p></div> : <ul className="catalogue-list">
          {games.map((game) => <li className="catalogue-entry" key={game.id}>
            <GameCover game={game} />
            <div className="catalogue-entry-details">
              <h3>{game.name}</h3>
              <div className="catalogue-entry-badges"><ConsoleBadge console={game.console} /><GameStatus active={game.active} /></div>
              <p className="field-hint">{game.hasCover ? 'Com capa' : 'Sem capa'} · cadastrado em {new Date(game.createdAt).toLocaleDateString('pt-BR')}</p>
            </div>
            <button className="button secondary" type="button" aria-label={`Editar ${game.name}`} onClick={() => { setNotice(''); setEditing(game); }}>Editar</button>
          </li>)}
        </ul>}
      </section>
      <GameEditor request={request} onSaved={(game) => { saveGame(game); setNotice(`Jogo “${game.name}” cadastrado. ${game.active ? 'Ele já aparece na biblioteca dos jogadores.' : 'Ele ficará visível apenas para o master enquanto estiver inativo.'}`); }} />
    </div>
    <p className="admin-footnote"><Icon name="lock" size={16} />A emulação ainda não está disponível. Esta etapa permite organizar o catálogo.</p>
    {editing && <GameEditor key={editing.id} game={editing} request={request} onDismiss={() => setEditing(null)} onSaved={(game) => {
      saveGame(game);
      setEditing(null);
      setNotice(`Jogo “${game.name}” atualizado. ${game.active ? 'Disponível no catálogo dos jogadores.' : 'Visível apenas para o master.'}`);
    }} />}
  </>;
}

type RomDetection =
  | { state: 'idle' | 'checking' }
  | { state: 'valid'; console: GameConsole }
  | { state: 'invalid'; message: string };

function GameEditor({ game, request, onSaved, onDismiss }: {
  game?: Game;
  request: Request;
  onSaved: (game: Game) => void;
  onDismiss?: () => void;
}) {
  const [name, setName] = useState(game?.name ?? '');
  const [active, setActive] = useState(game?.active ?? true);
  const [rom, setRom] = useState<File>();
  const [romDetection, setRomDetection] = useState<RomDetection>({ state: 'idle' });
  const [cover, setCover] = useState<File>();
  const [removeCover, setRemoveCover] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const romInput = useRef<HTMLInputElement>(null);
  const coverInput = useRef<HTMLInputElement>(null);
  const prefix = game ? 'edit-game' : 'new-game';

  useEffect(() => {
    if (!rom) { setRomDetection({ state: 'idle' }); return; }
    let current = true;
    setRomDetection({ state: 'checking' });
    validateRom(rom)
      .then((console) => { if (current) setRomDetection({ state: 'valid', console }); })
      .catch((reason: unknown) => { if (current) setRomDetection({ state: 'invalid', message: errorMessage(reason) }); });
    return () => { current = false; };
  }, [rom]);

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || (!game && ['checking', 'invalid'].includes(romDetection.state))) return;
    setError('');
    setBusy(true);
    try {
      const normalizedName = validateName(name);
      if (!game) await validateRom(rom);
      await validateCover(cover);
      const data = new FormData();
      data.set('name', normalizedName);
      data.set('active', String(active));
      if (!game && rom) data.set('rom', rom);
      if (cover) data.set('cover', cover);
      else if (removeCover) data.set('removeCover', 'true');
      const result = await request<{ game: Game }>(game ? `/games/${encodeURIComponent(game.id)}` : '/games', {
        method: game ? 'PATCH' : 'POST', body: data,
      });
      setRom(undefined);
      setCover(undefined);
      setRemoveCover(false);
      if (romInput.current) romInput.current.value = '';
      if (coverInput.current) coverInput.current.value = '';
      if (!game) { setName(''); setActive(true); }
      onSaved(result.game);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  const content = <>
    <p className="muted">{game ? 'Altere o nome, a capa ou a disponibilidade. O jogo mantém sua identidade.' : 'Adicione uma ROM de GB ou GBA. O console será identificado pelo conteúdo do arquivo.'}</p>
    {error && <Alert>{error}</Alert>}
    <form onSubmit={(event) => void submit(event)}>
      <fieldset disabled={busy}>
        {game && <div className="game-console-detail"><span className="field-caption">Console</span><ConsoleBadge console={game.console} /><p className="field-hint">O console e a ROM não podem ser alterados.</p></div>}
        <div className="field">
          <label htmlFor={`${prefix}-name`}>Nome do jogo</label>
          <input id={`${prefix}-name`} name="name" autoComplete="off" required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} aria-describedby={`${prefix}-name-hint`} />
          <span className="field-hint" id={`${prefix}-name-hint`}>De 1 a 120 caracteres.</span>
        </div>
        {!game ? <div className="field">
          <label htmlFor={`${prefix}-rom`}>ROM (.gb ou .gba)</label>
          <input ref={romInput} id={`${prefix}-rom`} className="file-input" name="rom" type="file" accept=".gb,.gba" required onChange={(event) => { const file = event.target.files?.[0]; setRom(file); setRomDetection({ state: file ? 'checking' : 'idle' }); setError(''); }} aria-describedby={`${prefix}-rom-hint ${prefix}-rom-detection`} aria-invalid={romDetection.state === 'invalid' ? true : undefined} />
          <span className="field-hint" id={`${prefix}-rom-hint`}>{romHint}</span>
          <div id={`${prefix}-rom-detection`}>
            {romDetection.state === 'checking' && <p className="field-hint" role="status">Verificando o cabeçalho da ROM…</p>}
            {romDetection.state === 'invalid' && <p className="rom-validation-error" role="alert">{romDetection.message}</p>}
            {romDetection.state === 'valid' && <div className="rom-detection" role="status"><span>Console detectado:</span><ConsoleBadge console={romDetection.console} /><p className="field-hint">O cadastro será confirmado após a validação do arquivo pelo servidor.</p></div>}
          </div>
          <p className="field-hint">A ROM não poderá ser substituída depois do cadastro. O mesmo arquivo não pode ser cadastrado duas vezes.</p>
        </div> : <div className="immutable-rom"><Icon name="lock" size={17} /><p>A ROM deste jogo já está cadastrada e não pode ser substituída nesta etapa.</p></div>}
        <div className="field">
          <label htmlFor={`${prefix}-cover`}>{game ? 'Nova capa (opcional)' : 'Capa (opcional)'}</label>
          <input ref={coverInput} id={`${prefix}-cover`} className="file-input" name="cover" type="file" accept="image/png,image/jpeg,.png,.jpg,.jpeg" onChange={(event) => {
            const file = event.target.files?.[0];
            setCover(file);
            if (file) setRemoveCover(false);
          }} aria-describedby={`${prefix}-cover-hint`} />
          <span className="field-hint" id={`${prefix}-cover-hint`}>{coverHint}{game?.hasCover ? ' Se não escolher outra imagem, a capa atual será mantida.' : ''}</span>
        </div>
        {game?.hasCover && <div className="checkbox-field">
          <input id={`${prefix}-remove-cover`} name="removeCover" type="checkbox" checked={removeCover} onChange={(event) => {
            setRemoveCover(event.target.checked);
            if (event.target.checked) {
              setCover(undefined);
              if (coverInput.current) coverInput.current.value = '';
            }
          }} />
          <label htmlFor={`${prefix}-remove-cover`}>Remover capa atual</label>
        </div>}
        <div className="availability-field">
          <div className="checkbox-field">
            <input id={`${prefix}-active`} name="active" type="checkbox" checked={active} onChange={(event) => setActive(event.target.checked)} aria-describedby={`${prefix}-active-hint`} />
            <label htmlFor={`${prefix}-active`}>Disponível para jogadores</label>
          </div>
          <p className="field-hint" id={`${prefix}-active-hint`}>{active ? 'Ativo: aparece na biblioteca dos jogadores.' : 'Inativo: aparece somente para o master.'}</p>
        </div>
        <div className={game ? 'dialog-actions' : 'catalogue-submit'}>
          {game && <button className="button secondary" type="button" onClick={onDismiss}>Cancelar</button>}
          <button className={`button primary ${game ? '' : 'full-width'}`} type="submit" disabled={!game && ['checking', 'invalid'].includes(romDetection.state)}>{busy ? 'Salvando…' : game ? 'Salvar alterações' : 'Cadastrar jogo'}{!game && <Icon name="plus" size={18} />}</button>
        </div>
        {busy && <p className="field-hint" role="status">Enviando e validando os arquivos. Aguarde a confirmação.</p>}
      </fieldset>
    </form>
  </>;

  if (game) return <Dialog title="Editar jogo" busy={busy} onDismiss={() => onDismiss?.()}>{content}</Dialog>;
  return <section className="card catalogue-create-card" aria-labelledby="catalogue-create-title">
    <span className="card-icon"><Icon name="plus" /></span>
    <h2 id="catalogue-create-title">Cadastrar jogo</h2>
    {content}
  </section>;
}

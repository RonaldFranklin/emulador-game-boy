import { useState } from 'react';
import type { Request } from './api';
import { consoleNames, coverSource, useGames } from './games';
import type { Game, GameConsole } from './games';
import { Alert, Icon, Loading } from './ui';

export function GameCover({ game }: { game: Game }) {
  const source = coverSource(game);
  return <CoverImage key={source ?? 'no-cover'} source={source} name={game.name} />;
}

function CoverImage({ source, name }: { source: string | null; name: string }) {
  const [failed, setFailed] = useState(false);
  return <div className="game-cover">
    {source && !failed
      ? <img src={source} alt={`Capa de ${name}`} loading="lazy" decoding="async" onError={() => setFailed(true)} />
      : <div className="game-cover-placeholder"><Icon name="game" size={38} /><span>{failed ? 'Capa indisponível' : 'Sem capa'}</span></div>}
  </div>;
}

export function GameStatus({ active }: { active: boolean }) {
  return <span className={`tag ${active ? 'enabled' : 'blocked'}`}>{active ? 'Ativo' : 'Inativo'}</span>;
}

export function ConsoleBadge({ console: gameConsole }: { console: GameConsole }) {
  return <span className="tag neutral console-badge" data-console={gameConsole}><strong>{gameConsole}</strong><span>{consoleNames[gameConsole]}</span></span>;
}

export function Games({ request, master, onPlay }: { request: Request; master: boolean; onPlay: (game: Game) => void }) {
  const { games, loading, error, reload } = useGames(request);
  return <>
    <div className="page-heading">
      <div><span className="eyebrow">SEU ESPAÇO DE JOGO</span><h1>Biblioteca</h1><p>{master ? 'Jogos de GB e GBA do catálogo, incluindo os inativos.' : 'Jogos de Game Boy e Game Boy Advance disponíveis para a sua conta.'}</p></div>
      <span className="tag neutral">GB + GBA</span>
    </div>
    {loading ? <Loading>Carregando o catálogo…</Loading> : error ? <div className="card">
      <Alert>{error}</Alert><button className="button secondary" onClick={reload}>Tentar novamente</button>
    </div> : games.length === 0 ? <section className="empty-library">
      <span className="empty-icon"><Icon name="game" size={42} /></span>
      <span className="eyebrow">UM LUGAR PARA OS CLÁSSICOS</span>
      <h2>{master ? 'Seu catálogo começa por aqui' : 'Sua biblioteca começa em breve'}</h2>
      <p>{master ? 'Nenhum jogo foi cadastrado. Acesse a aba Catálogo para adicionar o primeiro.' : 'Nenhum jogo está disponível no momento. Aguarde a disponibilização pelo administrador.'}</p>
      <span className="tag outlined">0 jogos disponíveis</span>
    </section> : <>
      <p className="catalogue-count">{games.length} {games.length === 1 ? 'jogo' : 'jogos'} {master ? 'no catálogo' : games.length === 1 ? 'disponível' : 'disponíveis'}</p>
      <div className="game-grid">
        {games.map((game) => <article className="game-card" key={game.id} aria-labelledby={`game-title-${game.id}`}>
          <GameCover game={game} />
          <div className="game-card-body">
            <div className="game-card-meta"><ConsoleBadge console={game.console} />{master && <GameStatus active={game.active} />}</div>
            <h2 id={`game-title-${game.id}`}>{game.name}</h2>
            <button className="button secondary full-width play-unavailable" type="button" disabled={!game.active} onClick={() => onPlay(game)} aria-describedby={`game-unavailable-${game.id}`}><Icon name="game" size={18} />Jogar</button>
            <p className="field-hint" id={`game-unavailable-${game.id}`}>{game.active ? 'Seu save de cartucho acompanha sua conta.' : 'Ative este jogo no catálogo para jogar.'}</p>
          </div>
        </article>)}
      </div>
    </>}
    <div className="library-note"><Icon name="lock" size={18} /><p>Use a opção de salvar do próprio jogo e aguarde a confirmação do servidor antes de sair.</p></div>
  </>;
}

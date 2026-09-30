import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { api, ApiError, errorMessage } from './api';
import type { Request, Session } from './api';
import { Alert, Brand, Icon, Loading, PasswordFields } from './ui';
import { Users } from './Users';
import { ThemeToggle } from './ThemeToggle';
import { Games } from './Games';
import { Catalogue } from './Catalogue';
import { Player } from './Player';
import type { Game } from './games';

type Page = 'games' | 'catalogue' | 'users' | 'password';

export function App() {
  const [playing, setPlaying] = useState<Game | null>(null);
  const [session, setSession] = useState<Session | null>(null);
  const [checking, setChecking] = useState(true);
  const [connectionError, setConnectionError] = useState('');
  const [notice, setNotice] = useState('');
  const [page, setPage] = useState<Page>('games');
  const [signingOut, setSigningOut] = useState(false);
  const [logoutError, setLogoutError] = useState('');
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setChecking(true);
    setConnectionError('');
    api<Session>('/auth/me', { signal: controller.signal })
      .then(setSession)
      .catch((error: unknown) => {
        if (controller.signal.aborted) return;
        if (!(error instanceof ApiError && error.status === 401)) setConnectionError(errorMessage(error));
      })
      .finally(() => { if (!controller.signal.aborted) setChecking(false); });
    return () => controller.abort();
  }, [attempt]);

  const endSession = useCallback((message: string) => {
    setPlaying(null);
    setSession(null);
    setPage('games');
    setLogoutError('');
    setNotice(message);
  }, []);

  const request: Request = useCallback(async (path, options = {}) => {
    try {
      return await api(path, { ...options, csrfToken: session?.csrfToken });
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) endSession('Sua sessão foi encerrada. Entre novamente para continuar.');
      throw error;
    }
  }, [session?.csrfToken, endSession]);

  async function logout() {
    if (signingOut) return;
    setSigningOut(true);
    setLogoutError('');
    try {
      await request('/auth/logout', { method: 'POST' });
      endSession('Você saiu da sua conta.');
    } catch (error) {
      setLogoutError(errorMessage(error));
    } finally {
      setSigningOut(false);
    }
  }

  if (checking) return <div className="startup"><Brand /><div className="startup-theme"><ThemeToggle /></div><Loading>Verificando sua sessão…</Loading></div>;
  if (connectionError) return <div className="startup"><Brand /><div className="startup-theme"><ThemeToggle /></div><div className="startup-error"><Alert>{connectionError}</Alert><button className="button primary" onClick={() => setAttempt((value) => value + 1)}>Tentar novamente</button></div></div>;
  if (!session) return <Login notice={notice} onLogin={(next) => { setSession(next); setNotice(''); setPage('games'); }} />;

  const forcedPassword = session.user.mustChangePassword;
  const activePage = forcedPassword ? 'password' : page;

  return <div className="app-shell">
    <a className="skip-link" href="#main-content">Ir para o conteúdo</a>
    <header className="site-header"><div className="header-inner"><Brand /><div className="header-actions"><ThemeToggle /><div className="account"><span className="avatar" aria-hidden="true">{session.user.username.slice(0, 1).toUpperCase()}</span><div className="account-info"><strong>{session.user.username}</strong><span>{session.user.role === 'MASTER' ? 'Master' : 'Jogador'}</span></div><button className="button quiet logout-button" onClick={() => void logout()} disabled={signingOut || !!playing} title={playing ? 'Volte à biblioteca antes de sair da conta.' : undefined}><Icon name="exit" /><span>{signingOut ? 'Saindo…' : 'Sair'}</span></button></div></div></div></header>
    <div className="content-width">
      {!playing && <nav className="navigation" aria-label="Navegação principal">
        {!forcedPassword && <button className={activePage === 'games' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('games')} aria-current={activePage === 'games' ? 'page' : undefined}><Icon name="game" />Jogar</button>}
        {!forcedPassword && session.user.role === 'MASTER' && <button className={activePage === 'catalogue' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('catalogue')} aria-current={activePage === 'catalogue' ? 'page' : undefined}><Icon name="catalogue" />Catálogo</button>}
        {!forcedPassword && session.user.role === 'MASTER' && <button className={activePage === 'users' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('users')} aria-current={activePage === 'users' ? 'page' : undefined}><Icon name="users" />Administração</button>}
        <button className={activePage === 'password' ? 'nav-item active' : 'nav-item'} onClick={() => setPage('password')} aria-current={activePage === 'password' ? 'page' : undefined}><Icon name="lock" />Minha senha</button>
      </nav>}
      <main id="main-content" tabIndex={-1}>
        {logoutError && <Alert>{logoutError}</Alert>}
        {playing ? <Player key={`${session.user.id}:${playing.id}`} game={playing} userId={session.user.id} request={request} onExit={() => setPlaying(null)} /> : activePage === 'games' && <Games request={request} master={session.user.role === 'MASTER'} onPlay={setPlaying} />}
        {activePage === 'catalogue' && session.user.role === 'MASTER' && <Catalogue request={request} />}
        {activePage === 'users' && session.user.role === 'MASTER' && <Users request={request} currentUserId={session.user.id} />}
        {activePage === 'password' && <ChangePassword request={request} forced={forcedPassword} onChanged={() => endSession('Senha atualizada. Todas as suas sessões foram encerradas. Entre com a nova senha.')} />}
      </main>
      <footer className="site-footer"><span>Emulador Game Boy</span><span>Um lugar para os clássicos.</span></footer>
    </div>
  </div>;
}

function Login({ notice, onLogin }: { notice: string; onLogin: (session: Session) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setError('');
    try {
      const session = await api<Session>('/auth/login', { method: 'POST', body: { username, password } });
      setPassword('');
      onLogin(session);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <main className="login-layout">
    <section className="login-story"><div className="login-brand-row"><Brand /><ThemeToggle /></div><div className="story-content"><span className="eyebrow">OS CLÁSSICOS TÊM SEU LUGAR</span><h1>Pequena tela.<br />Grandes memórias.</h1><p>Seu espaço de Game Boy e Game Boy Advance começa aqui.<br />Entre com sua conta para acompanhar o projeto.</p><div className="console-art" aria-hidden="true"><div className="console-screen-frame"><span className="console-led" /><div className="console-screen"><div className="pixel-heart">♥</div><span>GAME BOY</span></div></div><div className="console-controls"><div className="dpad" /><div className="console-buttons"><i /><i /></div></div><div className="console-bottom"><i /><i /></div></div></div><p className="story-footer">Feito para jogar, no seu ritmo.</p></section>
    <section className="login-form-panel" aria-labelledby="login-title"><div className="login-card"><span className="eyebrow">BEM-VINDO DE VOLTA</span><h2 id="login-title">Entre na sua conta</h2><p className="lead">Use o acesso fornecido pelo administrador.</p>{notice && <Alert kind="success">{notice}</Alert>}{error && <Alert>{error}</Alert>}<form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}><div className="field"><label htmlFor="login-username">Nome de usuário</label><input id="login-username" name="username" autoComplete="username" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern="[a-z0-9_]{3,32}" title="De 3 a 32 letras minúsculas, números ou sublinhado." value={username} onChange={(event) => setUsername(event.target.value)} /></div><div className="field"><label htmlFor="login-password">Senha</label><input id="login-password" name="password" type="password" autoComplete="current-password" required maxLength={128} value={password} onChange={(event) => setPassword(event.target.value)} /></div><button className="button primary full-width" type="submit">{busy ? 'Entrando…' : 'Entrar'}<Icon name="arrow" size={18} /></button></fieldset></form><p className="login-help">Precisa de acesso ou esqueceu sua senha?<br />Fale com o administrador.</p><div className="development-note"><span className="status-dot" /><span>Projeto em desenvolvimento. Consulte o catálogo após entrar. GB e GBA são executados no navegador, com progresso nativo salvo na sua conta.</span></div></div></section>
  </main>;
}

function ChangePassword({ request, forced, onChanged }: { request: Request; forced: boolean; onChanged: () => void }) {
  const [currentPassword, setCurrentPassword] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError('As senhas não conferem. Digite a mesma senha nos dois campos.'); return; }
    if (password === currentPassword) { setError('Escolha uma senha diferente da senha atual.'); return; }
    setBusy(true);
    setError('');
    try {
      await request('/auth/password', { method: 'POST', body: { currentPassword, newPassword: password } });
      setCurrentPassword('');
      setPassword('');
      setConfirmation('');
      onChanged();
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <><div className="page-heading"><div><span className="eyebrow">SUA CONTA</span><h1>{forced ? 'Defina sua senha' : 'Minha senha'}</h1><p>{forced ? 'Troque a senha temporária para continuar.' : 'Cuide do acesso à sua conta.'}</p></div></div><section className="card password-card">{forced && <Alert kind="info">Você está usando uma senha temporária. Crie uma senha pessoal antes de acessar as outras áreas.</Alert>}<h2>Alterar senha</h2><p className="muted">Ao salvar, todas as suas sessões serão encerradas. Você precisará entrar novamente com a nova senha.</p>{error && <Alert>{error}</Alert>}<form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}><div className="field"><label htmlFor="current-password">{forced ? 'Senha temporária atual' : 'Senha atual'}</label><input id="current-password" name="currentPassword" type="password" autoComplete="current-password" required maxLength={128} value={currentPassword} onChange={(event) => setCurrentPassword(event.target.value)} /></div><PasswordFields prefix="own" password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} /><button className="button primary" type="submit">{busy ? 'Salvando…' : 'Salvar nova senha'}</button></fieldset></form></section></>;
}

import { useCallback, useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { errorMessage } from './api';
import type { Request, User } from './api';
import { Alert, Dialog, Icon, Loading, PasswordFields } from './ui';

type Action = { kind: 'block' | 'reset'; user: User };

export function Users({ request, currentUserId }: { request: Request; currentUserId: string }) {
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [action, setAction] = useState<Action | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);
  const [attempt, setAttempt] = useState(0);

  useEffect(() => {
    const controller = new AbortController();
    setLoading(true);
    setError('');
    request<{ users: User[] }>('/users', { signal: controller.signal })
      .then((result) => { if (!controller.signal.aborted) setUsers(result.users); })
      .catch((reason: unknown) => { if (!controller.signal.aborted) setError(errorMessage(reason)); })
      .finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [request, attempt]);

  const updateUser = useCallback((user: User) => {
    setUsers((current) => current.map((item) => item.id === user.id ? user : item));
  }, []);

  async function unblock(user: User) {
    if (busyUserId) return;
    setBusyUserId(user.id);
    setError('');
    setNotice('');
    try {
      const result = await request<{ user: User }>(`/users/${encodeURIComponent(user.id)}/status`, { method: 'PATCH', body: { blocked: false } });
      updateUser(result.user);
      setNotice(`Acesso de ${user.username} liberado. O jogador já pode entrar novamente.`);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusyUserId(null);
    }
  }

  return <>
    <div className="page-heading"><div><span className="eyebrow">ÁREA DO MASTER</span><h1>Jogadores</h1><p>Gerencie quem pode acessar a sua biblioteca.</p></div><span className="tag neutral"><Icon name="users" size={15} />Administração</span></div>
    {notice && <Alert kind="success">{notice}</Alert>}
    <div className="admin-layout">
      <section className="card users-card" aria-labelledby="users-title"><div className="card-heading"><h2 id="users-title">Contas cadastradas</h2>{!loading && !error && <span className="count-badge">{users.length}</span>}</div><p className="muted">Bloquear uma conta encerra todas as sessões do jogador.</p>
        {error && <Alert>{error}</Alert>}
        {loading ? <Loading>Carregando contas…</Loading> : <>{error && <button className="button secondary" onClick={() => setAttempt((value) => value + 1)}>Atualizar lista</button>}{users.length > 0 && <ul className="user-list">{users.map((user) => {
          const protectedAccount = user.role === 'MASTER' || user.id === currentUserId;
          const joiningDate = new Date(user.createdAt).toLocaleDateString('pt-BR');
          return <li className="user-row" key={user.id}><div className="user-summary"><span className={`avatar ${user.blocked ? 'avatar-muted' : ''}`} aria-hidden="true">{user.username.slice(0, 1).toUpperCase()}</span><div className="user-details"><div className="user-name"><strong>{user.username}</strong>{user.id === currentUserId && <span className="self-label">você</span>}</div><span className="user-meta">{user.role === 'MASTER' ? 'Master' : 'Jogador'} · desde {joiningDate}</span></div></div><div className="user-status"><span className={`tag ${user.blocked ? 'blocked' : 'enabled'}`}>{user.blocked ? 'Bloqueado' : 'Ativo'}</span>{user.mustChangePassword && <span className="temporary-label">Senha temporária</span>}</div>{protectedAccount ? <span className="protected-label"><Icon name="lock" size={14} />Conta protegida</span> : <div className="user-actions"><button className="text-button" disabled={!!busyUserId} onClick={() => { setNotice(''); setAction({ kind: 'reset', user }); }} aria-label={`Redefinir senha de ${user.username}`}>Redefinir senha</button><button className={`text-button ${user.blocked ? '' : 'danger-text'}`} disabled={!!busyUserId} onClick={() => { if (user.blocked) void unblock(user); else { setNotice(''); setAction({ kind: 'block', user }); } }} aria-label={`${user.blocked ? 'Desbloquear' : 'Bloquear'} ${user.username}`}>{busyUserId === user.id ? 'Salvando…' : user.blocked ? 'Desbloquear' : 'Bloquear'}</button></div>}</li>;
        })}</ul>}{!error && users.length === 0 && <p className="muted">Nenhuma conta encontrada.</p>}</>}
      </section>
      <CreateUser request={request} onCreated={(user) => { setUsers((current) => [...current, user]); setNotice(`Conta ${user.username} criada. O jogador deverá trocar a senha temporária no primeiro acesso.`); }} />
    </div>
    <p className="admin-footnote"><Icon name="lock" size={16} />Contas master são protegidas. Esta área gerencia somente jogadores.</p>
    {action && <UserAction action={action} request={request} onDismiss={() => setAction(null)} onComplete={(user) => { if (user) updateUser(user); else setUsers((current) => current.map((item) => item.id === action.user.id ? { ...item, mustChangePassword: true } : item)); setNotice(action.kind === 'block' ? `Conta ${action.user.username} bloqueada e sessões encerradas.` : `Senha de ${action.user.username} redefinida. As sessões foram encerradas e a troca de senha será obrigatória.`); setAction(null); }} />}
  </>;
}

function CreateUser({ request, onCreated }: { request: Request; onCreated: (user: User) => void }) {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (password !== confirmation) { setError('As senhas não conferem. Digite a mesma senha nos dois campos.'); return; }
    setBusy(true);
    setError('');
    try {
      const result = await request<{ user: User }>('/users', { method: 'POST', body: { username, password } });
      setUsername('');
      setPassword('');
      setConfirmation('');
      onCreated(result.user);
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <section className="card create-card" aria-labelledby="create-title"><span className="card-icon"><Icon name="plus" /></span><h2 id="create-title">Novo jogador</h2><p className="muted">Crie um acesso e forneça a senha temporária ao jogador por um canal seguro.</p>{error && <Alert>{error}</Alert>}<form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}><div className="field"><label htmlFor="create-username">Nome de usuário</label><input id="create-username" name="username" autoComplete="off" autoCapitalize="none" spellCheck={false} required minLength={3} maxLength={32} pattern="[a-z0-9_]{3,32}" title="De 3 a 32 letras minúsculas, números ou sublinhado." aria-describedby="create-username-hint" value={username} onChange={(event) => setUsername(event.target.value)} /><span className="field-hint" id="create-username-hint">3 a 32 caracteres: letras minúsculas, números ou _.</span></div><PasswordFields prefix="create" label="Senha temporária" password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} /><button className="button primary full-width" type="submit">{busy ? 'Criando…' : 'Criar jogador'}<Icon name="plus" size={18} /></button></fieldset></form><p className="field-hint create-note">A troca da senha será obrigatória no primeiro acesso.</p></section>;
}

function UserAction({ action, request, onDismiss, onComplete }: { action: Action; request: Request; onDismiss: () => void; onComplete: (user?: User) => void }) {
  const [password, setPassword] = useState('');
  const [confirmation, setConfirmation] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const blocking = action.kind === 'block';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    if (!blocking && password !== confirmation) { setError('As senhas não conferem. Digite a mesma senha nos dois campos.'); return; }
    setBusy(true);
    setError('');
    try {
      if (blocking) {
        const result = await request<{ user: User }>(`/users/${encodeURIComponent(action.user.id)}/status`, { method: 'PATCH', body: { blocked: true } });
        onComplete(result.user);
      } else {
        await request(`/users/${encodeURIComponent(action.user.id)}/reset-password`, { method: 'POST', body: { password } });
        setPassword('');
        setConfirmation('');
        onComplete();
      }
    } catch (reason) {
      setError(errorMessage(reason));
    } finally {
      setBusy(false);
    }
  }

  return <Dialog title={blocking ? 'Bloquear jogador' : 'Redefinir senha'} busy={busy} onDismiss={onDismiss}><p className="muted">{blocking ? <>Você vai bloquear <strong>{action.user.username}</strong>. As sessões serão encerradas e o acesso ficará suspenso até o desbloqueio.</> : <>Você vai redefinir a senha de <strong>{action.user.username}</strong>. Todas as sessões serão encerradas e o jogador deverá trocar a senha temporária no próximo acesso.</>}</p>{error && <Alert>{error}</Alert>}<form onSubmit={(event) => void submit(event)}><fieldset disabled={busy}>{!blocking && <PasswordFields prefix="reset" label="Nova senha temporária" password={password} confirmation={confirmation} onPassword={setPassword} onConfirmation={setConfirmation} />}<div className="dialog-actions"><button className="button secondary" type="button" onClick={onDismiss}>Cancelar</button><button className={`button ${blocking ? 'danger' : 'primary'}`} type="submit">{busy ? 'Salvando…' : blocking ? 'Confirmar bloqueio' : 'Confirmar redefinição'}</button></div></fieldset></form></Dialog>;
}

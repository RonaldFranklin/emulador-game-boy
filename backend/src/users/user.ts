export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'MASTER' | 'JOGADOR';
  blocked: boolean;
  must_change_password: boolean;
  created_at: Date;
  mfa_secret: string | null;
  mfa_last_step: string;
  mfa_recovery_hashes: string[];
  mfa_pending_secret: string | null;
  mfa_pending_until: Date | null;
  mfa_pending_session: string | null;
}

export function publicUser(row: UserRow) {
  return {
    id: row.id,
    username: row.username,
    role: row.role,
    blocked: row.blocked,
    mustChangePassword: row.must_change_password,
    createdAt: row.created_at.toISOString(),
  };
}

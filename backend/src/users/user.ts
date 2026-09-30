export interface UserRow {
  id: string;
  username: string;
  password_hash: string;
  role: 'MASTER' | 'JOGADOR';
  blocked: boolean;
  must_change_password: boolean;
  created_at: Date;
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

// Only isolated fixtures for tests of other contracts. The MFA protocol itself
// is exercised without this shortcut in mfa.integration.test.mjs.
import { createHash } from 'node:crypto';
export async function verifiedMaster(pool,user,cookie) {
 if(user.role!=='MASTER')return;
 const db=(await pool.query('SELECT current_database() AS name')).rows[0].name;
 if(!/^emulador_(test|browser|play|security|catalog)_/.test(db))throw new Error('Fixture MFA exige banco de ensaio isolado.');
 await pool.query("UPDATE users SET mfa_secret='isolated-fixture-no-totp' WHERE id=$1",[user.id]);
 await pool.query("UPDATE sessions SET mfa_verified_at=clock_timestamp(),expires_at=clock_timestamp()+interval '8 hours' WHERE token_hash=$1",[createHash('sha256').update(cookie.split('=')[1]).digest('hex')]);
}

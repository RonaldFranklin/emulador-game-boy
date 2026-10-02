import pg from 'pg';
import { databaseConfig } from '../../backend/dist/config.js';
import { verifiedMaster } from './verified-master.mjs';

// Existing browser scenarios test other contracts. Dedicated security-ui/MFA
// tests exercise enrollment/verification without this synthetic DB fixture.
export async function completeFixtureMaster(page,response) {
 if(response.status()!==200)return;
 const data=await response.json();if(data.user?.role!=='MASTER')return;
 const pool=new pg.Pool(databaseConfig());
 try {await verifiedMaster(pool,data.user,(await response.headerValue('set-cookie')).split(';')[0]);}
 finally {await pool.end();}
 await page.reload();
}

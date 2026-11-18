require('dotenv').config();
const { Client } = require('pg');
(async()=>{
 for(const u of [process.env.DATABASE_POOLER_URL,process.env.DATABASE_URL].filter(Boolean)){try{const c=new Client({connectionString:u,ssl:{rejectUnauthorized:false},connectionTimeoutMillis:8000});await c.connect();
  const r=await c.query("select table_name, array_agg(column_name order by ordinal_position) cols from information_schema.columns where table_schema='public' group by 1 order by 1");
  for(const x of r.rows)console.log(x.table_name+': '+x.cols.join(','));await c.end();return}catch(e){console.error('fail',e.message)}}
})();

import * as schema from './schema/index.js';
export declare const pool: import("pg").Pool;
export declare const db: import("drizzle-orm/node-postgres").NodePgDatabase<typeof schema> & {
    $client: import("pg").Pool;
};
export type Db = typeof db;
//# sourceMappingURL=client.d.ts.map
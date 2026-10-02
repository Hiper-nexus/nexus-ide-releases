import type { Config } from './config.js';
import type { SessionRow } from './db/schema.js';
export type AppEnv={Bindings:CloudflareBindings;Variables:{config:Config;session:SessionRow}};

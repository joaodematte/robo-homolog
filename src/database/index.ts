import { drizzle as drizzleMysql } from "drizzle-orm/mysql2";

import * as schema from "./schema";

export function createDb() {
  return drizzleMysql(process.env.DATABASE_URL ?? "", {
    mode: "default",
    schema,
  });
}

export const db = createDb();

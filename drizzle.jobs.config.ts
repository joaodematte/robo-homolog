import { defineConfig } from "drizzle-kit";

export default defineConfig({
  dbCredentials: {
    url: process.env.JOBS_DATABASE_URL ?? "",
  },
  dialect: "postgresql",
  out: "./src/jobs/migrations",
  schema: "./src/jobs/schema.ts",
});

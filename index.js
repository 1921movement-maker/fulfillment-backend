import Fastify from "fastify";
import pkg from "pg";

console.log("DATABASE_URL exists:", !!process.env.DATABASE_URL);

const { Pool } = pkg;

const app = Fastify({ logger: true });

// Connect to Postgres using Railway env var
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Test route
app.get("/health", async () => {
  const result = await pool.query("SELECT 1");
  return {
    status: "ok",
    database: result.rowCount === 1,
  };
});

// Start server
app.listen({
  port: process.env.PORT || 3000,
  host: "0.0.0.0",
});

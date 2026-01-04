import Fastify from "fastify";
import pkg from "pg";

const { Pool } = pkg;

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Health check
app.get("/health", async () => {
  const result = await pool.query("SELECT 1");
  return {
    status: "ok",
    database: result.rowCount === 1,
  };
});

app.get("/orders/stats", async (request, reply) => {
  try {
    const result = await pool.query(`
      SELECT status, COUNT(*) as count
      FROM orders
      GROUP BY status
    `);

    const stats = result.rows.reduce((acc, row) => {
      acc[row.status] = parseInt(row.count, 10);
      return acc;
    }, {});

    return reply.send({ stats });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to fetch order stats" });
  }
});

app.get("/orders", async (request, reply) => {
  const { status, startDate, endDate } = request.query;

  let query = `
    SELECT
      o.id,
      o.order_number,
      o.order_date,
      o.customer_name,
      o.recipient_name,
      o.order_total,
      o.status,
      b.name AS batch_name,
      COUNT(oi.id) AS item_count,
      COALESCE(SUM(oi.quantity), 0) AS total_quantity
    FROM orders o
    LEFT JOIN batches b ON o.batch_id = b.id
    LEFT JOIN order_items oi ON oi.order_id = o.id
  `;

  const conditions = [];
  const params = [];

  if (status) {
    conditions.push(`o.status = $${conditions.length + 1}`);
    params.push(status);
  }

  if (startDate) {
    conditions.push(`o.order_date >= $${conditions.length + 1}`);
    params.push(startDate);
  }

  if (endDate) {
    conditions.push(`o.order_date <= $${conditions.length + 1}`);
    params.push(endDate);
  }

  if (conditions.length > 0) {
    query += ` WHERE ` + conditions.join(" AND ");
  }

  query += `
    GROUP BY o.id, b.name
    ORDER BY o.order_date DESC
  `;

  try {
    const result = await pool.query(query, params);
    return reply.send({ orders: result.rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to fetch orders" });
  }
});

// --------------------
// Batches
// --------------------

// Create a new batch
app.post("/batches", async (request, reply) => {
  const { name } = request.body;

  try {
    const result = await pool.query(
      `INSERT INTO batches (name)
       VALUES ($1)
       RETURNING *`,
      [name]
    );

    return reply.send({ batch: result.rows[0] });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to create batch" });
  }
});
// Assign orders to a batch
app.post("/batches/:batchId/orders", async (request, reply) => {
  const { batchId } = request.params;
  const { orderIds } = request.body; // array of order IDs

  try {
    await pool.query(
      `
      UPDATE orders
      SET batch_id = $1
      WHERE id = ANY($2::int[])
      `,
      [batchId, orderIds]
    );

    return reply.send({ success: true });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to assign orders to batch" });
  }
});


// Start server
app.listen({
  port: process.env.PORT || 3000,
  host: "0.0.0.0",
});


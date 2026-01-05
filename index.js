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

// Get all batches with order counts
app.get("/batches", async (request, reply) => {
  try {
    const result = await pool.query(`
      SELECT
        b.id,
        b.name,
        COUNT(o.id) AS order_count
      FROM batches b
      LEFT JOIN orders o ON o.batch_id = b.id
      GROUP BY b.id
      ORDER BY b.id DESC
    `);

    return reply.send({ batches: result.rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to fetch batches" });
  }
});

// Get orders in a batch (pick list)
app.get("/batches/:batchId/orders", async (request, reply) => {
  const { batchId } = request.params;

  try {
    const result = await pool.query(`
      SELECT
        o.id,
        o.order_number,
        o.customer_name,
        o.recipient_name,
        o.status,
        SUM(oi.quantity) AS total_items
      FROM orders o
      LEFT JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id = $1
      GROUP BY o.id
      ORDER BY o.id
    `, [batchId]);

    return reply.send({ orders: result.rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to fetch batch orders" });
  }
});

// --------------------
// Pick List (Aggregated by SKU)
// --------------------

app.get("/batches/:batchId/pick-list", async (request, reply) => {
  const { batchId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        oi.sku,
        oi.product_name,
        SUM(oi.quantity)::int AS total_quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id = $1
      GROUP BY oi.sku, oi.product_name
      ORDER BY oi.product_name;
      `,
      [batchId]
    );

    return reply.send({ pick_list: result.rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to generate pick list" });
  }
});

// ==============================
// CREATE SHIPMENT
// ==============================
app.post("/shipments", async (request, reply) => {
  const { order_id, carrier, tracking_number } = request.body;

  if (!order_id || !carrier || !tracking_number) {
    return reply.code(400).send({ error: "Missing required fields" });
  }

  try {
    // Create shipment
    await pool.query(
      `
      INSERT INTO shipments (order_id, carrier, tracking_number, shipped_at)
      VALUES ($1, $2, $3, NOW())
      `,
      [order_id, carrier, tracking_number]
    );

    // Update order status
    await pool.query(
      `
      UPDATE orders
      SET status = 'Shipped'
      WHERE id = $1
      `,
      [order_id]
    );

    return reply.send({ success: true, message: "Shipment created" });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to create shipment" });
  }
});

// ==============================
// GET SHIPMENTS FOR ORDER
// ==============================
app.get("/orders/:orderId/shipments", async (request, reply) => {
  const { orderId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        s.id,
        s.carrier,
        s.tracking_number,
        s.shipped_at,
        o.order_number,
        o.status
      FROM shipments s
      JOIN orders o ON s.order_id = o.id
      WHERE o.id = $1
      ORDER BY s.shipped_at DESC
      `,
      [orderId]
    );

    return reply.send({
      order_id: orderId,
      shipments: result.rows,
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to fetch shipments" });
  }
});

// ==============================
// POST SHIPMENT (Add tracking)
// ==============================
// ==============================
// POST SHIPMENT (AUTO-UPDATES ORDER STATUS)
// ==============================
app.post("/orders/:orderId/shipments", async (request, reply) => {
  const { orderId } = request.params;
  const { carrier, tracking_number, shipped_at } = request.body;

  try {
    // 1️⃣ Create shipment
    await pool.query(
      `
      INSERT INTO shipments (order_id, carrier, tracking_number, shipped_at)
      VALUES ($1, $2, $3, $4)
      `,
      [orderId, carrier, tracking_number, shipped_at]
    );

    // 2️⃣ Auto-update order status
    await pool.query(
      `
      UPDATE orders
      SET status = 'Shipped'
      WHERE id = $1
      `,
      [orderId]
    );

    return reply.send({
      success: true,
      message: "Shipment created and order marked as Shipped",
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to create shipment" });
  }
});

// ==============================
// PACKING SLIP (Single Order)
// ==============================
app.get("/orders/:orderId/packing-slip", async (request, reply) => {
  const { orderId } = request.params;

  try {
    // Order + customer info
    const orderResult = await pool.query(
      `
      SELECT
        o.id,
        o.order_number,
        o.order_date,
        o.customer_name,
        o.recipient_name,
        o.status
      FROM orders o
      WHERE o.id = $1
      `,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return reply.code(404).send({ error: "Order not found" });
    }

    // Order items
    const itemsResult = await pool.query(
      `
      SELECT
        oi.sku,
        oi.product_name,
        oi.quantity
      FROM order_items oi
      WHERE oi.order_id = $1
      ORDER BY oi.product_name
      `,
      [orderId]
    );

    // Shipment (if exists)
    const shipmentResult = await pool.query(
      `
      SELECT
        carrier,
        tracking_number,
        shipped_at
      FROM shipments
      WHERE order_id = $1
      ORDER BY shipped_at DESC
      LIMIT 1
      `,
      [orderId]
    );

    return reply.send({
      packing_slip: {
        order: orderResult.rows[0],
        items: itemsResult.rows,
        shipment: shipmentResult.rows[0] || null,
      },
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to generate packing slip" });
  }
});

// ==============================
// BATCH PACKING SLIPS
// ==============================
app.get("/batches/:batchId/packing-slips", async (request, reply) => {
  const { batchId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        b.id AS batch_id,
        b.name AS batch_name,
        o.id AS order_id,
        o.order_number,
        o.order_date,
        o.customer_name,
        o.recipient_name,
        o.order_total,
        o.status,
        oi.sku,
        oi.product_name,
        oi.quantity
      FROM batches b
      JOIN orders o ON o.batch_id = b.id
      JOIN order_items oi ON oi.order_id = o.id
      WHERE b.id = $1
      ORDER BY o.id, oi.product_name;
      `,
      [batchId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: "Batch not found or empty" });
    }

    // Group rows into packing slips
    const packingSlips = {};

    for (const row of result.rows) {
      if (!packingSlips[row.order_id]) {
        packingSlips[row.order_id] = {
          order_id: row.order_id,
          order_number: row.order_number,
          order_date: row.order_date,
          customer_name: row.customer_name,
          recipient_name: row.recipient_name,
          order_total: row.order_total,
          status: row.status,
          batch_name: row.batch_name,
          items: [],
        };
      }

      packingSlips[row.order_id].items.push({
        sku: row.sku,
        product_name: row.product_name,
        quantity: row.quantity,
      });
    }

    return reply.send({
      batch_id: batchId,
      batch_name: result.rows[0].batch_name,
      packing_slips: Object.values(packingSlips),
    });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to generate batch packing slips" });
  }
});

// ==============================
// ORDER PACKING SLIP (PDF)
// ==============================
import PDFDocument from "pdfkit";

app.get("/orders/:orderId/packing-slip/pdf", async (request, reply) => {
  const { orderId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        o.order_number,
        o.customer_name,
        o.recipient_name,
        oi.product_name,
        oi.quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.id = $1
      `,
      [orderId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: "No items found for this order" });
    }

    // Create PDF
    const doc = new PDFDocument({ margin: 40 });

    reply.header("Content-Type", "application/pdf");
    reply.header(
      "Content-Disposition",
      `attachment; filename=packing-slip-${orderId}.pdf`
    );

    doc.pipe(reply.raw);

    // Header
    doc.fontSize(18).text("Packing Slip", { underline: true });
    doc.moveDown();

    const order = result.rows[0];

    doc.fontSize(12);
    doc.text(`Order #: ${order.order_number}`);
    doc.text(`Customer: ${order.customer_name}`);
    doc.text(`Ship To: ${order.recipient_name}`);
    doc.moveDown();

    doc.text("Items:");
    doc.moveDown();

    result.rows.forEach(item => {
      doc.text(`${item.product_name} — Qty: ${item.quantity}`);
    });

    doc.end();
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to generate PDF packing slip" });
  }
});




// Start server
app.listen({
  port: process.env.PORT || 3000,
  host: "0.0.0.0",
});


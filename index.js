import Fastify from "fastify";
import pkg from "pg";
import bwipjs from "bwip-js";
import EasyPost from '@easypost/api';
import crypto from "crypto";
import fetch from "node-fetch";




const { Pool } = pkg;

const app = Fastify({ logger: true });

const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

// Initialize EasyPost for shipping labels
// Initialize EasyPost (API key required)
const easypost = process.env.EASYPOST_API_KEY 
  ? new EasyPost(process.env.EASYPOST_API_KEY)
  : null;
// Health check
app.get("/health", async () => {
  const result = await pool.query("SELECT 1");
  return {
    status: "ok",
    database: result.rowCount === 1,
  };
});

// ==============================
// SHOPIFY APP HOME PAGE
// ==============================
app.get("/", async (request, reply) => {
  const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Fulfillment Backend</title>
  <script src="https://cdn.shopify.com/shopifycloud/app-bridge.js"></script>
  <style>
    body {
      font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
      max-width: 800px;
      margin: 50px auto;
      padding: 20px;
    }
    .card {
      background: white;
      padding: 30px;
      border-radius: 8px;
      box-shadow: 0 2px 10px rgba(0,0,0,0.1);
    }
    .status { color: #28a745; font-weight: bold; }
    #token { 
      background: #f0f0f0; 
      padding: 15px; 
      border-radius: 4px; 
      font-family: monospace; 
      word-break: break-all;
      margin: 20px 0;
    }
    button {
      background: #5c6ac4;
      color: white;
      border: none;
      padding: 12px 24px;
      border-radius: 4px;
      cursor: pointer;
      font-size: 14px;
    }
    button:hover {
      background: #4a5aad;
    }
  </style>
</head>
<body>
  <div class="card">
    <h1>Fulfillment Backend</h1>
    <p class="status">Server is running!</p>
    
    <h2>Get Your Access Token:</h2>
    <button onclick="getToken()">Generate Access Token</button>
    
    <div id="token" style="display:none;">
      <strong>Your Access Token:</strong><br>
      <span id="tokenValue"></span>
      <br><br>
      <small>Copy this and add it to Railway as SHOPIFY_ACCESS_TOKEN</small>
    </div>
    
    <div id="error" style="color: red; margin-top: 20px;"></div>
  </div>
  
  <script>
    const urlParams = new URLSearchParams(window.location.search);
    const host = urlParams.get('host');
    const shop = urlParams.get('shop');
    
    async function getToken() {
      try {
        if (!host) {
          document.getElementById('error').textContent = 'Not loaded from Shopify. Open this from your Shopify admin.';
          return;
        }
        
        // Initialize App Bridge
        const app = window['app-bridge'].createApp({
          apiKey: '${process.env.SHOPIFY_CLIENT_ID}',
          host: host
        });
        
        // Get session token
        const sessionToken = await window['app-bridge-utils'].getSessionToken(app);
        
        document.getElementById('token').style.display = 'block';
        document.getElementById('tokenValue').textContent = sessionToken;
        
        // Also send to backend to exchange for permanent token
        const response = await fetch('/shopify/exchange-token', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer ' + sessionToken
          },
          body: JSON.stringify({ shop: shop })
        });
        
        const data = await response.json();
        if (data.access_token) {
          document.getElementById('tokenValue').textContent = data.access_token;
        }
        
      } catch (error) {
        document.getElementById('error').textContent = 'Error: ' + error.message;
      }
    }
  </script>
</body>
</html>
  `;
  
  reply.header("Content-Type", "text/html");
  return reply.send(html);
});

// Exchange session token for permanent access token
app.post("/shopify/exchange-token", async (request, reply) => {
  const authHeader = request.headers.authorization;
  const sessionToken = authHeader?.replace('Bearer ', '');
  
  if (!sessionToken) {
    return reply.code(401).send({ error: 'No session token provided' });
  }
  
  // For now, just return the session token
  // In production, you'd verify this token and exchange it
  return reply.send({ 
    session_token: sessionToken,
    message: "Use the Custom App method to get a permanent token - session tokens expire quickly"
  });
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
      reply.code(404);
      return { error: "No items found for this order" };
    }

    // IMPORTANT: tell Fastify we handle the response manually
    reply.raw.setHeader("Content-Type", "application/pdf");
    reply.raw.setHeader(
      "Content-Disposition",
      `attachment; filename=packing-slip-${orderId}.pdf`
    );

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(reply.raw);

    // ===== PDF CONTENT =====
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

    return reply; // 🔑 THIS LINE MATTERS
  } catch (err) {
    request.log.error(err);
    reply.code(500);
    return { error: "Failed to generate PDF packing slip" };
  }
});

// ==============================
// BATCH PACKING SLIPS (PDF)
// ==============================

app.get("/batches/:batchId/packing-slips/pdf", async (request, reply) => {
  const { batchId } = request.params;

  try {
    // 1. Get all orders + items in this batch
    const result = await pool.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        o.customer_name,
        o.recipient_name,
        oi.product_name,
        oi.quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id = $1
      ORDER BY o.id, oi.product_name
      `,
      [batchId]
    );

    if (result.rows.length === 0) {
      reply.code(404);
      return { error: "No orders found for this batch" };
    }

    // 2. Prepare PDF response
    reply.raw.setHeader("Content-Type", "application/pdf");
    reply.raw.setHeader(
      "Content-Disposition",
      `attachment; filename=batch-${batchId}-packing-slips.pdf`
    );

    const doc = new PDFDocument({ margin: 40 });
    doc.pipe(reply.raw);

    // 3. Group rows by order
    const ordersMap = {};
    result.rows.forEach(row => {
      if (!ordersMap[row.order_id]) {
        ordersMap[row.order_id] = {
          order_number: row.order_number,
          customer_name: row.customer_name,
          recipient_name: row.recipient_name,
          items: []
        };
      }

      ordersMap[row.order_id].items.push({
        product_name: row.product_name,
        quantity: row.quantity
      });
    });

    const orders = Object.values(ordersMap);

    // 4. Render each order as a page
    orders.forEach((order, index) => {
      if (index > 0) doc.addPage();

      doc.fontSize(18).text("Packing Slip", { underline: true });
      doc.moveDown();

      doc.fontSize(12);
      doc.text(`Order #: ${order.order_number}`);
      doc.text(`Customer: ${order.customer_name}`);
      doc.text(`Ship To: ${order.recipient_name}`);
      doc.moveDown();

      doc.text("Items:");
      doc.moveDown();

      order.items.forEach(item => {
        doc.text(`${item.product_name} — Qty: ${item.quantity}`);
      });
    });

    doc.end();
    return reply;
  } catch (err) {
    request.log.error(err);
    reply.code(500);
    return { error: "Failed to generate batch packing slips PDF" };
  }
});

// ==============================
// THERMAL PICK LIST (4x6) + BARCODE
// ==============================
app.get("/batches/:batchId/pick-list/thermal", async (request, reply) => {
  const { batchId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        o.id AS order_id,
        o.order_number,
        oi.product_name,
        oi.quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id = $1
      ORDER BY o.id
      `,
      [batchId]
    );

    if (result.rows.length === 0) {
      reply.code(404);
      return { error: "No orders found for this batch" };
    }

    reply.raw.setHeader("Content-Type", "application/pdf");
    reply.raw.setHeader(
      "Content-Disposition",
      `attachment; filename=batch-${batchId}-pick-list.pdf`
    );

    const doc = new PDFDocument({
      size: [288, 432], // 4x6
      margin: 12
    });

    doc.pipe(reply.raw);

    let currentOrder = null;

    for (const row of result.rows) {
      if (currentOrder !== row.order_id) {
        if (currentOrder !== null) {
          doc.addPage();
        }

        currentOrder = row.order_id;

        // ===== ORDER HEADER =====
        doc.fontSize(14).text("PICK LIST", { align: "center" });
        doc.moveDown(0.3);

        doc.fontSize(10).text(`Order #: ${row.order_number}`);
        doc.moveDown(0.3);

        // ===== BARCODE =====
        const barcodeBuffer = await bwipjs.toBuffer({
          bcid: "code128",
          text: String(row.order_number),
          scale: 2,
          height: 10,
          includetext: false
        });

        doc.image(barcodeBuffer, {
          fit: [200, 50],
          align: "center"
        });

        doc.moveDown(0.5);
        doc.moveTo(12, doc.y).lineTo(276, doc.y).stroke();
        doc.moveDown(0.3);

        doc.fontSize(10).text("ITEMS:");
        doc.moveDown(0.2);
      }

      // ===== ITEM LINE =====
      doc.fontSize(9).text(
        `• ${row.product_name}  (Qty: ${row.quantity})`
      );
    }

    doc.end();
    return reply;

  } catch (err) {
    request.log.error(err);
    reply.code(500);
    return { error: "Failed to generate thermal pick list" };
  }
});


// ==============================
// THERMAL ORDER PACKING SLIP
// ==============================
app.get("/orders/:orderId/packing-slip/thermal", async (request, reply) => {
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
      ORDER BY oi.product_name
      `,
      [orderId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send("Order not found");
    }

    // Build thermal text
    let output = "";
    output += "1921 MOVEMENT\n";
    output += "--------------------------\n";
    output += `ORDER #: ${result.rows[0].order_number}\n`;
    output += `CUSTOMER: ${result.rows[0].customer_name}\n`;
    output += `SHIP TO: ${result.rows[0].recipient_name}\n`;
    output += "--------------------------\n";
    output += "ITEMS:\n";

    result.rows.forEach(item => {
      output += `${item.quantity} x ${item.product_name}\n`;
    });

    output += "--------------------------\n";
    output += "PACKED BY: ________\n";
    output += "DATE: ____________\n\n\n";

    reply.header("Content-Type", "text/plain");
    return reply.send(output);

  } catch (err) {
    request.log.error(err);
    return reply.code(500).send("Failed to generate thermal packing slip");
  }
});

// ==============================
// AUTO-PRINT BATCH PICK LIST
// ==============================
app.get("/print/batches/:batchId/pick-list", async (request, reply) => {
  const { batchId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        oi.product_name,
        SUM(oi.quantity) AS total_quantity
      FROM orders o
      JOIN order_items oi ON oi.order_id = o.id
      WHERE o.batch_id = $1
      GROUP BY oi.product_name
      ORDER BY oi.product_name
      `,
      [batchId]
    );

    if (result.rows.length === 0) {
      reply.code(404);
      return "No items found for this batch";
    }

    reply.header("Content-Type", "text/plain");
    reply.header("X-Auto-Print", "true");

    let output = "";
    output += "BATCH PICK LIST\n";
    output += `Batch ID: ${batchId}\n`;
    output += "--------------------\n\n";

    result.rows.forEach(item => {
      output += `${item.product_name}\n`;
      output += `QTY: ${item.total_quantity}\n\n`;
    });

    return output;
  } catch (err) {
    request.log.error(err);
    reply.code(500);
    return "Failed to auto-print pick list";
  }
});

// ==============================
// SHIPPING LABEL PURCHASE SYSTEM
// ==============================

app.post("/shipping/create-label", async (request, reply) => {
  const { orderId } = request.body;

  try {
    const orderResult = await pool.query(
      `SELECT * FROM orders WHERE id = $1`,
      [orderId]
    );

    if (orderResult.rows.length === 0) {
      return reply.code(404).send({ error: "Order not found" });
    }

    return reply.send({ 
      success: true, 
      message: "Shipping endpoint is working! EasyPost ready.",
      order: orderResult.rows[0]
    });

  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to create label" });
  }
});

// ==============================
// SHIPPING MANIFEST / SCAN FORM SYSTEM
// ==============================

app.post("/manifests/create", async (request, reply) => {
  const { batchId } = request.body;

  try {
    // Get all shipments in the batch
    const shipmentsResult = await pool.query(
      `
      SELECT
        s.id,
        s.tracking_number,
        s.carrier
      FROM shipments s
      JOIN orders o ON s.order_id = o.id
      WHERE o.batch_id = $1
        AND s.tracking_number IS NOT NULL
      ORDER BY s.id
      `,
      [batchId]
    );

    if (shipmentsResult.rows.length === 0) {
      return reply.code(404).send({ error: "No shipments found in batch" });
    }

    const shipments = shipmentsResult.rows;
    const trackingNumbers = shipments.map(s => s.tracking_number);
    const carrier = shipments[0].carrier;

    // For now, create a simple manifest without EasyPost
    // When you get EasyPost key, we'll add SCAN form generation
    const manifestResult = await pool.query(
      `
      INSERT INTO shipping_manifests 
        (batch_id, carrier, tracking_codes, shipment_count)
      VALUES ($1, $2, $3, $4)
      RETURNING *
      `,
      [batchId, carrier, trackingNumbers, trackingNumbers.length]
    );

    const manifest = manifestResult.rows[0];

    return reply.send({
      success: true,
      manifest,
      print_url: `/manifests/${manifest.id}/print`,
      shipment_count: trackingNumbers.length
    });

  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to create manifest" });
  }
});

// ==============================
// PRINT MANIFEST
// ==============================
app.get("/manifests/:manifestId/print", async (request, reply) => {
  const { manifestId } = request.params;

  try {
    const result = await pool.query(
      `
      SELECT
        m.*,
        b.name AS batch_name
      FROM shipping_manifests m
      LEFT JOIN batches b ON m.batch_id = b.id
      WHERE m.id = $1
      `,
      [manifestId]
    );

    if (result.rows.length === 0) {
      return reply.code(404).send({ error: "Manifest not found" });
    }

    const manifest = result.rows[0];

    const html = `
<!DOCTYPE html>
<html>
<head>
  <title>Shipping Manifest - ${manifest.id}</title>
  <style>
    @page {
      size: 4in 6in;
      margin: 0.2in;
    }
    @media print {
      body { margin: 0; }
      .no-print { display: none; }
    }
    body {
      font-family: Arial, sans-serif;
      width: 4in;
      margin: 0 auto;
      padding: 0.3in;
    }
    h1 {
      font-size: 18pt;
      text-align: center;
      margin: 0 0 10px 0;
      border-bottom: 2px solid #000;
      padding-bottom: 5px;
    }
    .info {
      font-size: 11pt;
      margin: 8px 0;
    }
    .label {
      font-weight: bold;
      display: inline-block;
      width: 100px;
    }
    .shipments {
      margin-top: 15px;
      font-size: 9pt;
      border-top: 1px solid #000;
      padding-top: 8px;
    }
    .shipments h2 {
      font-size: 10pt;
      margin: 5px 0;
    }
    button {
      position: fixed;
      top: 10px;
      right: 10px;
      padding: 10px 20px;
      background: #28a745;
      color: white;
      border: none;
      border-radius: 5px;
      cursor: pointer;
      font-size: 14pt;
    }
  </style>
  <script>
    window.onload = function() {
      setTimeout(function() {
        window.print();
      }, 500);
    };
  </script>
</head>
<body>
  <button class="no-print" onclick="window.print()">🖨️ Print</button>
  
  <h1>SHIPPING MANIFEST</h1>
  
  <div class="info">
    <span class="label">Manifest ID:</span> ${manifest.id}
  </div>
  <div class="info">
    <span class="label">Date:</span> ${new Date(manifest.manifest_date).toLocaleDateString()}
  </div>
  <div class="info">
    <span class="label">Carrier:</span> ${manifest.carrier}
  </div>
  ${manifest.batch_name ? `
    <div class="info">
      <span class="label">Batch:</span> ${manifest.batch_name}
    </div>
  ` : ''}
  <div class="info">
    <span class="label">Packages:</span> ${manifest.shipment_count}
  </div>
  
  <div class="shipments">
    <h2>Tracking Numbers (${manifest.tracking_codes.length})</h2>
    ${manifest.tracking_codes.map(code => `
      <div>${code}</div>
    `).join('')}
  </div>
</body>
</html>
    `;

    reply.header("Content-Type", "text/html");
    return reply.send(html);

  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to print manifest" });
  }
});

// ==============================
// GET ALL MANIFESTS
// ==============================
app.get("/manifests", async (request, reply) => {
  try {
    const result = await pool.query(
      `
      SELECT
        m.*,
        b.name AS batch_name
      FROM shipping_manifests m
      LEFT JOIN batches b ON m.batch_id = b.id
      ORDER BY m.created_at DESC
      `
    );
    return reply.send({ manifests: result.rows });
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to fetch manifests" });
  }
});

// ==============================
// SHOPIFY INTEGRATION (Using API Key & Secret)
// ==============================

async function makeShopifyRequest(endpoint, method = 'GET', body = null) {
  const shop = process.env.SHOPIFY_SHOP_DOMAIN;
  const apiKey = process.env.SHOPIFY_CLIENT_ID;
  const apiSecret = process.env.SHOPIFY_API_SECRET;
  
  const auth = Buffer.from(`${apiKey}:${apiSecret}`).toString('base64');
  
  const options = {
    method,
    headers: {
      'Authorization': `Basic ${auth}`,
      'Content-Type': 'application/json'
    }
  };
  
  if (body) {
    options.body = JSON.stringify(body);
  }
  
  const response = await fetch(`https://${shop}/admin/api/2024-01/${endpoint}`, options);
  return response.json();
}

// Sync orders from Shopify
app.post("/shopify/sync-orders", async (request, reply) => {
  try {
    const data = await makeShopifyRequest('orders.json?status=open&fulfillment_status=unfulfilled&limit=250');
    
    if (!data.orders) {
      return reply.code(500).send({ error: "Failed to fetch orders", details: data });
    }
    
    const imported = [];
    const errors = [];
    
    for (const shopifyOrder of data.orders) {
      try {
        const existing = await pool.query(
          `SELECT id FROM orders WHERE order_number = $1`,
          [String(shopifyOrder.order_number)]
        );
        
        if (existing.rows.length > 0) continue;
        
        const shipping = shopifyOrder.shipping_address || {};
        const customer = shopifyOrder.customer || {};
        
        const orderResult = await pool.query(
          `
          INSERT INTO orders (
            order_number, order_date, customer_name, recipient_name,
            recipient_address, recipient_city, recipient_state, recipient_zip,
            recipient_phone, order_total, status, shopify_order_id
          ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
          RETURNING id
          `,
          [
            String(shopifyOrder.order_number),
            shopifyOrder.created_at,
            `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            shipping.name || `${customer.first_name || ''} ${customer.last_name || ''}`.trim(),
            shipping.address1 || '',
            shipping.city || '',
            shipping.province_code || '',
            shipping.zip || '',
            shipping.phone || customer.phone || '',
            shopifyOrder.total_price,
            'Pending',
            String(shopifyOrder.id)
          ]
        );
        
        const orderId = orderResult.rows[0].id;
        
        for (const item of shopifyOrder.line_items) {
          await pool.query(
            `INSERT INTO order_items (order_id, sku, product_name, quantity, price)
             VALUES ($1, $2, $3, $4, $5)`,
            [orderId, item.sku || String(item.variant_id), item.name, item.quantity, item.price]
          );
        }
        
        imported.push(shopifyOrder.order_number);
        
      } catch (err) {
        errors.push({ order: shopifyOrder.order_number, error: err.message });
      }
    }
    
    return reply.send({
      success: true,
      imported: imported.length,
      failed: errors.length,
      orders: imported,
      errors
    });
    
  } catch (err) {
    request.log.error(err);
    return reply.code(500).send({ error: "Failed to sync orders", details: err.message });
  }
});

/* -------------------------
   SHOPIFY OAUTH ROUTES
-------------------------- */

app.get("/auth", (req, res) => {
  const shop = req.query.shop;

  if (!shop) {
    return res.status(400).send("Missing shop parameter");
  }

  const state = crypto.randomBytes(16).toString("hex");
  const redirectUri = `${process.env.APP_URL}/auth/callback`;

  const installUrl =
    `https://${shop}/admin/oauth/authorize` +
    `?client_id=${process.env.SHOPIFY_API_KEY}` +
    `&scope=${process.env.SHOPIFY_SCOPES}` +
    `&redirect_uri=${redirectUri}` +
    `&state=${state}`;

  res.redirect(installUrl);
});

app.get("/auth/callback", async (req, res) => {
  const { shop, code } = req.query;

  if (!shop || !code) {
    return res.status(400).send("Missing shop or code");
  }

  try {
    const tokenResponse = await fetch(
      `https://${shop}/admin/oauth/access_token`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          client_id: process.env.SHOPIFY_API_KEY,
          client_secret: process.env.SHOPIFY_API_SECRET,
          code,
        }),
      }
    );

    const tokenData = await tokenResponse.json();
    const accessToken = tokenData.access_token;

    console.log("SHOP:", shop);
    console.log("ACCESS TOKEN:", accessToken);

    res.send("App installed successfully. You can close this window.");
  } catch (err) {
    console.error(err);
    res.status(500).send("OAuth failed");
  }
});


// Start server
app.listen({
  port: process.env.PORT || 3000,
  host: "0.0.0.0",
});


/* ==============================
   TEST ENDPOINT
============================== */
app.get("/test/shop/:shop", async (request, reply) => {
  const { shop } = request.params;
  
  try {
    const shopData = await getShop(shop);
    
    if (!shopData) {
      return reply.code(404).send({ error: "Shop not found" });
    }
    
    return reply.send({
      shop: shopData.shop,
      shop_name: shopData.shop_name,
      email: shopData.email,
      is_active: shopData.is_active,
      installed_at: shopData.installed_at,
      has_token: !!shopData.access_token,
    });
  } catch (error) {
    request.log.error(error);
    return reply.code(500).send({ error: "Failed to retrieve shop" });
  }
});

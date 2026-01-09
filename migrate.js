const pool = require('./db');

async function createShopsTable() {
  const createTableQuery = `
    CREATE TABLE IF NOT EXISTS shops (
      id SERIAL PRIMARY KEY,
      shop VARCHAR(255) UNIQUE NOT NULL,
      access_token TEXT NOT NULL,
      scope TEXT NOT NULL,
      shop_name VARCHAR(255),
      email VARCHAR(255),
      domain VARCHAR(255),
      currency VARCHAR(10),
      timezone VARCHAR(100),
      is_active BOOLEAN DEFAULT TRUE,
      installed_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      last_updated TIMESTAMP DEFAULT CURRENT_TIMESTAMP
    );

    CREATE INDEX IF NOT EXISTS idx_shops_shop ON shops(shop);
    CREATE INDEX IF NOT EXISTS idx_shops_is_active ON shops(is_active);
  `;

  try {
    console.log('🔄 Creating shops table...');
    await pool.query(createTableQuery);
    console.log('✅ Shops table created successfully!');
    process.exit(0);
  } catch (error) {
    console.error('❌ Error creating shops table:', error);
    process.exit(1);
  }
}

createShopsTable();

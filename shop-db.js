const pool = require('./db');
const { encrypt, decrypt } = require('./crypto-utils');

/**
 * Save or update a shop's access token and information
 * @param {Object} shopData - Shop information
 * @returns {Promise<Object>} - Saved shop data
 */
async function saveShop(shopData) {
  const {
    shop,
    accessToken,
    scope,
    shopName,
    email,
    domain,
    currency,
    timezone,
  } = shopData;

  try {
    // Encrypt the access token before storing
    const encryptedToken = encrypt(accessToken);

    const query = `
      INSERT INTO shops (
        shop, 
        access_token, 
        scope, 
        shop_name, 
        email, 
        domain, 
        currency, 
        timezone,
        is_active,
        installed_at,
        last_updated
      )
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, true, NOW(), NOW())
      ON CONFLICT (shop) 
      DO UPDATE SET
        access_token = EXCLUDED.access_token,
        scope = EXCLUDED.scope,
        shop_name = EXCLUDED.shop_name,
        email = EXCLUDED.email,
        domain = EXCLUDED.domain,
        currency = EXCLUDED.currency,
        timezone = EXCLUDED.timezone,
        is_active = true,
        last_updated = NOW()
      RETURNING *;
    `;

    const values = [
      shop,
      encryptedToken,
      scope,
      shopName || null,
      email || null,
      domain || null,
      currency || null,
      timezone || null,
    ];

    const result = await pool.query(query, values);
    console.log(`✅ Shop saved: ${shop}`);
    return result.rows[0];
  } catch (error) {
    console.error('Error saving shop:', error);
    throw error;
  }
}

/**
 * Get shop information by shop domain
 * @param {string} shop - Shop domain (e.g., "my-store.myshopify.com")
 * @returns {Promise<Object|null>} - Shop data with decrypted token
 */
async function getShop(shop) {
  try {
    const query = 'SELECT * FROM shops WHERE shop = $1 AND is_active = true';
    const result = await pool.query(query, [shop]);

    if (result.rows.length === 0) {
      return null;
    }

    const shopData = result.rows[0];

    // Decrypt the access token
    shopData.access_token = decrypt(shopData.access_token);

    return shopData;
  } catch (error) {
    console.error('Error getting shop:', error);
    throw error;
  }
}

/**
 * Get all active shops
 * @returns {Promise<Array>} - Array of shop data
 */
async function getAllActiveShops() {
  try {
    const query = 'SELECT * FROM shops WHERE is_active = true ORDER BY installed_at DESC';
    const result = await pool.query(query);

    // Decrypt access tokens for all shops
    return result.rows.map(shop => ({
      ...shop,
      access_token: decrypt(shop.access_token),
    }));
  } catch (error) {
    console.error('Error getting all shops:', error);
    throw error;
  }
}

/**
 * Mark a shop as inactive (when they uninstall the app)
 * @param {string} shop - Shop domain
 * @returns {Promise<Object>} - Updated shop data
 */
async function deactivateShop(shop) {
  try {
    const query = `
      UPDATE shops 
      SET is_active = false, last_updated = NOW()
      WHERE shop = $1
      RETURNING *;
    `;
    const result = await pool.query(query, [shop]);
    console.log(`✅ Shop deactivated: ${shop}`);
    return result.rows[0];
  } catch (error) {
    console.error('Error deactivating shop:', error);
    throw error;
  }
}

/**
 * Delete a shop completely (for GDPR compliance)
 * @param {string} shop - Shop domain
 * @returns {Promise<boolean>} - Success status
 */
async function deleteShop(shop) {
  try {
    const query = 'DELETE FROM shops WHERE shop = $1';
    await pool.query(query, [shop]);
    console.log(`✅ Shop deleted: ${shop}`);
    return true;
  } catch (error) {
    console.error('Error deleting shop:', error);
    throw error;
  }
}

module.exports = {
  saveShop,
  getShop,
  getAllActiveShops,
  deactivateShop,
  deleteShop,
};

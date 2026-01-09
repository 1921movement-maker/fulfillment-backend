const crypto = require('crypto');

const ALGORITHM = 'aes-256-gcm';
const SALT = 'shopify-app-salt'; // In production, use env variable

function getKey() {
  if (!process.env.ENCRYPTION_KEY) {
    throw new Error('ENCRYPTION_KEY environment variable is not set');
  }
  return crypto.scryptSync(process.env.ENCRYPTION_KEY, SALT, 32);
}

/**
 * Encrypt sensitive data (like access tokens)
 * @param {string} text - The text to encrypt
 * @returns {string} - Encrypted text in format: iv:authTag:encrypted
 */
function encrypt(text) {
  try {
    const key = getKey();
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
    
    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');
    const authTag = cipher.getAuthTag();
    
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
  } catch (error) {
    console.error('Encryption error:', error);
    throw new Error('Failed to encrypt data');
  }
}

/**
 * Decrypt sensitive data
 * @param {string} encryptedText - The encrypted text in format: iv:authTag:encrypted
 * @returns {string} - Decrypted text
 */
function decrypt(encryptedText) {
  try {
    const key = getKey();
    const [ivHex, authTagHex, encrypted] = encryptedText.split(':');
    
    if (!ivHex || !authTagHex || !encrypted) {
      throw new Error('Invalid encrypted text format');
    }
    
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);
    
    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    
    return decrypted;
  } catch (error) {
    console.error('Decryption error:', error);
    throw new Error('Failed to decrypt data');
  }
}

module.exports = { encrypt, decrypt };

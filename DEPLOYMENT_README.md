# Shopify OAuth Setup - Deployment Instructions

## Files Created

1. **db.js** - PostgreSQL connection pool
2. **crypto-utils.js** - Encryption/decryption functions for access tokens
3. **shop-db.js** - Database operations for shop data
4. **migrate.js** - Database migration script
5. **index-updated.js** - Updated main server file with OAuth

## Step-by-Step Deployment

### 1. Install Required Package

```bash
npm install pg
```

### 2. Add Environment Variables to Railway

Go to your Railway dashboard → fulfillment-backend → Variables tab and add:

```
ENCRYPTION_KEY=<generate using: openssl rand -hex 32>
```

Make sure these exist:
- ✅ SHOPIFY_API_KEY
- ✅ SHOPIFY_API_SECRET
- ✅ SHOPIFY_SCOPES
- ✅ APP_URL
- ✅ DATABASE_URL

### 3. Copy Files to Your Project

Copy these files from the outputs folder to your fulfillment-backend directory:

```bash
# Navigate to your project
cd /path/to/fulfillment-backend

# Copy the new files (they're in the outputs folder I'll provide)
cp path/to/db.js .
cp path/to/crypto-utils.js .
cp path/to/shop-db.js .
cp path/to/migrate.js .

# Replace your index.js with the updated version
cp path/to/index-updated.js index.js
```

### 4. Run Database Migration (locally first to test)

```bash
# Set your DATABASE_URL temporarily
export DATABASE_URL="your-railway-postgres-url"
export ENCRYPTION_KEY="your-generated-key"

# Run migration
node migrate.js
```

You should see: ✅ Shops table created successfully!

### 5. Deploy to Railway

```bash
git add .
git commit -m "Add OAuth with database storage and encryption"
railway up
```

### 6. Update Shopify App Settings

In your Shopify Partner Dashboard → Apps → Your App → Configuration:

Update these URLs with your Railway URL:

- **App URL**: `https://your-app.up.railway.app`
- **Allowed redirection URL(s)**: `https://your-app.up.railway.app/auth/callback`

### 7. Test the OAuth Flow

Install on your test store:
```
https://your-app.up.railway.app/auth?shop=your-test-store.myshopify.com
```

### 8. Verify Installation

Check if the shop was saved:
```
https://your-app.up.railway.app/test/shop/your-test-store.myshopify.com
```

## How It Works

### OAuth Flow:
1. Merchant visits `/auth?shop=store.myshopify.com`
2. Redirected to Shopify for authorization
3. Shopify redirects to `/auth/callback` with code
4. Backend exchanges code for access token
5. Token is **encrypted** and saved to PostgreSQL
6. Shop data is stored for future API calls

### Security Features:
- ✅ HMAC validation (prevents fake requests)
- ✅ State validation (prevents CSRF attacks)
- ✅ Shop domain validation
- ✅ Token encryption (AES-256-GCM)
- ✅ Secure database storage

### Database Schema:
```
shops table:
- id (primary key)
- shop (unique, indexed)
- access_token (encrypted)
- scope
- shop_name
- email
- domain
- currency
- timezone
- is_active (indexed)
- installed_at
- last_updated
```

## Troubleshooting

### Migration fails:
```bash
# Check database connection
railway run node migrate.js
```

### Can't connect to database:
- Verify DATABASE_URL is set in Railway
- Check PostgreSQL service is running

### OAuth fails:
- Check SHOPIFY_API_KEY and SHOPIFY_API_SECRET
- Verify APP_URL matches Railway deployment URL
- Ensure redirect URL is added in Shopify Partner Dashboard

## Next Steps

1. ✅ OAuth working and storing tokens
2. 📝 Add webhooks (app/uninstalled, GDPR)
3. 📝 Create API endpoints that use stored tokens
4. 📝 Add error handling for expired tokens
5. 📝 Set up Redis for state management (production)

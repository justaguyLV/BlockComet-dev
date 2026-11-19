# Game Store (Cloudflare Workers + D1 + R2)

wrangler d1 create game-store        # انسخ database_id إلى wrangler.toml
wrangler r2 bucket create game-store-files
wrangler d1 execute game-store --remote --file=schema.sql
wrangler secret put ADMIN_PASSWORD   # لحذف الألعاب (اختياري)
wrangler deploy

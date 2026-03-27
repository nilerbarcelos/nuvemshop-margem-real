const Database = require("better-sqlite3");
const path = require("path");
const fs = require("fs");

const dbPath =
  process.env.DB_PATH || path.join(process.env.DATA_DIR || "./data", "app.db");
const dbDir = path.dirname(dbPath);

if (!fs.existsSync(dbDir)) {
  fs.mkdirSync(dbDir, { recursive: true });
}

const db = new Database(dbPath);

db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

db.exec(`
  CREATE TABLE IF NOT EXISTS stores (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    nuvemshop_store_id TEXT UNIQUE NOT NULL,
    nuvemshop_access_token TEXT NOT NULL,
    store_name TEXT,
    store_url TEXT,
    contact_email TEXT,
    stock_alert_threshold INTEGER DEFAULT 5,
    weekly_report_enabled INTEGER DEFAULT 1,
    plan TEXT DEFAULT 'trial',
    trial_ends_at DATETIME,
    subscription_active INTEGER DEFAULT 0,
    created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
  );

  CREATE TABLE IF NOT EXISTS product_costs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL,
    nuvemshop_product_id TEXT NOT NULL,
    product_name TEXT,
    cost REAL DEFAULT 0,
    updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    UNIQUE(store_id, nuvemshop_product_id)
  );

  CREATE TABLE IF NOT EXISTS products_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL,
    nuvemshop_product_id TEXT NOT NULL,
    name TEXT,
    price REAL,
    stock INTEGER DEFAULT 0,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    UNIQUE(store_id, nuvemshop_product_id)
  );

  CREATE TABLE IF NOT EXISTS orders_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL,
    nuvemshop_order_id TEXT NOT NULL,
    total REAL,
    shipping_cost REAL DEFAULT 0,
    status TEXT,
    ordered_at DATETIME,
    synced_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE,
    UNIQUE(store_id, nuvemshop_order_id)
  );

  CREATE TABLE IF NOT EXISTS order_items_cache (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL,
    order_id INTEGER NOT NULL,
    nuvemshop_product_id TEXT,
    product_name TEXT,
    quantity INTEGER,
    unit_price REAL,
    FOREIGN KEY (order_id) REFERENCES orders_cache(id) ON DELETE CASCADE
  );

  CREATE TABLE IF NOT EXISTS alerts_sent (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    store_id INTEGER NOT NULL,
    type TEXT NOT NULL,
    reference TEXT,
    sent_at DATETIME DEFAULT CURRENT_TIMESTAMP,
    FOREIGN KEY (store_id) REFERENCES stores(id) ON DELETE CASCADE
  );
`);

module.exports = db;

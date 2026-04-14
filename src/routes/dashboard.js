const express = require("express");
const path = require("path");
const db = require("../db");
const { syncProducts, syncOrders, calcMargin } = require("../services/sync");

const router = express.Router();

function requireAuth(req, res, next) {
  if (!req.session.storeId) return res.redirect("/");
  next();
}

router.get("/", requireAuth, (req, res) => {
  res.sendFile(path.join(__dirname, "../../public/app.html"));
});

router.get("/api/status", requireAuth, (req, res) => {
  const storeId = req.session.storeId;
  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);

  const productCount = db
    .prepare("SELECT COUNT(*) as count FROM products_cache WHERE store_id = ?")
    .get(storeId);
  const lowStockCount = db
    .prepare(
      "SELECT COUNT(*) as count FROM products_cache WHERE store_id = ? AND stock IS NOT NULL AND stock <= ?",
    )
    .get(storeId, store.stock_alert_threshold ?? 5);
  const zeroStockCount = db
    .prepare(
      "SELECT COUNT(*) as count FROM products_cache WHERE store_id = ? AND stock IS NOT NULL AND stock = 0",
    )
    .get(storeId);
  const ordersThisWeek = db
    .prepare(
      `SELECT COUNT(*) as count FROM orders_cache WHERE store_id = ? AND ordered_at >= datetime('now', '-7 days') AND status IN ('paid','packed','shipped','delivered')`,
    )
    .get(storeId);

  const trialDaysLeft = store.trial_ends_at
    ? Math.max(
        0,
        Math.ceil(
          (new Date(store.trial_ends_at) - new Date()) / (1000 * 60 * 60 * 24),
        ),
      )
    : 0;

  res.json({
    store: {
      name: store.store_name,
      url: store.store_url,
      plan: store.plan,
      trialDaysLeft,
      subscriptionActive: !!store.subscription_active,
      contactEmail: store.contact_email || "",
      stockAlertThreshold: store.stock_alert_threshold ?? 5,
      weeklyReportEnabled: !!store.weekly_report_enabled,
    },
    stats: {
      productCount: productCount.count,
      lowStockCount: lowStockCount.count,
      zeroStockCount: zeroStockCount.count,
      ordersThisWeek: ordersThisWeek.count,
    },
  });
});

// Lista produtos com custo e margem calculada
router.get("/api/products", requireAuth, (req, res) => {
  const storeId = req.session.storeId;
  const page = parseInt(req.query.page) || 1;
  const perPage = 30;
  const offset = (page - 1) * perPage;

  const products = db
    .prepare(
      `
    SELECT
      pc.nuvemshop_product_id as id,
      pc.name,
      pc.price,
      pc.stock,
      COALESCE(cost.cost, 0) as cost,
      CASE WHEN pc.price > 0 THEN ROUND(((pc.price - COALESCE(cost.cost, 0)) / pc.price) * 100, 1) ELSE 0 END as margin
    FROM products_cache pc
    LEFT JOIN product_costs cost ON cost.store_id = pc.store_id AND cost.nuvemshop_product_id = pc.nuvemshop_product_id
    WHERE pc.store_id = ?
    ORDER BY pc.stock ASC, pc.name ASC
    LIMIT ? OFFSET ?
  `,
    )
    .all(storeId, perPage, offset);

  const total = db
    .prepare("SELECT COUNT(*) as count FROM products_cache WHERE store_id = ?")
    .get(storeId);
  res.json({ products, total: total.count, page, perPage });
});

// Salva custo de um produto
router.put("/api/products/:productId/cost", requireAuth, (req, res) => {
  const storeId = req.session.storeId;
  const { productId } = req.params;
  const { cost } = req.body;

  if (cost === undefined || isNaN(parseFloat(cost))) {
    return res.status(400).json({ error: "Custo inválido" });
  }

  const product = db
    .prepare(
      "SELECT name FROM products_cache WHERE store_id = ? AND nuvemshop_product_id = ?",
    )
    .get(storeId, productId);
  if (!product)
    return res.status(404).json({ error: "Produto não encontrado" });

  db.prepare(
    `
    INSERT INTO product_costs (store_id, nuvemshop_product_id, product_name, cost, updated_at)
    VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, nuvemshop_product_id) DO UPDATE SET
      cost = excluded.cost,
      updated_at = CURRENT_TIMESTAMP
  `,
  ).run(storeId, productId, product.name, parseFloat(cost));

  res.json({ success: true });
});

// Margem por produto (período)
router.get("/api/margin", requireAuth, (req, res) => {
  const storeId = req.session.storeId;
  const days = parseInt(req.query.days) || 30;
  const products = calcMargin(storeId, days);

  const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
  const totalProfit = products.reduce((s, p) => s + p.profit, 0);
  const overallMargin =
    totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

  res.json({ products, totalRevenue, totalProfit, overallMargin, days });
});

// Sync manual
router.post("/api/sync", requireAuth, async (req, res) => {
  const storeId = req.session.storeId;
  try {
    const [products, orders] = await Promise.all([
      syncProducts(storeId),
      syncOrders(storeId),
    ]);
    res.json({ success: true, products, orders });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Atualiza configurações
router.put("/api/settings", requireAuth, (req, res) => {
  const storeId = req.session.storeId;
  const { contactEmail, stockAlertThreshold, weeklyReportEnabled } = req.body;

  db.prepare(
    `
    UPDATE stores SET
      contact_email = ?,
      stock_alert_threshold = ?,
      weekly_report_enabled = ?,
      updated_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `,
  ).run(
    contactEmail || null,
    parseInt(stockAlertThreshold) || 5,
    weeklyReportEnabled ? 1 : 0,
    storeId,
  );

  res.json({ success: true });
});

module.exports = router;

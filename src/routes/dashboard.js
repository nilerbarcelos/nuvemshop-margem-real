const express = require("express");
const path = require("path");
const db = require("../db");
const { syncProducts, syncOrders, calcMargin } = require("../services/sync");
const { checkAndSendLowStockAlert } = require("../jobs/scheduler");

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

  const lastAlert = db
    .prepare(
      "SELECT MAX(sent_at) as last FROM alerts_sent WHERE store_id = ? AND type IN ('low_stock','low_stock_test')",
    )
    .get(storeId);

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
    alerts: {
      emailProviderConfigured: !!(
        process.env.RESEND_API_KEY || process.env.SMTP_PASS
      ),
      lastLowStockAlertAt: lastAlert?.last || null,
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
router.put("/api/settings", requireAuth, async (req, res) => {
  const storeId = req.session.storeId;
  const { contactEmail, stockAlertThreshold, weeklyReportEnabled } = req.body;

  const parsedThreshold = Number.parseInt(stockAlertThreshold, 10);
  const thresholdValue =
    Number.isFinite(parsedThreshold) && parsedThreshold >= 0
      ? parsedThreshold
      : 5;

  const previous = db
    .prepare("SELECT stock_alert_threshold FROM stores WHERE id = ?")
    .get(storeId);

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
    thresholdValue,
    weeklyReportEnabled ? 1 : 0,
    storeId,
  );

  // Threshold mudou: invalida dedup de 24h para permitir re-disparo
  if (previous && previous.stock_alert_threshold !== thresholdValue) {
    db.prepare(
      "DELETE FROM alerts_sent WHERE store_id = ? AND type = 'low_stock'",
    ).run(storeId);
  }

  // Disparo imediato best-effort se houver produtos abaixo do novo threshold
  let alert = { sent: false, reason: "skipped" };
  if (contactEmail) {
    try {
      const store = db
        .prepare("SELECT * FROM stores WHERE id = ?")
        .get(storeId);
      alert = await checkAndSendLowStockAlert(store);
      if (alert.sent) {
        console.log(
          `[alert] Estoque crítico enviado pós-settings loja ${storeId}`,
        );
      }
    } catch (err) {
      console.error(`[alert] Erro pós-settings loja ${storeId}:`, err.message);
      alert = { sent: false, reason: "send_failed" };
    }
  }

  res.json({ success: true, alert });
});

// Envia alerta de teste imediato
router.post("/api/alerts/test", requireAuth, async (req, res) => {
  const storeId = req.session.storeId;
  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);

  if (!store?.contact_email) {
    return res.status(400).json({ sent: false, reason: "no_email" });
  }
  if (!process.env.RESEND_API_KEY && !process.env.SMTP_PASS) {
    return res
      .status(500)
      .json({ sent: false, reason: "email_not_configured" });
  }

  try {
    const result = await checkAndSendLowStockAlert(store, {
      force: true,
      markType: "low_stock_test",
    });
    return res.json(result);
  } catch (err) {
    console.error(
      `[alert] Erro no teste de alerta loja ${storeId}:`,
      err.message,
    );
    return res
      .status(500)
      .json({ sent: false, reason: "send_failed", message: err.message });
  }
});

module.exports = router;

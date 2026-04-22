const cron = require("node-cron");
const db = require("../db");
const { syncProducts, syncOrders } = require("../services/sync");
const { sendStockAlert, sendWeeklyReport } = require("../services/mailer");
const { calcMargin } = require("../services/sync");

function getActiveStores() {
  return db.prepare("SELECT * FROM stores WHERE subscription_active = 1").all();
}

function queryLowStock(storeId, threshold) {
  return db
    .prepare(
      `
      SELECT name, stock FROM products_cache
      WHERE store_id = ? AND stock IS NOT NULL AND stock <= ?
      ORDER BY stock ASC
    `,
    )
    .all(storeId, threshold);
}

async function checkAndSendLowStockAlert(
  store,
  { force = false, markType = "low_stock" } = {},
) {
  if (!store?.contact_email) {
    return { sent: false, reason: "no_email" };
  }
  if (!process.env.RESEND_API_KEY && !process.env.SMTP_PASS) {
    return { sent: false, reason: "email_not_configured" };
  }

  const threshold = store.stock_alert_threshold ?? 5;
  const lowStock = queryLowStock(store.id, threshold);
  if (!lowStock.length) {
    return { sent: false, reason: "no_low_stock", threshold };
  }

  const key = lowStock.map((p) => p.name).join(",");

  if (!force) {
    const recent = db
      .prepare(
        `
        SELECT id FROM alerts_sent
        WHERE store_id = ? AND type = 'low_stock' AND reference = ?
        AND sent_at >= datetime('now', '-24 hours')
      `,
      )
      .get(store.id, key);
    if (recent) {
      return { sent: false, reason: "recently_sent", threshold };
    }
  }

  await sendStockAlert(store.contact_email, store.store_name, lowStock);
  db.prepare(
    "INSERT INTO alerts_sent (store_id, type, reference) VALUES (?, ?, ?)",
  ).run(store.id, markType, key);

  return {
    sent: true,
    count: lowStock.length,
    email: store.contact_email,
    threshold,
  };
}

function startScheduler() {
  // Sync de produtos e pedidos a cada hora
  cron.schedule("0 * * * *", async () => {
    const stores = getActiveStores();
    for (const store of stores) {
      try {
        await syncProducts(store.id);
        await syncOrders(store.id);
      } catch (err) {
        console.error(`[sync] Erro loja ${store.id}:`, err.message);
      }
    }
  });

  // Alerta de estoque crítico — a cada 2 horas
  cron.schedule("0 */2 * * *", async () => {
    const stores = getActiveStores();
    for (const store of stores) {
      try {
        const result = await checkAndSendLowStockAlert(store);
        if (result.sent) {
          console.log(`[alert] Estoque crítico enviado para loja ${store.id}`);
        }
      } catch (err) {
        console.error(
          `[alert] Erro ao enviar email loja ${store.id}:`,
          err.message,
        );
      }
    }
  });

  // Relatório semanal — toda segunda às 8h
  cron.schedule("0 8 * * 1", async () => {
    const stores = getActiveStores();
    for (const store of stores) {
      if (!store.contact_email || !store.weekly_report_enabled) continue;

      try {
        const products = calcMargin(store.id, 7);
        if (!products.length) continue;

        const totalRevenue = products.reduce((s, p) => s + p.revenue, 0);
        const totalCost = products.reduce((s, p) => s + p.total_cost, 0);
        const totalProfit = totalRevenue - totalCost;
        const margin =
          totalRevenue > 0 ? (totalProfit / totalRevenue) * 100 : 0;

        const ordersCount = db
          .prepare(
            `
          SELECT COUNT(*) as count FROM orders_cache
          WHERE store_id = ? AND ordered_at >= datetime('now', '-7 days')
          AND status IN ('paid','packed','shipped','delivered')
        `,
          )
          .get(store.id).count;

        await sendWeeklyReport(store.contact_email, store.store_name, {
          totalRevenue,
          totalCost,
          totalProfit,
          margin,
          ordersCount,
          topProducts: products.slice(0, 5),
        });
        console.log(`[report] Relatório semanal enviado para loja ${store.id}`);
      } catch (err) {
        console.error(
          `[report] Erro ao enviar relatório loja ${store.id}:`,
          err.message,
        );
      }
    }
  });

  // Limpeza de alerts antigos — diário
  cron.schedule("0 0 * * *", () => {
    db.prepare(
      "DELETE FROM alerts_sent WHERE sent_at < datetime('now', '-30 days')",
    ).run();
  });

  console.log(
    "Scheduler iniciado: sync horário, alertas a cada 2h, relatório semanal às segundas 8h",
  );
}

module.exports = { startScheduler, checkAndSendLowStockAlert };

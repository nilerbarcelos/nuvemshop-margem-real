const db = require("../db");
const NuvemshopClient = require("./nuvemshop");

async function syncProducts(storeId) {
  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);
  if (!store) return;

  const nuvem = new NuvemshopClient(
    store.nuvemshop_access_token,
    store.nuvemshop_store_id,
  );
  const products = await nuvem.getAllProducts();

  const upsert = db.prepare(`
    INSERT INTO products_cache (store_id, nuvemshop_product_id, name, price, stock, synced_at)
    VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, nuvemshop_product_id) DO UPDATE SET
      name = excluded.name,
      price = excluded.price,
      stock = excluded.stock,
      synced_at = CURRENT_TIMESTAMP
  `);

  const syncAll = db.transaction((items) => {
    for (const p of items) {
      const name = p.name?.pt || p.name || "Produto";
      const price = parseFloat(p.variants?.[0]?.price || p.price || 0);
      const stock =
        p.variants?.reduce((sum, v) => sum + (v.stock || 0), 0) ?? 0;
      upsert.run(storeId, String(p.id), name, price, stock);
    }
  });

  syncAll(products);
  return products.length;
}

async function syncOrders(storeId) {
  const store = db.prepare("SELECT * FROM stores WHERE id = ?").get(storeId);
  if (!store) return;

  const nuvem = new NuvemshopClient(
    store.nuvemshop_access_token,
    store.nuvemshop_store_id,
  );
  const orders = await nuvem.getOrdersSince(30);

  const upsertOrder = db.prepare(`
    INSERT INTO orders_cache (store_id, nuvemshop_order_id, total, shipping_cost, status, ordered_at, synced_at)
    VALUES (?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
    ON CONFLICT(store_id, nuvemshop_order_id) DO UPDATE SET
      total = excluded.total,
      shipping_cost = excluded.shipping_cost,
      status = excluded.status,
      synced_at = CURRENT_TIMESTAMP
  `);

  const upsertItem = db.prepare(`
    INSERT INTO order_items_cache (store_id, order_id, nuvemshop_product_id, product_name, quantity, unit_price)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const deleteItems = db.prepare(
    "DELETE FROM order_items_cache WHERE order_id = ?",
  );

  const syncAll = db.transaction((items) => {
    for (const o of items) {
      // só considera pedidos pagos
      if (
        !["paid", "packed", "shipped", "delivered"].includes(o.payment_status)
      )
        continue;

      const shippingCost = parseFloat(o.shipping_cost_owner || o.shipping || 0);
      upsertOrder.run(
        storeId,
        String(o.id),
        parseFloat(o.total || 0),
        shippingCost,
        o.payment_status,
        o.created_at,
      );

      const saved = db
        .prepare(
          "SELECT id FROM orders_cache WHERE store_id = ? AND nuvemshop_order_id = ?",
        )
        .get(storeId, String(o.id));
      if (!saved) continue;

      deleteItems.run(saved.id);
      for (const item of o.products || []) {
        upsertItem.run(
          storeId,
          saved.id,
          String(item.product_id),
          item.name,
          item.quantity,
          parseFloat(item.price || 0),
        );
      }
    }
  });

  syncAll(orders);
  return orders.length;
}

function calcMargin(storeId, days = 30) {
  const since = new Date();
  since.setDate(since.getDate() - days);
  const sinceStr = since.toISOString();

  const rows = db
    .prepare(
      `
    SELECT
      oi.nuvemshop_product_id as product_id,
      oi.product_name as name,
      SUM(oi.quantity * oi.unit_price) as revenue,
      SUM(oi.quantity) as units_sold,
      COALESCE(pc.cost, 0) as cost_per_unit
    FROM order_items_cache oi
    JOIN orders_cache o ON o.id = oi.order_id
    LEFT JOIN product_costs pc ON pc.store_id = oi.store_id AND pc.nuvemshop_product_id = oi.nuvemshop_product_id
    WHERE oi.store_id = ? AND o.ordered_at >= ? AND o.status IN ('paid','packed','shipped','delivered')
    GROUP BY oi.nuvemshop_product_id
    ORDER BY revenue DESC
  `,
    )
    .all(storeId, sinceStr);

  return rows.map((r) => {
    const totalCost = r.cost_per_unit * r.units_sold;
    const profit = r.revenue - totalCost;
    const margin = r.revenue > 0 ? (profit / r.revenue) * 100 : 0;
    return { ...r, total_cost: totalCost, profit, margin };
  });
}

module.exports = { syncProducts, syncOrders, calcMargin };

const express = require("express");
const crypto = require("crypto");
const db = require("../db");
const NuvemshopClient = require("../services/nuvemshop");
const { syncProducts, syncOrders } = require("../services/sync");

const router = express.Router();

router.get("/install", (req, res) => {
  const state = crypto.randomBytes(16).toString("hex");
  req.session.oauthState = state;
  const authUrl = NuvemshopClient.getAuthUrl(
    process.env.NUVEMSHOP_CLIENT_ID,
    process.env.NUVEMSHOP_REDIRECT_URI,
    state,
  );
  res.redirect(authUrl);
});

router.get("/callback", async (req, res) => {
  const { code } = req.query;
  if (!code) return res.status(400).send("Código de autorização ausente");

  try {
    const tokenData = await NuvemshopClient.exchangeCodeForToken(
      code,
      process.env.NUVEMSHOP_CLIENT_ID,
      process.env.NUVEMSHOP_CLIENT_SECRET,
    );

    const { access_token, user_id: storeId } = tokenData;
    const nuvem = new NuvemshopClient(access_token, storeId);
    const storeInfo = await nuvem.getStore();

    const trialEndsAt = new Date();
    trialEndsAt.setDate(trialEndsAt.getDate() + 14);

    db.prepare(
      `
      INSERT INTO stores (nuvemshop_store_id, nuvemshop_access_token, store_name, store_url, plan, trial_ends_at, subscription_active)
      VALUES (?, ?, ?, ?, 'trial', ?, 1)
      ON CONFLICT(nuvemshop_store_id) DO UPDATE SET
        nuvemshop_access_token = excluded.nuvemshop_access_token,
        store_name = excluded.store_name,
        updated_at = CURRENT_TIMESTAMP
    `,
    ).run(
      String(storeId),
      access_token,
      storeInfo.name?.pt || storeInfo.name || "Minha Loja",
      storeInfo.original_domain || "",
      trialEndsAt.toISOString(),
    );

    const store = db
      .prepare("SELECT * FROM stores WHERE nuvemshop_store_id = ?")
      .get(String(storeId));
    req.session.storeId = store.id;

    // Sync inicial em background
    syncProducts(store.id).catch(() => {});
    syncOrders(store.id).catch(() => {});

    res.redirect("/dashboard");
  } catch (err) {
    console.error("Erro no callback OAuth:", err.message);
    res.status(500).send("Erro ao autenticar. Tente novamente.");
  }
});

module.exports = router;

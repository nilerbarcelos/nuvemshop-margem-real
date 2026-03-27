const express = require("express");
const crypto = require("crypto");
const db = require("../db");

const router = express.Router();

function verifySignature(req) {
  const secret = process.env.NUVEMSHOP_CLIENT_SECRET;
  if (!secret) return true; // dev mode sem secret configurado
  const signature = req.headers["x-linkedstore-hmac-sha256"];
  if (!signature) return false;
  const body = JSON.stringify(req.body);
  const expected = crypto
    .createHmac("sha256", secret)
    .update(body)
    .digest("base64");
  return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
}

// Loja desinstalou o app — apagar todos os dados
router.post("/store-redact", (req, res) => {
  if (!verifySignature(req)) return res.status(401).send("Unauthorized");
  const storeId = req.body?.store_id;
  if (storeId) {
    const store = db
      .prepare("SELECT id FROM stores WHERE nuvemshop_store_id = ?")
      .get(String(storeId));
    if (store) {
      db.prepare("DELETE FROM stores WHERE id = ?").run(store.id);
    }
  }
  res.status(200).send("ok");
});

// Requisição de exclusão de dados de cliente — não armazenamos dados de clientes
router.post("/customers-redact", (req, res) => {
  if (!verifySignature(req)) return res.status(401).send("Unauthorized");
  res.status(200).send("ok");
});

// Requisição de dados de cliente — não armazenamos dados de clientes
router.post("/customers-data-request", (req, res) => {
  if (!verifySignature(req)) return res.status(401).send("Unauthorized");
  res.status(200).json({ customer_data: [] });
});

module.exports = router;

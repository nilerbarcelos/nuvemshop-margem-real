const { Resend } = require("resend");

const FROM = process.env.SMTP_FROM || "Margem Real <onboarding@resend.dev>";

let _resend = null;
function getResend() {
  if (_resend) return _resend;
  const key = process.env.RESEND_API_KEY || process.env.SMTP_PASS;
  if (!key) {
    const err = new Error(
      "Provedor de e-mail não configurado (defina RESEND_API_KEY)",
    );
    err.code = "EMAIL_NOT_CONFIGURED";
    throw err;
  }
  _resend = new Resend(key);
  return _resend;
}

// Resend v6 retorna { data, error } em vez de lançar em erros de API (403,
// 422, domínio não verificado, sandbox etc). Uniformiza lançando exceção
// para que os chamadores tratem pelo catch.
async function sendEmail(payload) {
  const { data, error } = await getResend().emails.send(payload);
  if (error) {
    const err = new Error(
      `Resend recusou o envio: ${error.message || error.name || JSON.stringify(error)}`,
    );
    err.code = "EMAIL_SEND_FAILED";
    err.resendError = error;
    throw err;
  }
  return data;
}

async function sendStockAlert(email, storeName, lowStockProducts) {
  const rows = lowStockProducts
    .map(
      (p) =>
        `<tr>
          <td style="padding:8px;border-bottom:1px solid #eee">${p.name}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:center;color:${p.stock === 0 ? "#e53e3e" : "#dd6b20"}">${p.stock === 0 ? "Zerado" : p.stock + " un."}</td>
        </tr>`,
    )
    .join("");

  await sendEmail({
    from: FROM,
    to: email,
    subject: `⚠️ Alerta de estoque — ${storeName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#010101">Alerta de estoque crítico</h2>
        <p style="color:#555">Os produtos abaixo estão com estoque zerado ou abaixo do mínimo configurado na sua loja <strong>${storeName}</strong>:</p>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px;text-align:left">Produto</th>
              <th style="padding:8px;text-align:center">Estoque</th>
            </tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
        <p style="margin-top:24px;color:#999;font-size:13px">Margem Real — Nuvemshop</p>
      </div>
    `,
  });
}

async function sendWeeklyReport(email, storeName, report) {
  const {
    totalRevenue,
    totalCost,
    totalProfit,
    margin,
    topProducts,
    ordersCount,
  } = report;

  const topRows = topProducts
    .map(
      (p) =>
        `<tr>
          <td style="padding:8px;border-bottom:1px solid #eee">${p.name}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">R$ ${p.revenue.toFixed(2)}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right;color:${p.profit >= 0 ? "#38a169" : "#e53e3e"}">R$ ${p.profit.toFixed(2)}</td>
          <td style="padding:8px;border-bottom:1px solid #eee;text-align:right">${p.margin.toFixed(1)}%</td>
        </tr>`,
    )
    .join("");

  await sendEmail({
    from: FROM,
    to: email,
    subject: `📊 Relatório semanal — ${storeName}`,
    html: `
      <div style="font-family:sans-serif;max-width:600px;margin:0 auto">
        <h2 style="color:#010101">Relatório semanal — ${storeName}</h2>
        <div style="display:flex;gap:16px;margin:24px 0">
          <div style="flex:1;background:#f0fff4;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#38a169">R$ ${totalRevenue.toFixed(2)}</div>
            <div style="color:#555;font-size:13px">Receita</div>
          </div>
          <div style="flex:1;background:#ebf8ff;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#3182ce">R$ ${totalProfit.toFixed(2)}</div>
            <div style="color:#555;font-size:13px">Lucro</div>
          </div>
          <div style="flex:1;background:#fffaf0;border-radius:8px;padding:16px;text-align:center">
            <div style="font-size:22px;font-weight:700;color:#dd6b20">${margin.toFixed(1)}%</div>
            <div style="color:#555;font-size:13px">Margem</div>
          </div>
        </div>
        <p style="color:#555">${ordersCount} pedidos pagos na semana.</p>
        <h3 style="color:#010101">Top produtos por lucro</h3>
        <table style="width:100%;border-collapse:collapse">
          <thead>
            <tr style="background:#f5f5f5">
              <th style="padding:8px;text-align:left">Produto</th>
              <th style="padding:8px;text-align:right">Receita</th>
              <th style="padding:8px;text-align:right">Lucro</th>
              <th style="padding:8px;text-align:right">Margem</th>
            </tr>
          </thead>
          <tbody>${topRows}</tbody>
        </table>
        <p style="margin-top:24px;color:#999;font-size:13px">Margem Real — Nuvemshop</p>
      </div>
    `,
  });
}

module.exports = { sendStockAlert, sendWeeklyReport };

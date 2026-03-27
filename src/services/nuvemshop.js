const axios = require("axios");

const API_VERSION = "2025-03";
const BASE_URL = "https://api.nuvemshop.com.br";
const AUTH_URL = "https://www.tiendanube.com/apps";

class NuvemshopClient {
  constructor(accessToken, storeId) {
    this.accessToken = accessToken;
    this.storeId = storeId;
    this.baseURL = `${BASE_URL}/${API_VERSION}/${storeId}`;
    this.http = axios.create({
      baseURL: this.baseURL,
      headers: {
        Authentication: `bearer ${accessToken}`,
        "Content-Type": "application/json",
        "User-Agent": "NuvemshopMargemReal/1.0",
      },
      timeout: 15000,
    });
  }

  async getStore() {
    const { data } = await this.http.get("/store");
    return data;
  }

  async getProducts({ page = 1, perPage = 50 } = {}) {
    const { data } = await this.http.get("/products", {
      params: { page, per_page: perPage },
    });
    return data;
  }

  async getAllProducts() {
    const products = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const batch = await this.getProducts({ page, perPage: 50 });
      products.push(...batch);
      hasMore = batch.length === 50;
      page++;
    }
    return products;
  }

  async getOrders({ page = 1, perPage = 50, createdAtMin = null } = {}) {
    const params = { page, per_page: perPage };
    if (createdAtMin) params.created_at_min = createdAtMin;
    try {
      const { data } = await this.http.get("/orders", { params });
      return data;
    } catch (err) {
      // Nuvemshop returns 404 when there are no orders ("Last page is 0")
      if (err.response?.status === 404) return [];
      throw err;
    }
  }

  async getOrdersSince(days = 30) {
    const since = new Date();
    since.setDate(since.getDate() - days);
    const orders = [];
    let page = 1;
    let hasMore = true;
    while (hasMore) {
      const batch = await this.getOrders({
        page,
        perPage: 50,
        createdAtMin: since.toISOString(),
      });
      orders.push(...batch);
      hasMore = batch.length === 50;
      page++;
    }
    return orders;
  }

  static async exchangeCodeForToken(code, clientId, clientSecret) {
    const { data } = await axios.post(
      `${AUTH_URL}/authorize/token`,
      {
        client_id: clientId,
        client_secret: clientSecret,
        grant_type: "authorization_code",
        code,
      },
      { headers: { "Content-Type": "application/json" } },
    );
    return data;
  }

  static getAuthUrl(clientId, redirectUri, state = "") {
    const params = new URLSearchParams({ state });
    return `${AUTH_URL}/${clientId}/authorize?${params}`;
  }
}

module.exports = NuvemshopClient;

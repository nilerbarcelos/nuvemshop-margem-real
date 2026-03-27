require("dotenv").config();
const express = require("express");
const session = require("express-session");
const SQLiteStore = require("connect-sqlite3")(session);
const path = require("path");

const authRoutes = require("./routes/auth");
const dashboardRoutes = require("./routes/dashboard");
const webhookRoutes = require("./routes/webhooks");
const { startScheduler } = require("./jobs/scheduler");

const app = express();
const PORT = process.env.PORT || 3000;

app.set("trust proxy", 1);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, "../public")));

app.use(
  session({
    store: new SQLiteStore({
      dir: process.env.DATA_DIR || "./data",
      db: "sessions.db",
    }),
    secret: process.env.SESSION_SECRET || "dev-secret-change-in-production",
    resave: false,
    saveUninitialized: false,
    cookie: {
      secure: process.env.NODE_ENV === "production",
      httpOnly: true,
      maxAge: 30 * 24 * 60 * 60 * 1000,
    },
  }),
);

app.get("/", (req, res) => {
  if (req.session.storeId) return res.redirect("/dashboard");
  res.sendFile(path.join(__dirname, "../public/index.html"));
});

app.use("/auth", authRoutes);
app.use("/dashboard", dashboardRoutes);
app.use("/webhooks", webhookRoutes);

app.get("/privacidade", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/privacidade.html"));
});

app.get("/suporte", (req, res) => {
  res.sendFile(path.join(__dirname, "../public/suporte.html"));
});

app.get("/health", (req, res) => {
  res.json({ status: "ok", timestamp: new Date().toISOString() });
});

app.listen(PORT, () => {
  console.log(`Servidor rodando na porta ${PORT}`);
  startScheduler();
});

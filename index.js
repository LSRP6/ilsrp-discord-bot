// ILSRP Discord OAuth2 Bridge
// Deploy ini ke Railway, lalu isi environment variables:
//   DISCORD_CLIENT_ID      = Client ID dari Discord Developer Portal
//   DISCORD_CLIENT_SECRET  = Client Secret dari Discord Developer Portal
//   REDIRECT_URI           = https://DOMAIN-RAILWAY-KAMU.railway.app/callback
//   MTA_SECRET             = bebas, string rahasia buat verifikasi request dari MTA
//   PORT                   = 3000 (Railway set otomatis)

const express = require("express");
const axios   = require("axios");
const app     = express();

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  REDIRECT_URI,
  MTA_SECRET,
  PORT = 3000,
} = process.env;

// Simpan sesi pending: token sementara → { discordID, username, expires }
// Pakai Map in-memory, cukup untuk kebutuhan ini
const pendingSessions = new Map();

// Bersihkan sesi expired setiap 5 menit
setInterval(() => {
  const now = Date.now();
  for (const [key, val] of pendingSessions.entries()) {
    if (now > val.expires) pendingSessions.delete(key);
  }
}, 5 * 60 * 1000);

// ============================================================
// GET /auth?state=TOKEN_SEMENTARA
// Dipanggil MTA saat player klik "Link Discord"
// MTA generate state token unik, simpan di server MTA,
// lalu buka URL ini di browser player
// ============================================================
app.get("/auth", (req, res) => {
  const state = req.query.state;
  if (!state || state.length < 8) {
    return res.status(400).send(renderPage("Error", "State tidak valid."));
  }

  const url = new URL("https://discord.com/oauth2/authorize");
  url.searchParams.set("client_id",     DISCORD_CLIENT_ID);
  url.searchParams.set("redirect_uri",  REDIRECT_URI);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope",         "identify");
  url.searchParams.set("state",         state);

  res.redirect(url.toString());
});

// ============================================================
// GET /callback?code=XXX&state=TOKEN_SEMENTARA
// Discord redirect ke sini setelah player approve
// ============================================================
app.get("/callback", async (req, res) => {
  const { code, state, error } = req.query;

  if (error) {
    return res.send(renderPage("Dibatalkan", "Kamu membatalkan login Discord.<br>Kembali ke game dan coba lagi."));
  }

  if (!code || !state) {
    return res.status(400).send(renderPage("Error", "Parameter tidak lengkap."));
  }

  try {
    // Tukar code dengan access token
    const tokenRes = await axios.post(
      "https://discord.com/api/oauth2/token",
      new URLSearchParams({
        client_id:     DISCORD_CLIENT_ID,
        client_secret: DISCORD_CLIENT_SECRET,
        grant_type:    "authorization_code",
        code,
        redirect_uri:  REDIRECT_URI,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } }
    );

    const accessToken = tokenRes.data.access_token;

    // Ambil info user Discord
    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const discordID       = userRes.data.id;
    const discordUsername = userRes.data.username;

    // Simpan ke pending sessions (MTA akan poll ini)
    pendingSessions.set(state, {
      discordID,
      discordUsername,
      expires: Date.now() + 10 * 60 * 1000, // 10 menit
    });

    res.send(renderPage(
      "Berhasil! ✅",
      `Akun Discord <b>${discordUsername}</b> berhasil terhubung!<br><br>
       Kembali ke game — akun kamu akan otomatis terdeteksi.<br>
       <small>Kamu bisa tutup tab ini.</small>`
    ));

  } catch (err) {
    console.error("[OAuth] Error:", err?.response?.data || err.message);
    res.status(500).send(renderPage("Error", "Gagal menghubungkan akun Discord. Coba lagi."));
  }
});

// ============================================================
// GET /check?state=TOKEN&secret=MTA_SECRET
// MTA poll endpoint ini untuk cek apakah player sudah auth
// ============================================================
app.get("/check", (req, res) => {
  const { state, secret } = req.query;

  if (secret !== MTA_SECRET) {
    return res.status(403).json({ ok: false, error: "Unauthorized" });
  }

  const session = pendingSessions.get(state);
  if (!session) {
    return res.json({ ok: false, pending: true });
  }

  // Hapus setelah diambil (one-time use)
  pendingSessions.delete(state);

  res.json({
    ok:              true,
    discordID:       session.discordID,
    discordUsername: session.discordUsername,
  });
});

// ============================================================
// Halaman HTML simpel
// ============================================================
function renderPage(title, body) {
  return `<!DOCTYPE html>
<html lang="id">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} — ILSRP</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      font-family: 'Segoe UI', sans-serif;
      background: #1a1a2e;
      color: #eee;
      display: flex;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
    }
    .card {
      background: #16213e;
      border: 1px solid #0f3460;
      border-radius: 12px;
      padding: 40px;
      max-width: 460px;
      width: 90%;
      text-align: center;
      box-shadow: 0 8px 32px rgba(0,0,0,0.4);
    }
    .logo { font-size: 2em; margin-bottom: 12px; }
    h1 { color: #c8962a; margin-bottom: 16px; font-size: 1.4em; }
    p { line-height: 1.7; color: #ccc; font-size: 0.95em; }
    small { color: #888; font-size: 0.8em; }
  </style>
</head>
<body>
  <div class="card">
    <div class="logo">🎮</div>
    <h1>${title}</h1>
    <p>${body}</p>
  </div>
</body>
</html>`;
}

app.listen(PORT, () => {
  console.log(`[ILSRP Auth] Running on port ${PORT}`);
});

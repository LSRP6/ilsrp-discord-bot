// ILSRP Discord OAuth2 Bridge
// Deploy ini ke Railway, lalu isi environment variables:
//   DISCORD_CLIENT_ID      = Client ID dari Discord Developer Portal
//   DISCORD_CLIENT_SECRET  = Client Secret dari Discord Developer Portal
//   REDIRECT_URI           = https://DOMAIN-RAILWAY-KAMU.railway.app/callback
//   MTA_SECRET             = bebas, string rahasia buat verifikasi request dari MTA
//   DISCORD_BOT_TOKEN      = Bot Token dari Discord Developer Portal
//   PORT                   = 3000 (Railway set otomatis)

const express = require("express");
const axios   = require("axios");
const app     = express();

app.use(express.json());

const {
  DISCORD_CLIENT_ID,
  DISCORD_CLIENT_SECRET,
  REDIRECT_URI,
  MTA_SECRET,
  DISCORD_BOT_TOKEN,
  PORT = 3000,
} = process.env;

// Simpan sesi pending: token sementara → { discordID, username, expires }
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

    const userRes = await axios.get("https://discord.com/api/users/@me", {
      headers: { Authorization: `Bearer ${accessToken}` },
    });

    const discordID       = userRes.data.id;
    const discordUsername = userRes.data.username;

    pendingSessions.set(state, {
      discordID,
      discordUsername,
      expires: Date.now() + 10 * 60 * 1000,
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

  pendingSessions.delete(state);

  res.json({
    ok:              true,
    discordID:       session.discordID,
    discordUsername: session.discordUsername,
  });
});

// ============================================================
// POST /send-dm
// Dipanggil MTA untuk kirim DM ke player via Discord Bot
// Body: { discordID, message, secret }
// ============================================================
app.post("/send-dm", async (req, res) => {
  console.log("[send-dm] Request masuk:", req.body);

  const { discordID, message, secret } = req.body;

  // Validasi secret
  if (secret !== MTA_SECRET) {
    console.log("[send-dm] Secret salah!");
    return res.status(403).json({ ok: false, error: "Unauthorized" });
  }

  // Validasi parameter
  if (!discordID || !message) {
    console.log("[send-dm] Parameter tidak lengkap");
    return res.status(400).json({ ok: false, error: "discordID dan message wajib diisi" });
  }

  if (!DISCORD_BOT_TOKEN) {
    console.log("[send-dm] DISCORD_BOT_TOKEN tidak ada di environment!");
    return res.status(500).json({ ok: false, error: "Bot token tidak dikonfigurasi" });
  }

  try {
    // Buka DM channel dulu
    console.log("[send-dm] Membuka DM channel ke discordID=" + discordID);
    const dmChannel = await axios.post(
      "https://discord.com/api/v10/users/@me/channels",
      { recipient_id: discordID },
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    const channelID = dmChannel.data.id;
    console.log("[send-dm] DM channel ID=" + channelID);

    // Kirim pesan ke DM channel
    await axios.post(
      `https://discord.com/api/v10/channels/${channelID}/messages`,
      { content: message },
      {
        headers: {
          Authorization: `Bot ${DISCORD_BOT_TOKEN}`,
          "Content-Type": "application/json",
        },
      }
    );

    console.log("[send-dm] SUKSES kirim DM ke discordID=" + discordID);
    res.json({ ok: true });

  } catch (err) {
    const errData = err?.response?.data || err.message;
    console.error("[send-dm] GAGAL:", errData);
    res.status(500).json({ ok: false, error: errData });
  }
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

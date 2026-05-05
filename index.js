const { Client, GatewayIntentBits, REST, Routes, SlashCommandBuilder } = require('discord.js');
const express = require('express');
const mysql = require('mysql2/promise');

// ============================================================
// CONFIG — isi sesuai milik kamu
// ============================================================
const CONFIG = {
    DISCORD_TOKEN   : process.env.DISCORD_TOKEN,
    CLIENT_ID       : process.env.CLIENT_ID,
    VERIFY_CHANNEL  : process.env.VERIFY_CHANNEL  || 'verify',
    API_SECRET      : process.env.API_SECRET       || 'ilsrp_secret_key',
    PORT            : process.env.PORT             || 3000,
    DB_HOST         : process.env.DB_HOST,
    DB_USER         : process.env.DB_USER,
    DB_PASS         : process.env.DB_PASS,
    DB_NAME         : process.env.DB_NAME,
    DB_PORT         : process.env.DB_PORT          || 3306,
};

// ============================================================
// DATABASE
// ============================================================
let db;
async function connectDB() {
    db = await mysql.createConnection({
        host    : CONFIG.DB_HOST,
        user    : CONFIG.DB_USER,
        password: CONFIG.DB_PASS,
        database: CONFIG.DB_NAME,
        port    : CONFIG.DB_PORT,
    });
    console.log('[DB] Connected to MySQL');
}

// ============================================================
// DISCORD BOT
// ============================================================
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
    ]
});

// Register slash command /verify
async function registerCommands() {
    const commands = [
        new SlashCommandBuilder()
            .setName('verify')
            .setDescription('Verifikasi akun MTA kamu')
            .addStringOption(opt =>
                opt.setName('username')
                   .setDescription('Username MTA kamu')
                   .setRequired(true)
            )
    ].map(cmd => cmd.toJSON());

    const rest = new REST({ version: '10' }).setToken(CONFIG.DISCORD_TOKEN);
    try {
        await rest.put(Routes.applicationCommands(CONFIG.CLIENT_ID), { body: commands });
        console.log('[Discord] Slash command /verify terdaftar');
    } catch (err) {
        console.error('[Discord] Gagal register command:', err);
    }
}

client.once('ready', async () => {
    console.log(`[Discord] Bot online sebagai ${client.user.tag}`);
    await registerCommands();
});

// Handle /verify command
client.on('interactionCreate', async interaction => {
    if (!interaction.isChatInputCommand()) return;
    if (interaction.commandName !== 'verify') return;

    // Cek apakah di channel verify
    if (interaction.channel.name !== CONFIG.VERIFY_CHANNEL) {
        await interaction.reply({
            content: `❌ Command ini hanya bisa digunakan di channel **#${CONFIG.VERIFY_CHANNEL}**!`,
            ephemeral: true
        });
        return;
    }

    const username   = interaction.options.getString('username');
    const discordID  = interaction.user.id;
    const discordTag = interaction.user.tag;

    try {
        // Cek apakah username ada di database
        const [rows] = await db.execute(
            'SELECT id, username, discord_id FROM accounts WHERE username = ? LIMIT 1',
            [username]
        );

        if (rows.length === 0) {
            await interaction.reply({
                content: `❌ Username **${username}** tidak ditemukan di database ILSRP!`,
                ephemeral: true
            });
            return;
        }

        const account = rows[0];

        // Cek apakah Discord ID sudah dipakai akun lain
        const [existing] = await db.execute(
            'SELECT id, username FROM accounts WHERE discord_id = ? AND id != ? LIMIT 1',
            [discordID, account.id]
        );

        if (existing.length > 0) {
            await interaction.reply({
                content: `❌ Akun Discord kamu sudah terhubung ke username **${existing[0].username}**!`,
                ephemeral: true
            });
            return;
        }

        // Simpan Discord ID ke database
        await db.execute(
            'UPDATE accounts SET discord_id = ? WHERE id = ?',
            [discordID, account.id]
        );

        console.log(`[Verify] ${username} → Discord: ${discordTag} (${discordID})`);

        await interaction.reply({
            content: `✅ Akun **${username}** berhasil terhubung ke Discord kamu!\nSekarang kamu akan menerima notifikasi reset password via Discord DM.`,
            ephemeral: true
        });

    } catch (err) {
        console.error('[Verify] DB error:', err);
        await interaction.reply({
            content: '❌ Terjadi error. Coba lagi nanti.',
            ephemeral: true
        });
    }
});

// ============================================================
// EXPRESS API — dipanggil dari MTA pakai fetchRemote
// Endpoint: POST /send-dm
// Body: { secret, discord_id, message }
// ============================================================
const app = express();
app.use(express.json());

app.post('/send-dm', async (req, res) => {
    const { secret, discord_id, message } = req.body;

    // Validasi secret key
    if (secret !== CONFIG.API_SECRET) {
        return res.status(403).json({ ok: false, error: 'Unauthorized' });
    }

    if (!discord_id || !message) {
        return res.status(400).json({ ok: false, error: 'Missing discord_id or message' });
    }

    try {
        const user = await client.users.fetch(discord_id);
        await user.send(message);
        console.log(`[DM] Pesan terkirim ke ${discord_id}`);
        res.json({ ok: true });
    } catch (err) {
        console.error('[DM] Gagal kirim DM:', err.message);
        res.status(500).json({ ok: false, error: err.message });
    }
});

// Health check
app.get('/', (req, res) => {
    res.json({ status: 'ILSRP Discord Bot is running' });
});

// ============================================================
// START
// ============================================================
(async () => {
    await connectDB();
    client.login(CONFIG.DISCORD_TOKEN);
    app.listen(CONFIG.PORT, () => {
        console.log(`[API] Express berjalan di port ${CONFIG.PORT}`);
    });
})();

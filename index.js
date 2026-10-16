require('dotenv').config();
const express = require('express');
const cors = require('cors');
const TelegramBot = require('node-telegram-bot-api');
const { handlePredictCommand } = require('./services/BotCommandHandler');
const { syncMatchesToDatabase } = require('./services/SyncService');

// 1. Serveur Express
const app = express();
const PORT = process.env.PORT || 3000;
app.use(cors());
app.use(express.json());

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'API AI ScoreCast est en ligne' });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur API démarré sur le port ${PORT}`);
});

// 2. Bot Telegram
const token = process.env.TELEGRAM_BOT_TOKEN;
if (token) {
  const bot = new TelegramBot(token, { polling: true });

  bot.on('message', async (msg) => {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (text && text.startsWith('/predire')) {
      bot.sendMessage(chatId, "⏳ Analyse en cours...");
      const response = await handlePredictCommand(text);
      bot.sendMessage(chatId, response, { parse_mode: 'Markdown' });
    }
  });

  console.log('🤖 Bot Telegram démarré.');
} else {
  console.log('⚠️ Aucun token Telegram trouvé.');
}

// 3. Synchronisation initiale au démarrage
(async () => {
  console.log('🔄 Synchronisation initiale...');
  const today = new Date().toISOString().split('T')[0];
  await syncMatchesToDatabase(today);
  console.log('✅ Synchronisation initiale terminée.');
})();

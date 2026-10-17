// ==========================================
// 1. IMPORTATIONS ET CONFIGURATION DE BASE
// ==========================================
require('dotenv').config();
const express = require('express');
const cors = require('cors');
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const TelegramBot = require('node-telegram-bot-api');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());

// ==========================================
// 2. CONFIGURATION DES LIGUES ET DU CACHE
// ==========================================
const LEAGUES = {
  39: 'Premier League',
  140: 'La Liga',
  78: 'Bundesliga',
  61: 'Ligue 1',
  2: 'UEFA Champions League',
  3: 'UEFA Europa League'
};

const CACHE_FILE = path.join(__dirname, 'cache.json');

function getCache() {
  if (fs.existsSync(CACHE_FILE)) {
    return JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
  }
  return {};
}

function setCache(key, data) {
  const cache = getCache();
  cache[key] = { timestamp: Date.now(), data };
  fs.writeFileSync(CACHE_FILE, JSON.stringify(cache, null, 2));
}

function isCacheValid(key, maxAgeMinutes = 60) {
  const cache = getCache();
  if (!cache[key]) return false;
  const ageMinutes = (Date.now() - cache[key].timestamp) / 1000 / 60;
  return ageMinutes < maxAgeMinutes;
}

// ==========================================
// 3. MOTEUR DE PRÉDICTION (LOI DE POISSON)
// ==========================================
function factorial(n) {
  if (n === 0 || n === 1) return 1;
  let result = 1;
  for (let i = 2; i <= n; i++) result *= i;
  return result;
}

function poissonProbability(lambda, k) {
  const e = Math.exp(-lambda);
  return (e * Math.pow(lambda, k)) / factorial(k);
}

function calculateMatchProbabilities(lambdaHome, lambdaAway) {
  let probHomeWin = 0, probDraw = 0, probAwayWin = 0;
  for (let h = 0; h <= 5; h++) {
    for (let a = 0; a <= 5; a++) {
      const jointProb = poissonProbability(lambdaHome, h) * poissonProbability(lambdaAway, a);
      if (h > a) probHomeWin += jointProb;
      else if (h === a) probDraw += jointProb;
      else probAwayWin += jointProb;
    }
  }
  const total = probHomeWin + probDraw + probAwayWin;
  return {
    homeWin: (probHomeWin / total) * 100,
    draw: (probDraw / total) * 100,
    awayWin: (probAwayWin / total) * 100,
  };
}

// ==========================================
// 4. SYNCHRONISATION DES MATCHS (API-FOOTBALL)
// ==========================================
async function fetchDailyMatches(date) {
  const cacheKey = `matches_${date}`;
  if (isCacheValid(cacheKey, 60)) {
    console.log('📦 Utilisation du cache pour les matchs du', date);
    return getCache()[cacheKey].data;
  }

  console.log('🌐 Appel API-Football pour les matchs du', date);
  try {
    const response = await axios.get('https://v3.football.api-sports.io/fixtures', {
      params: { date: date },
      headers: {
        'x-rapidapi-host': 'v3.football.api-sports.io',
        'x-rapidapi-key': process.env.API_FOOTBALL_KEY,
      },
    });

    const filteredMatches = response.data.response.filter((m) => LEAGUES[m.league.id]);
    setCache(cacheKey, filteredMatches);
    return filteredMatches;
  } catch (error) {
    console.error('❌ Erreur API-Football:', error.message);
    return getCache()[cacheKey]?.data || [];
  }
}

async function syncMatchesToDatabase(date) {
  const matches = await fetchDailyMatches(date);
  if (matches.length === 0) return console.log('📭 Aucun match trouvé pour le', date);

  console.log(`🔄 Synchronisation de ${matches.length} matchs...`);

  for (const item of matches) {
    const { fixture, league, teams, goals } = item;

    const leagueRecord = await prisma.league.upsert({
      where: { externalId: league.id.toString() },
      update: { name: league.name, logoUrl: league.logo },
      create: { externalId: league.id.toString(), name: league.name, country: league.country, logoUrl: league.logo },
    });

    const homeTeam = await prisma.team.upsert({
      where: { externalId: teams.home.id.toString() },
      update: { name: teams.home.name, logoUrl: teams.home.logo },
      create: { externalId: teams.home.id.toString(), name: teams.home.name, logoUrl: teams.home.logo, leagueId: leagueRecord.id },
    });

    const awayTeam = await prisma.team.upsert({
      where: { externalId: teams.away.id.toString() },
      update: { name: teams.away.name, logoUrl: teams.away.logo },
      create: { externalId: teams.away.id.toString(), name: teams.away.name, logoUrl: teams.away.logo, leagueId: leagueRecord.id },
    });

    const isFinished = fixture.status.short === 'FT';
    const isLive = ['1H', '2H', 'HT'].includes(fixture.status.short);

    await prisma.match.upsert({
      where: { externalId: fixture.id.toString() },
      update: {
        status: isFinished ? 'FINISHED' : (isLive ? 'LIVE' : 'SCHEDULED'),
        homeScore: goals.home,
        awayScore: goals.away,
      },
      create: {
        externalId: fixture.id.toString(),
        date: new Date(fixture.date),
        status: 'SCHEDULED',
        leagueId: leagueRecord.id,
        homeTeamId: homeTeam.id,
        awayTeamId: awayTeam.id,
      },
    });
  }
  console.log('✅ Synchronisation terminée.');
}

// ==========================================
// 5. GESTION DES COMMANDES DU BOT TELEGRAM
// ==========================================
function parseTeams(input) {
  let cleanInput = input.replace('/predire', '').trim();
  let teams = [];
  
  if (cleanInput.includes(' vs ')) teams = cleanInput.split(' vs ');
  else if (cleanInput.includes(' contre ')) teams = cleanInput.split(' contre ');
  else if (cleanInput.includes(' - ')) teams = cleanInput.split(' - ');
  else {
    const idx = cleanInput.indexOf(' ');
    if (idx !== -1) teams = [cleanInput.substring(0, idx), cleanInput.substring(idx + 1)];
  }
  return teams.map(t => t.trim()).filter(t => t.length > 0);
}

async function handlePredictCommand(message) {
  const teams = parseTeams(message);
  if (teams.length !== 2) return "Usage : /predire <equipe1> <equipe2>\nExemple : /predire PSG Marseille";

  const [homeTeamName, awayTeamName] = teams;

  try {
    const homeTeam = await prisma.team.findFirst({ where: { name: { contains: homeTeamName, mode: 'insensitive' } } });
    const awayTeam = await prisma.team.findFirst({ where: { name: { contains: awayTeamName, mode: 'insensitive' } } });

    if (!homeTeam) return `Erreur : Equipe introuvable : ${homeTeamName}`;
    if (!awayTeam) return `Erreur : Equipe introuvable : ${awayTeamName}`;

    const lambdaHome = 1.5 * 1.2; 
    const lambdaAway = 1.1;
    const probs = calculateMatchProbabilities(lambdaHome, lambdaAway);

    return `📊 **Pronostic IA : ${homeTeam.name} vs ${awayTeam.name}**\n\n🏠 Victoire ${homeTeam.name} : ${probs.homeWin.toFixed(2)}%\n🤝 Match Nul : ${probs.draw.toFixed(2)}%\n✈️ Victoire ${awayTeam.name} : ${probs.awayWin.toFixed(2)}%\n\n💡 *Analyse basée sur la Loi de Poisson.*`;
  } catch (error) {
    console.error(error);
    return "Une erreur est survenue lors de l'analyse.";
  }
}

// ==========================================
// 6. LANCEMENT DU SERVEUR EXPRESS (API)
// ==========================================
app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'API AI ScoreCast est en ligne' });
});

app.listen(PORT, () => {
  console.log(`🚀 Serveur API démarré sur le port ${PORT}`);
});

// ==========================================
// 7. LANCEMENT DU BOT TELEGRAM
// ==========================================
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

// ==========================================
// 8. SYNCHRONISATION INITIALE AU DÉMARRAGE
// ==========================================
(async () => {
  console.log('🔄 Synchronisation initiale...');
  const today = new Date().toISOString().split('T')[0];
  await syncMatchesToDatabase(today);
  console.log('✅ Synchronisation initiale terminée.');
})();

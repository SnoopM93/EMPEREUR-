const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { PrismaClient } = require('@prisma/client');

const prisma = new PrismaClient();
const CACHE_FILE = path.join(__dirname, '..', 'cache.json');

// IDs des ligues sur API-Football
const LEAGUES = {
  39: 'Premier League',
  140: 'La Liga',
  78: 'Bundesliga',
  61: 'Ligue 1',
  2: 'UEFA Champions League',
  3: 'UEFA Europa League'
};

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

module.exports = { syncMatchesToDatabase };

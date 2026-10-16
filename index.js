import { Telegraf } from 'telegraf';
import 'dotenv/config';
import http from 'node:http';

// =====================
// 0. SERVEUR HTTP (Railway)
// =====================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Telegram Empereur Predication en ligne');
}).listen(PORT, () => {
  console.log(`Serveur HTTP actif sur le port ${PORT}`);
});

// =====================
// 1. CONFIGURATION
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const FOOTBALL_KEY = process.env.FOOTBALL_KEY;
const ODDS_API_KEY = process.env.ODDS_API;

const FOOTBALL_BASE_URL = 'https://footballdata.io/api/v1';
const ODDS_BASE_URL = 'https://api.the-odds-api.com/v4';
const SPORT_KEY = 'soccer_france_ligue_one';

// =====================
// 2. SERVICES FOOTBALL
// =====================
async function requestFootball(endpoint) {
  const response = await fetch(`${FOOTBALL_BASE_URL}${endpoint}`, {
    headers: { Authorization: `Bearer ${FOOTBALL_KEY}`, Accept: 'application/json' }
  });
  if (!response.ok) throw new Error(`Erreur Football API (${response.status})`);
  return response.json();
}

async function searchTeam(name) {
  const data = await requestFootball(`/teams?search=${encodeURIComponent(name)}`);
  return data?.data?.[0] ?? null;
}

async function findUpcomingMatch(homeTeamId, awayTeamId) {
  const data = await requestFootball(`/fixtures/upcoming?team1=${homeTeamId}&team2=${awayTeamId}`);
  return data?.data?.[0] ?? null;
}

async function getMatchProbabilities(matchId) {
  const data = await requestFootball(`/matches/${matchId}/probabilities`);
  return data?.data ?? null;
}

async function getMatchStats(matchId) {
  try {
    const data = await requestFootball(`/matches/${matchId}/stats`);
    return data?.data ?? null;
  } catch {
    return null;
  }
}

async function getTeamRecentMatches(teamId, limit = 15) {
  try {
    const data = await requestFootball(`/teams/${teamId}/matches?limit=${limit}&status=finished`);
    return data?.data ?? [];
  } catch (error) {
    console.warn('Historique equipe indisponible:', error.message);
    return [];
  }
}

async function getHeadToHead(team1Id, team2Id, limit = 15) {
  try {
    const data = await requestFootball(`/head2head?team1=${team1Id}&team2=${team2Id}&limit=${limit}`);
    return data?.data ?? [];
  } catch (error) {
    console.warn('H2H indisponible:', error.message);
    return [];
  }
}

// =====================
// 3. SERVICES ODDS
// =====================
async function getOdds(homeTeamName, awayTeamName) {
  try {
    const url = `${ODDS_BASE_URL}/sports/${SPORT_KEY}/odds/?apiKey=${ODDS_API_KEY}&regions=eu&markets=h2h`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    const match = data.find(m =>
      m.home_team.includes(homeTeamName) && m.away_team.includes(awayTeamName)
    );
    if (!match || !match.bookmakers?.[0]?.markets?.[0]?.outcomes) return null;

    const outcomes = match.bookmakers[0].markets[0].outcomes;
    return {
      home: outcomes.find(o => o.name === match.home_team)?.price ?? 'N/A',
      draw: outcomes.find(o => o.name === 'Draw')?.price ?? 'N/A',
      away: outcomes.find(o => o.name === match.away_team)?.price ?? 'N/A'
    };
  } catch (error) {
    console.warn('Cotes indisponibles:', error.message);
    return null;
  }
}

async function findOddsEventId(homeTeamName, awayTeamName) {
  try {
    const url = `${ODDS_BASE_URL}/sports/${SPORT_KEY}/events?apiKey=${ODDS_API_KEY}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const events = await response.json();
    const event = events.find(e =>
      e.home_team.includes(homeTeamName) && e.away_team.includes(awayTeamName)
    );
    return event?.id ?? null;
  } catch (error) {
    console.warn('ID evenement introuvable:', error.message);
    return null;
  }
}

async function getMarketOdds(eventId, marketKey) {
  try {
    const url = `${ODDS_BASE_URL}/sports/${SPORT_KEY}/events/${eventId}/odds?apiKey=${ODDS_API_KEY}&regions=eu&markets=${marketKey}`;
    const response = await fetch(url);
    if (!response.ok) return null;

    const data = await response.json();
    if (!data.bookmakers?.[0]?.markets?.[0]?.outcomes) return null;
    return data.bookmakers[0].markets[0].outcomes;
  } catch (error) {
    console.warn(`Marche ${marketKey} indisponible:`, error.message);
    return null;
  }
}

// =====================
// 4. FORME PONDEREE
// =====================
function calculateForm(recentMatches, teamId) {
  if (!recentMatches || recentMatches.length === 0) {
    return { score: 50, wins: 0, draws: 0, losses: 0, goalsFor: 0, goalsAgainst: 0, matches: 0 };
  }

  let weightedPoints = 0;
  let totalWeight = 0;
  let wins = 0, draws = 0, losses = 0;
  let goalsFor = 0, goalsAgainst = 0;

  recentMatches.forEach((match, index) => {
    const weight = Math.pow(0.9, index);
    const isHome = match.home_team_id === teamId;
    const teamScore = isHome ? match.home_score : match.away_score;
    const oppScore = isHome ? match.away_score : match.home_score;

    if (teamScore == null || oppScore == null) return;

    goalsFor += teamScore;
    goalsAgainst += oppScore;

    let points = 0;
    if (teamScore > oppScore) { points = 3; wins++; }
    else if (teamScore === oppScore) { points = 1; draws++; }
    else { losses++; }

    weightedPoints += points * weight;
    totalWeight += 3 * weight;
  });

  const score = totalWeight > 0 ? Math.round((weightedPoints / totalWeight) * 100) : 50;
  return { score, wins, draws, losses, goalsFor, goalsAgainst, matches: recentMatches.length };
}

// =====================
// 5. H2H
// =====================
function analyzeH2H(matches, team1Id) {
  if (!matches || matches.length === 0) {
    return { team1Wins: 0, draws: 0, team2Wins: 0, total: 0, team1Goals: 0, team2Goals: 0, bttsCount: 0, over25Count: 0 };
  }

  let team1Wins = 0, draws = 0, team2Wins = 0;
  let team1Goals = 0, team2Goals = 0;
  let bttsCount = 0;
  let over25Count = 0;

  matches.forEach(match => {
    const isTeam1Home = match.home_team_id === team1Id;
    const score1 = isTeam1Home ? match.home_score : match.away_score;
    const score2 = isTeam1Home ? match.away_score : match.home_score;

    if (score1 == null || score2 == null) return;

    team1Goals += score1;
    team2Goals += score2;

    if (score1 > score2) team1Wins++;
    else if (score1 === score2) draws++;
    else team2Wins++;

    if (score1 > 0 && score2 > 0) bttsCount++;
    if (score1 + score2 > 2.5) over25Count++;
  });

  return { team1Wins, draws, team2Wins, total: matches.length, team1Goals, team2Goals, bttsCount, over25Count };
}

// =====================
// 6. PREDICTION 1X2
// =====================
async function getPrediction(homeTeamName, awayTeamName) {
  const [homeTeam, awayTeam] = await Promise.all([
    searchTeam(homeTeamName),
    searchTeam(awayTeamName)
  ]);
  if (!homeTeam) throw new Error(`Equipe introuvable : ${homeTeamName}`);
  if (!awayTeam) throw new Error(`Equipe introuvable : ${awayTeamName}`);

  const match = await findUpcomingMatch(homeTeam.id, awayTeam.id);
  if (!match) throw new Error('Aucun match a venir trouve entre ces deux equipes.');

  const probs = await getMatchProbabilities(match.id);

  const [homeMatches, awayMatches, h2hMatches] = await Promise.all([
    getTeamRecentMatches(homeTeam.id),
    getTeamRecentMatches(awayTeam.id),
    getHeadToHead(homeTeam.id, awayTeam.id)
  ]);

  const homeForm = calculateForm(homeMatches, homeTeam.id);
  const awayForm = calculateForm(awayMatches, awayTeam.id);
  const h2h = analyzeH2H(h2hMatches, homeTeam.id);

  let finalHome, finalDraw, finalAway;
  if (probs) {
    finalHome = Math.round((probs.home_win ?? 0) * 100);
    finalDraw = Math.round((probs.draw ?? 0) * 100);
    finalAway = Math.round((probs.away_win ?? 0) * 100);
  } else {
    const homeAdvantage = 10;
    const pHome = (homeForm.score * 0.40) + ((100 - awayForm.score) * 0.30) + homeAdvantage;
    const pDraw = 25;
    const pAway = (awayForm.score * 0.40) + ((100 - homeForm.score) * 0.30);
    const total = pHome + pDraw + pAway;
    finalHome = Math.round((pHome / total) * 100);
    finalDraw = Math.round((pDraw / total) * 100);
    finalAway = Math.round((pAway / total) * 100);
  }

  return {
    matchId: match.id,
    homeTeamId: homeTeam.id,
    awayTeamId: awayTeam.id,
    homeWinProb: finalHome,
    drawProb: finalDraw,
    awayWinProb: finalAway,
    homeForm,
    awayForm,
    h2h
  };
}

// =====================
// 7. MARCHES SUPPLEMENTAIRES
// =====================
async function predictTotalGoals(eventId) {
  const outcomes = await getMarketOdds(eventId, 'totals');
  if (!outcomes) return null;
  const over = outcomes.find(o => o.name === 'Over');
  const under = outcomes.find(o => o.name === 'Under');
  if (!over || !under) return null;
  return {
    line: over.point ?? 2.5,
    over: over.price,
    under: under.price,
    overProb: Math.round((1 / over.price) * 100),
    underProb: Math.round((1 / under.price) * 100)
  };
}

async function predictBTTS(eventId) {
  const outcomes = await getMarketOdds(eventId, 'btts');
  if (!outcomes) return null;
  const yes = outcomes.find(o => o.name === 'Yes');
  const no = outcomes.find(o => o.name === 'No');
  if (!yes || !no) return null;
  return {
    yes: yes.price,
    no: no.price,
    yesProb: Math.round((1 / yes.price) * 100),
    noProb: Math.round((1 / no.price) * 100)
  };
}

async function predictCorners(matchId) {
  const stats = await getMatchStats(matchId);
  if (!stats) return null;
  const homeCorners = stats.home?.corners ?? 0;
  const awayCorners = stats.away?.corners ?? 0;
  const total = homeCorners + awayCorners;
  if (homeCorners === 0 && awayCorners === 0) return null;
  const line = 9.5;
  return {
    home: homeCorners, away: awayCorners, total, line,
    prediction: total > line ? `Plus de ${line}` : `Moins de ${line}`
  };
}

async function predictShotsOnTarget(matchId) {
  const stats = await getMatchStats(matchId);
  if (!stats) return null;
  const homeShots = stats.home?.shots_on_target ?? 0;
  const awayShots = stats.away?.shots_on_target ?? 0;
  const total = homeShots + awayShots;
  if (homeShots === 0 && awayShots === 0) return null;
  const line = 8.5;
  return {
    home: homeShots, away: awayShots, total, line,
    prediction: total > line ? `Plus de ${line}` : `Moins de ${line}`
  };
}

async function predictExactScore(matchId) {
  try {
    const predictions = await requestFootball(`/matches/${matchId}/predictions`);
    const predData = predictions?.data;
    if (!predData?.correct_score) return null;
    return Object.entries(predData.correct_score)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([score, prob]) => ({ score, probability: Math.round(prob * 100) }));
  } catch {
    return null;
  }
}

async function getFullPrediction(homeTeamName, awayTeamName) {
  const base = await getPrediction(homeTeamName, awayTeamName);
  const eventId = await findOddsEventId(homeTeamName, awayTeamName);

  const [odds, totalGoals, btts, corners, shots, exactScore] = await Promise.all([
    getOdds(homeTeamName, awayTeamName),
    eventId ? predictTotalGoals(eventId) : null,
    eventId ? predictBTTS(eventId) : null,
    predictCorners(base.matchId),
    predictShotsOnTarget(base.matchId),
    predictExactScore(base.matchId)
  ]);

  return { ...base, odds, totalGoals, btts, corners, shots, exactScore };
}

// =====================
// 8. CONSTRUCTION DES MESSAGES (HTML)
// =====================
function buildPredictionMessage(homeTeam, awayTeam, p) {
  let msg = `<b>Prediction : ${homeTeam} vs ${awayTeam}</b>\n\n`;

  msg += `<b>Resultat 1X2</b>\n`;
  msg += `${homeTeam}: <b>${p.homeWinProb}%</b>\n`;
  msg += `Nul: <b>${p.drawProb}%</b>\n`;
  msg += `${awayTeam}: <b>${p.awayWinProb}%</b>\n\n`;

  if (p.homeForm && p.awayForm) {
    msg += `<b>Forme recente</b>\n`;
    msg += `${homeTeam}: <b>${p.homeForm.score}%</b> (${p.homeForm.wins}V ${p.homeForm.draws}N ${p.homeForm.losses}D)\n`;
    msg += `${awayTeam}: <b>${p.awayForm.score}%</b> (${p.awayForm.wins}V ${p.awayForm.draws}N ${p.awayForm.losses}D)\n\n`;
  }

  if (p.totalGoals) {
    msg += `<b>Total de buts</b> (ligne ${p.totalGoals.line})\n`;
    msg += `Plus: <b>${p.totalGoals.overProb}%</b> (cote ${p.totalGoals.over})\n`;
    msg += `Moins: <b>${p.totalGoals.underProb}%</b> (cote ${p.totalGoals.under})\n\n`;
  }

  if (p.btts) {
    msg += `<b>Les 2 equipes marquent</b>\n`;
    msg += `Oui: <b>${p.btts.yesProb}%</b> (cote ${p.btts.yes})\n`;
    msg += `Non: <b>${p.btts.noProb}%</b> (cote ${p.btts.no})\n\n`;
  }

  if (p.corners) {
    msg += `<b>Corners</b>\n`;
    msg += `Dom: ${p.corners.home} | Ext: ${p.corners.away}\n`;
    msg += `Total: <b>${p.corners.total}</b> - ${p.corners.prediction}\n\n`;
  }

  if (p.shots) {
    msg += `<b>Tirs cadres</b>\n`;
    msg += `Dom: ${p.shots.home} | Ext: ${p.shots.away}\n`;
    msg += `Total: <b>${p.shots.total}</b> - ${p.shots.prediction}\n\n`;
  }

  if (p.exactScore && p.exactScore.length > 0) {
    msg += `<b>Scores exacts probables</b>\n`;
    msg += p.exactScore.map(s => `${s.score} (${s.probability}%)`).join(' | ') + '\n\n';
  }

  if (p.odds) {
    msg += `<b>Cotes 1X2</b>\n`;
    msg += `Dom: ${p.odds.home} | Nul: ${p.odds.draw} | Ext: ${p.odds.away}\n`;
  }

  return msg;
}

function buildFormMessage(teamName, form) {
  let color = form.score >= 70 ? 'Bonne forme' : (form.score <= 30 ? 'Mauvaise forme' : 'Forme moyenne');
  let msg = `<b>Forme de ${teamName}</b>\n\n`;
  msg += `Score: <b>${form.score}%</b> (${color})\n`;
  msg += `Bilan: ${form.wins}V - ${form.draws}N - ${form.losses}D\n`;
  msg += `Buts: ${form.goalsFor} marques / ${form.goalsAgainst} encaisses\n`;
  msg += `Analyse sur ${form.matches} matchs recents.`;
  return msg;
}

function buildH2HMessage(team1Name, team2Name, h2h) {
  let msg = `<b>Confrontations : ${team1Name} vs ${team2Name}</b>\n\n`;
  msg += `<b>Bilan</b>\n`;
  msg += `${team1Name}: <b>${h2h.team1Wins}</b> victoires\n`;
  msg += `Nuls: <b>${h2h.draws}</b>\n`;
  msg += `${team2Name}: <b>${h2h.team2Wins}</b> victoires\n\n`;

  msg += `<b>Buts</b>\n`;
  msg += `${team1Name}: ${h2h.team1Goals} | ${team2Name}: ${h2h.team2Goals}\n\n`;

  if (h2h.total > 0) {
    const bttsPct = Math.round((h2h.bttsCount / h2h.total) * 100);
    const over25Pct = Math.round((h2h.over25Count / h2h.total) * 100);
    msg += `<b>Stats</b>\n`;
    msg += `BTTS: <b>${bttsPct}%</b>\n`;
    msg += `Plus de 2.5 buts: <b>${over25Pct}%</b>\n\n`;
  }

  msg += `Analyse sur ${h2h.total} confrontations.`;
  return msg;
}

// =====================
// 9. BOT TELEGRAM
// =====================
const bot = new Telegraf(BOT_TOKEN);

// Commande /start
bot.start((ctx) => {
  ctx.reply(
    `Bienvenue sur Empereur Predication !\n\n` +
    `Commandes disponibles :\n` +
    `/predire <equipe1> <equipe2> - Prediction complete\n` +
    `/forme <equipe> - Forme recente\n` +
    `/h2h <equipe1> <equipe2> - Confrontations\n\n` +
    `Exemple : /predire PSG Marseille`
  );
});

// Commande /help
bot.help((ctx) => {
  ctx.reply(
    `Aide :\n\n` +
    `/predire PSG Marseille - Analyse complete\n` +
    `/forme PSG - Forme de PSG\n` +
    `/h2h PSG Marseille - Historique des duels\n\n` +
    `Le bot analyse les stats, la forme et les cotes pour vous.`
  );
});

// Commande /predire
bot.command('predire', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage : /predire <equipe1> <equipe2>\nExemple : /predire PSG Marseille');
  }

  const homeTeam = args[0];
  const awayTeam = args.slice(1).join(' ');

  const loadingMsg = await ctx.reply(`Analyse de ${homeTeam} vs ${awayTeam} en cours...`);

  try {
    const prediction = await getFullPrediction(homeTeam, awayTeam);
    const message = buildPredictionMessage(homeTeam, awayTeam, prediction);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      message,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error(error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      `Erreur : ${error.message}`
    );
  }
});

// Commande /forme
bot.command('forme', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 1) {
    return ctx.reply('Usage : /forme <equipe>\nExemple : /forme PSG');
  }

  const teamName = args.join(' ');
  const loadingMsg = await ctx.reply(`Analyse de ${teamName} en cours...`);

  try {
    const team = await searchTeam(teamName);
    if (!team) throw new Error(`Equipe introuvable : ${teamName}`);

    const recentMatches = await getTeamRecentMatches(team.id);
    if (recentMatches.length === 0) throw new Error('Aucun match recent trouve.');

    const form = calculateForm(recentMatches, team.id);
    const message = buildFormMessage(teamName, form);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      message,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error(error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      `Erreur : ${error.message}`
    );
  }
});

// Commande /h2h
bot.command('h2h', async (ctx) => {
  const args = ctx.message.text.split(' ').slice(1);
  if (args.length < 2) {
    return ctx.reply('Usage : /h2h <equipe1> <equipe2>\nExemple : /h2h PSG Marseille');
  }

  const team1Name = args[0];
  const team2Name = args.slice(1).join(' ');
  const loadingMsg = await ctx.reply(`Analyse des confrontations en cours...`);

  try {
    const [team1, team2] = await Promise.all([
      searchTeam(team1Name),
      searchTeam(team2Name)
    ]);
    if (!team1) throw new Error(`Equipe introuvable : ${team1Name}`);
    if (!team2) throw new Error(`Equipe introuvable : ${team2Name}`);

    const matches = await getHeadToHead(team1.id, team2.id);
    if (matches.length === 0) throw new Error('Aucune confrontation trouvee.');

    const h2h = analyzeH2H(matches, team1.id);
    const message = buildH2HMessage(team1Name, team2Name, h2h);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      message,
      { parse_mode: 'HTML' }
    );
  } catch (error) {
    console.error(error);
    await ctx.telegram.editMessageText(
      ctx.chat.id,
      loadingMsg.message_id,
      undefined,
      `Erreur : ${error.message}`
    );
  }
});

// Gestion des erreurs globales
bot.catch((err, ctx) => {
  console.error(`Erreur pour ${ctx.updateType}:`, err);
});

// Lancement du bot
bot.launch().then(() => {
  console.log('Bot Telegram lance !');
});

// Arret propre
process.once('SIGINT', () => bot.stop('SIGINT'));
process.once('SIGTERM', () => bot.stop('SIGTERM'));

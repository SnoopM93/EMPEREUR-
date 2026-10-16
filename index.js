import { Client, Collection, Events, GatewayIntentBits, SlashCommandBuilder, EmbedBuilder, REST, Routes } from 'discord.js';
import 'dotenv/config';
import http from 'node:http';

// =====================
// 0. SERVEUR HTTP (Railway)
// =====================
const PORT = process.env.PORT || 3000;
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain' });
  res.end('Bot Empereur Predication en ligne');
}).listen(PORT, () => {
  console.log(`Serveur HTTP actif sur le port ${PORT}`);
});

// =====================
// 1. CONFIGURATION
// =====================
const BOT_TOKEN = process.env.BOT_TOKEN;
const CLIENT_ID = process.env.DISCORD_CLIENT_ID;
const GUILD_ID = process.env.DISCORD_GUILD_ID;
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
// 4. PREDICTION 1X2
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
  if (!probs) throw new Error("L'API n'a pas retourne de probabilites pour ce match.");

  return {
    matchId: match.id,
    homeWinProb: Math.round((probs.home_win ?? 0) * 100),
    drawProb: Math.round((probs.draw ?? 0) * 100),
    awayWinProb: Math.round((probs.away_win ?? 0) * 100)
  };
}

// =====================
// 5. TOTAL DE BUTS
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

// =====================
// 6. BTTS
// =====================
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

// =====================
// 7. CORNERS
// =====================
async function predictCorners(matchId) {
  const stats = await getMatchStats(matchId);
  if (!stats) return null;

  const homeCorners = stats.home?.corners ?? 0;
  const awayCorners = stats.away?.corners ?? 0;
  const total = homeCorners + awayCorners;

  if (homeCorners === 0 && awayCorners === 0) return null;

  const line = 9.5;
  return {
    home: homeCorners,
    away: awayCorners,
    total,
    line,
    prediction: total > line ? `Plus de ${line}` : `Moins de ${line}`
  };
}

// =====================
// 8. TIRS CADRES
// =====================
async function predictShotsOnTarget(matchId) {
  const stats = await getMatchStats(matchId);
  if (!stats) return null;

  const homeShots = stats.home?.shots_on_target ?? 0;
  const awayShots = stats.away?.shots_on_target ?? 0;
  const total = homeShots + awayShots;

  if (homeShots === 0 && awayShots === 0) return null;

  const line = 8.5;
  return {
    home: homeShots,
    away: awayShots,
    total,
    line,
    prediction: total > line ? `Plus de ${line}` : `Moins de ${line}`
  };
}

// =====================
// 9. SCORE EXACT
// =====================
async function predictExactScore(matchId) {
  try {
    const predictions = await requestFootball(`/matches/${matchId}/predictions`);
    const predData = predictions?.data;

    if (!predData?.correct_score) return null;

    const scores = Object.entries(predData.correct_score)
      .sort(([, a], [, b]) => b - a)
      .slice(0, 3)
      .map(([score, prob]) => ({
        score,
        probability: Math.round(prob * 100)
      }));

    return scores;
  } catch (error) {
    console.warn('Score exact indisponible:', error.message);
    return null;
  }
}

// =====================
// 10. PREDICTION COMPLETE
// =====================
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
// 11. COMMANDE SLASH
// =====================
const commandsData = [
  new SlashCommandBuilder()
    .setName('predire')
    .setDescription("Predit tous les marches d'un match.")
    .addStringOption(opt =>
      opt.setName('equipe_domicile').setDescription("L'equipe qui recoit.").setRequired(true))
    .addStringOption(opt =>
      opt.setName('equipe_exterieur').setDescription("L'equipe qui se deplace.").setRequired(true))
    .toJSON()
];

// =====================
// 12. MODE DEPLOY
// =====================
if (process.argv.includes('--deploy')) {
  const rest = new REST({ version: '10' }).setToken(BOT_TOKEN);
  try {
    console.log(`Enregistrement de ${commandsData.length} commande(s)...`);
    const data = await rest.put(
      Routes.applicationGuildCommands(CLIENT_ID, GUILD_ID),
      { body: commandsData }
    );
    console.log(`${data.length} commande(s) enregistree(s) avec succes.`);
  } catch (error) {
    console.error(error);
  }
  process.exit(0);
}

// =====================
// 13. CONSTRUCTION DE L'EMBED
// =====================
function buildPredictionEmbed(homeTeam, awayTeam, p) {
  const embed = new EmbedBuilder()
    .setTitle(`🔮 Prediction complete : ${homeTeam} vs ${awayTeam}`)
    .setColor(0x00ae86)
    .setTimestamp();

  embed.addFields({
    name: '📊 Resultat du match (1X2)',
    value: `🏠 ${homeTeam}: **${p.homeWinProb}%**\n🤝 Nul: **${p.drawProb}%**\n✈️ ${awayTeam}: **${p.awayWinProb}%**`,
    inline: false
  });

  if (p.totalGoals) {
    embed.addFields({
      name: '⚽ Total de buts',
      value: `Ligne ${p.totalGoals.line}\nPlus: **${p.totalGoals.overProb}%** (cote ${p.totalGoals.over})\nMoins: **${p.totalGoals.underProb}%** (cote ${p.totalGoals.under})`,
      inline: true
    });
  }

  if (p.btts) {
    embed.addFields({
      name: '🎯 Les 2 equipes marquent',
      value: `Oui: **${p.btts.yesProb}%** (cote ${p.btts.yes})\nNon: **${p.btts.noProb}%** (cote ${p.btts.no})`,
      inline: true
    });
  }

  if (p.corners) {
    embed.addFields({
      name: '🚩 Total corners',
      value: `Dom: ${p.corners.home} | Ext: ${p.corners.away}\nTotal: **${p.corners.total}**\n${p.corners.prediction}`,
      inline: true
    });
  }

  if (p.shots) {
    embed.addFields({
      name: '🎯 Tirs cadres',
      value: `Dom: ${p.shots.home} | Ext: ${p.shots.away}\nTotal: **${p.shots.total}**\n${p.shots.prediction}`,
      inline: true
    });
  }

  if (p.exactScore && p.exactScore.length > 0) {
    const scoresText = p.exactScore
      .map(s => `**${s.score}** (${s.probability}%)`)
      .join(' | ');
    embed.addFields({
      name: '🎲 Scores exacts probables',
      value: scoresText,
      inline: false
    });
  }

  if (p.odds) {
    embed.addFields({
      name: '💰 Cotes 1X2',
      value: `Dom: ${p.odds.home} | Nul: ${p.odds.draw} | Ext: ${p.odds.away}`,
      inline: false
    });
  }

  embed.setFooter({ text: "Base sur l'analyse de donnees et modeles IA." });
  return embed;
}

// =====================
// 14. EXECUTION COMMANDE
// =====================
async function executePredire(interaction) {
  const homeTeam = interaction.options.getString('equipe_domicile');
  const awayTeam = interaction.options.getString('equipe_exterieur');

  await interaction.deferReply();

  try {
    const prediction = await getFullPrediction(homeTeam, awayTeam);
    const embed = buildPredictionEmbed(homeTeam, awayTeam, prediction);
    await interaction.editReply({ embeds: [embed] });
  } catch (error) {
    console.error(error);
    await interaction.editReply(
      `❌ Impossible de generer une prediction pour **${homeTeam} vs ${awayTeam}**.\n> ${error.message}`
    );
  }
}

// =====================
// 15. CLIENT DISCORD
// =====================
const client = new Client({ intents: [GatewayIntentBits.Guilds] });
client.commands = new Collection();
client.commands.set('predire', { data: commandsData[0], execute: executePredire });

client.on(Events.InteractionCreate, async interaction => {
  if (!interaction.isChatInputCommand()) return;

  const command = client.commands.get(interaction.commandName);
  if (!command) return;

  try {
    await command.execute(interaction);
  } catch (error) {
    console.error(error);
    if (interaction.replied || interaction.deferred) {
      await interaction.followUp({ content: '❌ Une erreur est survenue.', ephemeral: true });
    } else {
      await interaction.reply({ content: '❌ Une erreur est survenue.', ephemeral: true });
    }
  }
});

client.once(Events.ClientReady, c => {
  console.log(`Pret ! Connecte en tant que ${c.user.tag}`);
});

client.login(BOT_TOKEN);

const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();
const { calculateMatchProbabilities } = require('./PredictionEngine');

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

  if (teams.length !== 2) {
    return "Usage : /predire <equipe1> <equipe2>\nExemple : /predire PSG Marseille";
  }

  const [homeTeamName, awayTeamName] = teams;

  try {
    const homeTeam = await prisma.team.findFirst({
      where: { name: { contains: homeTeamName, mode: 'insensitive' } }
    });
    const awayTeam = await prisma.team.findFirst({
      where: { name: { contains: awayTeamName, mode: 'insensitive' } }
    });

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

module.exports = { handlePredictCommand };

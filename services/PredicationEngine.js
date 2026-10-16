const { PrismaClient } = require('@prisma/client');
const prisma = new PrismaClient();

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

async function generatePredictions() {
  console.log('🧠 Démarrage du moteur de prédiction...');
  try {
    const matches = await prisma.match.findMany({
      where: { status: 'SCHEDULED', prediction: null },
      include: { homeTeam: true, awayTeam: true },
    });

    console.log(`📊 ${matches.length} matchs à analyser.`);

    for (const match of matches) {
      // Simulation : Avantage du terrain (1.5 buts pour domicile, 1.1 pour extérieur)
      const lambdaHome = 1.5 * 1.2; 
      const lambdaAway = 1.1;

      const probs = calculateMatchProbabilities(lambdaHome, lambdaAway);
      const maxProb = Math.max(probs.homeWin, probs.draw, probs.awayWin);

      let confidence = 'FAIBLE';
      let signal = 'AUCUN';

      if (maxProb >= 60) { confidence = 'HAUTE'; signal = 'TOP_PICK'; }
      else if (maxProb >= 50) { confidence = 'HAUTE'; signal = 'SIGNAL_FORT'; }
      else if (maxProb >= 40) { confidence = 'MOYENNE'; signal = 'SIGNAL_FAIBLE'; }

      const isPremium = signal === 'TOP_PICK' || signal === 'SIGNAL_FORT';

      await prisma.prediction.create({
        data: {
          matchId: match.id,
          probHomeWin: parseFloat(probs.homeWin.toFixed(2)),
          probDraw: parseFloat(probs.draw.toFixed(2)),
          probAwayWin: parseFloat(probs.awayWin.toFixed(2)),
          confidence, signal, isPremium,
        },
      });

      console.log(`✅ Prédiction : ${match.homeTeam.name} vs ${match.awayTeam.name} -> ${signal}`);
    }
  } catch (error) {
    console.error('❌ Erreur:', error);
  } finally {
    await prisma.$disconnect();
  }
}

if (require.main === module) generatePredictions();
module.exports = { generatePredictions, calculateMatchProbabilities };

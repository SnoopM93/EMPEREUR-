require('dotenv').config();
const express = require('express');
const axios = require('axios');
const TelegramBot = require('node-telegram-bot-api');

const API_KEY = process.env.API_FOOTBALL_KEY;
const TG_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const PORT = process.env.PORT || 3000;

const api = axios.create({
  baseURL: 'https://v3.football.api-sports.io',
  headers: { 'x-apisports-key': API_KEY },
  timeout: 15000
});

const app = express();
app.get('/', (req,res)=> res.send('JOKER TELEGRAM V8.2 - /predire /corners /buts /matchs ONLINE'));
app.listen(PORT, ()=> console.log(`Server ${PORT}`));

function poisson(lambda,k){ let f=1; for(let i=2;i<=k;i++) f*=i; return Math.exp(-lambda)*Math.pow(lambda,k)/f; }
function calcProbs(lH,lA){ let h=0,d=0,a=0; for(let i=0;i<=7;i++) for(let j=0;j<=7;j++){ const p=poisson(lH,i)*poisson(lA,j); if(i>j) h+=p; else if(i===j) d+=p; else a+=p; } const t=h+d+a; return {home:h/t*100, draw:d/t*100, away:a/t*100, over25:(1-(poisson(lH+lA,0)+poisson(lH+lA,1)+poisson(lH+lA,2)))*100}; }

async function getRealStats(teamId){
  try{
    const last = (await api.get(`/fixtures?team=${teamId}&last=5`)).data.response;
    let corners=[], scored=[], conceded=[];
    for(const f of last){
      const isHome=f.teams.home.id==teamId; const gH=f.goals.home, gA=f.goals.away; if(gH==null) continue;
      scored.push(isHome?gH:gA); conceded.push(isHome?gA:gH);
      await new Promise(r=>setTimeout(r,400));
      try{ const st=(await api.get(`/fixtures/statistics?fixture=${f.fixture.id}`)).data.response; for(const ts of st) if(ts.team.id==teamId) for(const s of ts.statistics) if(s.type=='Corner Kicks'&&s.value) corners.push(parseInt(s.value)); }catch{}
    }
    return {corner:corners.length?corners.reduce((a,b)=>a+b,0)/corners.length:4.5, scored:scored.length?scored.reduce((a,b)=>a+b,0)/scored.length:1.2, conceded:conceded.length?conceded.reduce((a,b)=>a+b,0)/conceded.length:1.2};
  }catch{ return {corner:4.5, scored:1.2, conceded:1.2}; }
}
async function findTeamId(name){ try{ const r=(await api.get(`/teams?search=${name.trim()}`)).data.response[0]; return r?{id:r.team.id, name:r.team.name}:null; }catch{ return null; } }
async function findNextDate(t1,t2){ try{ const f=(await api.get(`/fixtures?team=${t1}&next=10`)).data.response.find(x=>x.teams.home.id==t2||x.teams.away.id==t2); return f?new Date(f.fixture.date).toLocaleString('fr-FR',{day:'2-digit',month:'2-digit',hour:'2-digit',minute:'2-digit'})+" UTC":"A venir"; }catch{ return "A venir"; } }

async function buildAnalysis(query){
  const parts=query.split(/ vs | - | contre /i); const q1=parts[0]?.trim().split(' ')[0]||'PSG'; const q2=parts[1]?.trim().split(' ')[0]||'Marseille';
  const t1=await findTeamId(q1), t2=await findTeamId(q2);
  if(!t1||!t2) return {error:`❌ Equipe introuvable: ${!t1?q1:q2}. Ex: /predire Parma vs Torino`};
  const s1=await getRealStats(t1.id), s2=await getRealStats(t2.id); const dateStr=await findNextDate(t1.id,t2.id);
  const lambdaH=((s1.scored+s2.conceded)/2)*1.15, lambdaA=(s2.scored+s1.conceded)/2;
  const probs=calcProbs(lambdaH,lambdaA); const score=`${Math.round(lambdaH)}-${Math.round(lambdaA)}`;
  return {t1:t1.name, t2:t2.name, s1,s2, probs, corners:(s1.corner+s2.corner).toFixed(1), score, date:dateStr, lambdaH, lambdaA};
}

function formatFull(d){ return `*${d.t1} vs ${d.t2} - V8.2 FULL*\n\n📅 ${d.date}\n*Score:* (${d.s1.scored.toFixed(2)}+${d.s2.conceded.toFixed(2)})/2=${d.lambdaH.toFixed(2)} -> ${d.score.split('-')[0]}\n(${d.s2.scored.toFixed(2)}+${d.s1.conceded.toFixed(2)})/2=${d.lambdaA.toFixed(2)} -> ${d.score.split('-')[1]}\n*=> ${d.score}*\n\n*Odds Poisson:*\n🏠 ${d.t1}: ${d.probs.home.toFixed(1)}%\n🤝 Nul: ${d.probs.draw.toFixed(1)}%\n✈️ ${d.t2}: ${d.probs.away.toFixed(1)}%\n⚽ Over 2.5: ${d.probs.over25.toFixed(1)}%\n\n*Corners:* ${d.s1.corner.toFixed(1)}+${d.s2.corner.toFixed(1)}=${d.corners}\n_BTTS: ${d.s1.scored.toFixed(2)} & ${d.s2.scored.toFixed(2)}_`; }
function formatCorners(d){ return `*${d.t1} vs ${d.t2} - CORNERS V8.2*\n\n📅 ${d.date}\n\n🚩 *Corners reels 5 derniers:*\n${d.t1}: ${d.s1.corner.toFixed(2)} / match\n${d.t2}: ${d.s2.corner.toFixed(2)} / match\n\n*Total prevu:* ${d.corners} corners\n\n*Conseil:* Over ${(parseFloat(d.corners)-1).toFixed(1)} si >8.5 | Under si <8.5`; }
function formatButs(d){ return `*${d.t1} vs ${d.t2} - BUTS V8.2*\n\n📅 ${d.date}\n*Score reel:* ${d.score}\nLambda D: ${d.lambdaH.toFixed(2)} | E: ${d.lambdaA.toFixed(2)}\n\n*Buts:*\n${d.t1} marque ${d.s1.scored.toFixed(2)} encaisse ${d.s1.conceded.toFixed(2)}\n${d.t2} marque ${d.s2.scored.toFixed(2)} encaisse ${d.s2.conceded.toFixed(2)}\n\n*BTTS OUI:* ${(d.s1.scored>1 && d.s2.scored>1)?'OUI ✅':'NON ❌'} (${d.probs.home>30?'Risque':'Sur'})\n*Over 2.5:* ${d.probs.over25.toFixed(1)}%`; }

// --- BOT ---
const bot = new TelegramBot(TG_TOKEN, {polling:true});

bot.onText(/\/start/, (msg)=> bot.sendMessage(msg.chat.id, "🎯 *JOKER x ScoreCast V8.2*\n\nCommandes dispo:\n/predire X vs Y - Analyse complete\n/corners X vs Y - Que les corners\n/buts X vs Y - Que les buts / BTTS / Over\n/matchs X vs Y - Alias de /predire\n\nEx: /predire Parma vs Torino", {parse_mode:'Markdown'}));

async function handleCommand(msg, match, type){
  const chatId=msg.chat.id; const query=match[1];
  bot.sendChatAction(chatId,'typing');
  bot.sendMessage(chatId, `⏳ Analyse ${type} reelle...`);
  try{
    const data=await buildAnalysis(query);
    if(data.error) return bot.sendMessage(chatId,data.error);
    let out=formatFull(data); if(type==='corners') out=formatCorners(data); if(type==='buts') out=formatButs(data);
    bot.sendMessage(chatId, out, {parse_mode:'Markdown'});
  }catch(e){ bot.sendMessage(chatId, `Erreur: ${e.message}`); }
}

bot.onText(/\/predire (.+)/, (msg,m)=> handleCommand(msg,m,'full'));
bot.onText(/\/matchs (.+)/, (msg,m)=> handleCommand(msg,m,'full'));
bot.onText(/\/match (.+)/, (msg,m)=> handleCommand(msg,m,'full'));
bot.onText(/\/joker (.+)/, (msg,m)=> handleCommand(msg,m,'full'));
bot.onText(/\/corners (.+)/, (msg,m)=> handleCommand(msg,m,'corners'));
bot.onText(/\/buts (.+)/, (msg,m)=> handleCommand(msg,m,'buts'));

console.log('✅ TELEGRAM V8.2 READY - Toutes commandes JOKER OK');

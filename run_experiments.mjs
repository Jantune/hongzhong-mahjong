import { runTournament, formatTournamentReport } from './simulate_tournament.mjs';

console.log('=== PHASE 4A: PREDATOR VS GREEDY, QIDUI & CHAMPIONSHIP ===');
const phase4A = runTournament({
  lineup: ['Predator', 'Greedy', 'QiDui', 'Championship'],
  numMatches: 20,
  seedStart: 6060,
  cap: 32,
  bustThreshold: -300,
});

console.log(formatTournamentReport(phase4A, 'Phase 4A: 极速掠食流 (Predator) 决战大师全明星'));

console.log('\n=== PHASE 4B: PREDATOR VS GREEDY HEAD-TO-HEAD (2 vs 2) ===');
const phase4B = runTournament({
  lineup: ['Predator', 'Greedy', 'Predator', 'Greedy'],
  numMatches: 20,
  seedStart: 7070,
  cap: 32,
  bustThreshold: -300,
});

console.log(formatTournamentReport(phase4B, 'Phase 4B: Predator 与 Greedy 终极 2v2 巅峰对决'));




import test from 'node:test';
import assert from 'node:assert/strict';
import {
  applyAction,
  autoStep,
  createGame,
  DEAD_WALL_SIZE,
  indicatorToJoker,
  legalActions,
  nextRound,
  tileType,
  validateState,
  visibleState,
} from '../src/game.mjs';

function passAll(state) {
  let s = state;
  while (s.phase === 'reaction') {
    const p = Number(Object.keys(s.pending.responses).find(p0 => s.pending.responses[p0] === undefined));
    assert.ok(Number.isInteger(p));
    const pass = legalActions(s, p).find(a => a.kind === 'pass');
    assert.ok(pass, `seat ${p} should be able to pass`);
    s = applyAction(s, pass);
    validateState(s);
  }
  return s;
}

function constructedState({ dealer = 0, turn = dealer, indicatorType = 8, hands, melds = [[], [], [], []], specialKongs = [[], [], [], []], discards = [[], [], [], []], seed = 9000 }) {
  const pool = new Map(Array.from({ length: 34 }, (_, t) => [t, [0, 1, 2, 3].map(copy => t * 4 + copy)]));
  const take = (type, count = 1) => {
    const bucket = pool.get(type);
    assert.ok(bucket && bucket.length >= count, `insufficient physical copies for type ${type}`);
    return bucket.splice(0, count);
  };
  const indicator = take(indicatorType)[0];
  const takeHand = types => types.map(type => take(type)[0]);
  const physicalMelds = melds.map(groups => groups.map(group => ({
    kind: group.kind,
    tiles: group.types.flatMap(type => take(type)),
    open: !!group.open,
    kongType: group.kongType,
  })));
  const physicalSpecials = specialKongs.map(groups => groups.map(group => ({ kind: group.kind, tile: take(group.type)[0] })));
  const physicalDiscards = discards.map(types => types.flatMap(type => take(type)));
  const physicalHands = hands.map(takeHand);
  const wall = [...pool.values()].flat();
  const lastDraw = physicalHands[turn].at(-1);
  const state = {
    version: 3,
    rules: { cap: 50, seed, wallSize: 82 },
    phase: 'play', dealer, turn,
    round: 1,
    hands: physicalHands,
    melds: physicalMelds,
    specialKongs: physicalSpecials,
    discards: physicalDiscards,
    wall,
    indicator,
    indicatorType,
    joker: indicatorToJoker(indicatorType),
    pending: null,
    lastDraw,
    lastDrawPlayer: turn,
    lastDrawWallRemaining: wall.length,
    lastDrawHaidi: false,
    gangKai: false,
    scores: [0, 0, 0, 0],
    result: null,
    log: [],
    canSelfKong: [0, 1, 2, 3].map(p => p === turn),
  };
  validateState(state);
  return state;
}

test('初始牌堆、红中顺延和赖子循环', () => {
  for (let seed = 1; seed <= 100; seed += 1) {
    const state = createGame({ seed });
    // 136 − 53 张手牌 − 14 张王牌（含那张指示牌）= 69 张可摸
    assert.equal(state.wall.length, 136 - 53 - DEAD_WALL_SIZE);
    assert.equal(state.deadWall.length, DEAD_WALL_SIZE - 1);
    assert.notEqual(state.indicatorType, 31);
    assert.equal(state.hands[state.dealer].length, 14);
    for (let p = 0; p < 4; p += 1) if (p !== state.dealer) assert.equal(state.hands[p].length, 13);
    validateState(state);
  }
  assert.equal(indicatorToJoker(8), 0);
  assert.equal(indicatorToJoker(26), 18);
  assert.equal(indicatorToJoker(30), 32); // 北跳过红中到发
  assert.equal(indicatorToJoker(31), 32); // 红中本身只作顺延测试输入
  assert.equal(indicatorToJoker(33), 27);
});

test('普通摸牌走牌头，杠后补牌走王牌，反应阶段完整收口', () => {
  let state = createGame({ seed: 20260921 });
  const oldWall = [...state.wall];
  const head = state.wall[0];
  const dealer = state.dealer;
  const discard = legalActions(state, dealer).find(a => a.kind === 'discard');
  assert.ok(discard);
  state = applyAction(state, discard);
  assert.equal(state.phase, 'reaction');
  assert.equal(state.pending.kind, 'discard');
  assert.ok(Object.values(state.pending.responses).every(value => value === undefined));
  state = passAll(state);
  assert.equal(state.phase, 'play');
  // The old wall's head was consumed by the next player's ordinary draw.
  assert.deepEqual(state.wall, oldWall.slice(1));
  assert.ok(state.hands[(dealer + 1) % 4].includes(head));
  validateState(state);

  let kongSeed = 0;
  let before;
  let kongAction;
  for (let seed = 1; seed < 2000 && !kongAction; seed += 1) {
    const candidate = createGame({ seed });
    const actions = legalActions(candidate, candidate.dealer);
    const found = actions.find(a => ['skinKong', 'jokerKong', 'concealedKong'].includes(a.kind));
    if (found) { kongSeed = seed; before = candidate; kongAction = found; }
  }
  assert.ok(kongAction, 'deterministic seeds should expose an initial kong');
  const tail = before.wall.at(-1);
  const afterKong = applyAction(before, kongAction);
  assert.equal(afterKong.phase, 'play');
  // 杠后补牌从王牌取，牌墙尾部那张挪进王牌顶上——王牌张数恒定，可摸牌少一张。
  assert.deepEqual(afterKong.wall, before.wall.slice(0, -1));
  assert.equal(afterKong.lastDraw, before.deadWall[0]);
  assert.deepEqual(afterKong.deadWall, [...before.deadWall.slice(1), tail]);
  assert.equal(afterKong.deadWall.length, before.deadWall.length);
  validateState(afterKong);
  assert.ok(kongSeed > 0);
});

test('AI 实际走过吃、碰、明杠、暗杠、皮赖杠和蓄杠抢杠待回应', () => {
  const seen = new Set();
  let addedPending = null;
  for (let seed = 1000; seed < 1200 && (!seen.has('chi') || !seen.has('pong') || !seen.has('exposedKong') || !seen.has('concealedKong') || !seen.has('skinKong') || !seen.has('jokerKong') || !addedPending); seed += 1) {
    let state = createGame({ seed });
    let steps = 0;
    while (state.phase !== 'done' && steps++ < 400 && (!seen.has('chi') || !seen.has('pong') || !seen.has('exposedKong') || !seen.has('concealedKong') || !seen.has('skinKong') || !seen.has('jokerKong') || !addedPending)) {
      if (state.phase === 'reaction') {
        const p = Number(Object.keys(state.pending.responses).find(p0 => state.pending.responses[p0] === undefined));
        const actions = legalActions(state, p);
        for (const kind of ['chi', 'pong', 'exposedKong']) if (actions.some(a => a.kind === kind)) seen.add(kind);
        state = autoStep(state);
      } else {
        const actions = legalActions(state, state.turn);
        for (const kind of ['concealedKong', 'skinKong', 'jokerKong', 'addedKong']) if (actions.some(a => a.kind === kind)) seen.add(kind);
        const added = actions.find(a => a.kind === 'addedKong');
        if (added && !addedPending) {
          state = applyAction(state, added);
          addedPending = state;
          validateState(state);
          break;
        }
        state = autoStep(state);
      }
      validateState(state);
    }
  }
  for (const kind of ['chi', 'pong', 'exposedKong', 'concealedKong', 'skinKong', 'jokerKong']) assert.ok(seen.has(kind), `missing ${kind}`);
  assert.ok(addedPending, 'should encounter an added kong');
  assert.equal(addedPending.phase, 'play');
  assert.equal(addedPending.pending, null);
  const owner = addedPending.turn;
  assert.ok(addedPending.melds[owner].some(m => m.kongType === 'added'));
  validateState(addedPending);
});

test('可见状态不泄露暗手，伪造动作被拒绝', () => {
  const state = createGame({ seed: 7 });
  const view = visibleState(state, state.dealer);
  for (const [p, hand] of view.hands.entries()) if (p !== state.dealer) assert.ok(hand.every(tile => tile === null));
  assert.equal(typeof view.wall, 'number');
  assert.doesNotThrow(() => autoStep(state));
  const forbidden = state.hands[state.dealer].find(id => tileType(id) === state.indicatorType || tileType(id) === 31);
  if (forbidden !== undefined) assert.throws(() => applyAction(state, { kind: 'discard', player: state.dealer, tile: forbidden }));
  assert.throws(() => applyAction(state, { kind: 'discard', player: (state.dealer + 1) % 4, tile: state.hands[state.dealer][0] }));
});

test('庄家胡或荒庄连庄，闲家胡换庄', () => {
  const state = createGame({ seed: 11, dealer: 2 });
  const dealerWin = structuredClone(state);
  dealerWin.phase = 'done';
  dealerWin.result = { type: 'win', winner: 2, deltas: [0, 0, 0, 0], scores: [...state.scores] };
  assert.equal(nextRound(dealerWin).dealer, 2);
  const otherWin = structuredClone(dealerWin);
  otherWin.result.winner = 1;
  assert.equal(nextRound(otherWin).dealer, 3);
  const draw = structuredClone(dealerWin);
  draw.result = { type: 'draw', winner: null, deltas: [0, 0, 0, 0], scores: [...state.scores] };
  assert.equal(nextRound(draw).dealer, 2);
});

test('220 局批量 AI 每步守恒并产生正常胡牌', () => {
  let wins = 0;
  let draws = 0;
  let longest = 0;
  for (let z = 0; z < 220; z += 1) {
    let state = createGame({ seed: 1000 + z });
    let steps = 0;
    while (state.phase !== 'done' && steps++ < 2000) {
      state = autoStep(state);
      validateState(state);
    }
    assert.ok(steps < 2000, `seed ${z} deadlock`);
    longest = Math.max(longest, steps);
    if (state.result.type === 'win') wins += 1;
    else if (state.result.type === 'draw') draws += 1;
    else assert.fail(`unknown result at seed ${z}`);
  }
  console.log(`AI 批量结果：正常胡 ${wins} 局，荒庄 ${draws} 局，最长 ${longest} 步`);
  assert.ok(wins > 0, '不能用全荒庄掩盖状态机问题');
  assert.equal(wins + draws, 220);
});

test('排除抢杠：蓄杠直接成杠并从牌尾补牌', () => {
  const state = constructedState({
    dealer: 0,
    turn: 0,
    hands: [
      [4, 5, 6, 9, 10, 11, 18, 19, 20, 22, 27],
      [1, 2, 3, 4, 5, 6, 9, 10, 11, 18, 19, 20, 0],
      [7, 9, 10, 11, 12, 13, 14, 15, 16, 18, 19, 20, 21],
      [22, 23, 24, 25, 26, 28, 29, 30, 32, 33, 4, 5, 6],
    ],
    melds: [[{ kind: 'pong', types: [27, 27, 27], open: true }], [], [], []],
  });
  const added = legalActions(state, 0).find(action => action.kind === 'addedKong');
  assert.ok(added);
  const wallBefore = [...state.wall];
  const afterKong = applyAction(state, added);
  assert.equal(afterKong.phase, 'play');
  assert.equal(afterKong.pending, null);
  validateState(afterKong);
  assert.equal(afterKong.wall.length, wallBefore.length - 1);
  assert.equal(afterKong.melds[0][0].kind, 'kong');
  assert.equal(afterKong.melds[0][0].kongType, 'added');
  assert.equal(afterKong.melds[0][0].tiles.length, 4);
  assert.equal(afterKong.gangKai, true);
});

test('吃碰后手持皮子或赖子均可开杠', () => {
  const state = createGame({ seed: 42 });
  state.phase = 'play';
  state.turn = 0;
  state.canSelfKong = [false, false, false, false];
  state.hands[0].push(124); // 红中 (皮牌)
  const actions = legalActions(state, 0);
  const skinKong = actions.find(a => a.kind === 'skinKong');
  assert.ok(skinKong, 'should allow skinKong even when canSelfKong is false');
});

test('局终 visibleState 完整展示所有玩家手牌', () => {
  const state = createGame({ seed: 7 });
  state.phase = 'done';
  state.result = { type: 'win', winner: 1, deltas: [0, 0, 0, 0], scores: [...state.scores] };
  const view = visibleState(state, 0);
  for (let p = 0; p < 4; p++) {
    assert.ok(view.hands[p].every(tile => tile !== null), `p${p} hand should not be null on done`);
  }
});

test('构造一炮单响按庄家逆时针顺位选择，多家提交也只结算一人', () => {
  const state = constructedState({
    dealer: 2,
    turn: 0,
    hands: [
      [2, 4, 5, 6, 9, 10, 11, 12, 13, 14, 18, 19, 20, 1],
      [3, 4, 5, 9, 10, 11, 12, 13, 14, 1],
      [3, 4, 5, 9, 10, 11, 12, 13, 14, 1],
      [22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33, 3, 7],
    ],
    // 两家都已开口（这条用例原本为了绕开「门清软屁胡不能捉铳」而加）
    melds: [[], [{ kind: 'chi', types: [18, 19, 20], open: true }], [{ kind: 'chi', types: [18, 19, 20], open: true }], []],
    specialKongs: [[{ kind: 'skin', type: 31 }], [], [], []],
    seed: 9001,
  });
  const discard = legalActions(state, 0).find(action => action.kind === 'discard' && tileType(action.tile) === 1);
  assert.ok(discard);
  let pending = applyAction(state, discard);
  assert.equal(pending.phase, 'reaction');
  assert.ok(legalActions(pending, 1).some(action => action.kind === 'win'));
  assert.ok(legalActions(pending, 2).some(action => action.kind === 'win'));
  pending = applyAction(pending, { kind: 'win', player: 1, tile: pending.pending.tile });
  pending = applyAction(pending, { kind: 'win', player: 2, tile: pending.pending.tile });
  const done = applyAction(pending, { kind: 'pass', player: 3 });
  validateState(done);
  assert.equal(done.result.winner, 2);
  assert.deepEqual(done.result.score.payments, [4, 0, 0, 0]);
  assert.equal(done.result.score.total, 4);
});

test('构造同牌碰压吃：两种响应均提交后选择碰，吃家手牌不减少', () => {
  const state = constructedState({
    dealer: 0,
    turn: 0,
    hands: [
      [2, 4, 5, 6, 9, 10, 11, 12, 13, 14, 18, 19, 20, 1],
      [2, 3, 4, 5, 6, 9, 10, 11, 12, 13, 14, 18, 19],
      [1, 1, 4, 5, 6, 9, 10, 11, 12, 13, 14, 18, 19],
      [20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30, 32, 33],
    ],
    seed: 9002,
  });
  const discard = legalActions(state, 0).find(action => action.kind === 'discard' && tileType(action.tile) === 1);
  assert.ok(discard);
  let pending = applyAction(state, discard);
  const chi = legalActions(pending, 1).find(action => action.kind === 'chi');
  const pong = legalActions(pending, 2).find(action => action.kind === 'pong');
  assert.ok(chi);
  assert.ok(pong);
  pending = applyAction(pending, chi);
  pending = applyAction(pending, pong);
  pending = applyAction(pending, { kind: 'pass', player: 3 });
  validateState(pending);
  assert.equal(pending.phase, 'play');
  assert.equal(pending.turn, 2);
  assert.equal(pending.hands[1].length, 13);
  assert.equal(pending.melds[1].length, 0);
  assert.equal(pending.melds[2].at(-1).kind, 'pong');
  assert.equal(pending.melds[2].at(-1).tiles.length, 3);
});

test('王牌恒定 14 张，且整局结束后确有牌从未出现在牌局里', () => {
  let checkedRounds = 0;
  let leftoverMin = Infinity;
  for (let seed = 500; seed < 520; seed += 1) {
    let state = createGame({ seed });
    const startDead = state.deadWall.length;
    assert.equal(startDead, DEAD_WALL_SIZE - 1);
    let steps = 0;
    while (state.phase !== 'done' && steps++ < 600) {
      state = autoStep(state);
      // 补牌会从牌墙尾部回补，所以王牌张数全程不变
      assert.equal(state.deadWall.length, startDead, '王牌张数应当恒定');
      validateState(state);
    }
    if (state.phase !== 'done') continue;
    checkedRounds += 1;
    // 局终时王牌里的牌 + 指示牌都没进过任何人的手牌/副露/牌河
    const played = new Set([
      ...state.hands.flat(),
      ...state.melds.flat().flatMap(m => m.tiles),
      ...state.specialKongs.flat().map(k => k.tile),
      ...state.discards.flat(),
    ]);
    for (const id of state.deadWall) assert.ok(!played.has(id), '王牌不该出现在牌局里');
    assert.ok(!played.has(state.indicator), '指示牌不该出现在牌局里');
    leftoverMin = Math.min(leftoverMin, state.deadWall.length + 1);
  }
  assert.ok(checkedRounds >= 10, '应当跑完足够多的整局');
  assert.equal(leftoverMin, DEAD_WALL_SIZE);
});

test('补杠不限这一巡摸到的牌：早先留着的第四张也能补，刚碰完还没摸牌时不能补', () => {
  const state = constructedState({
    dealer: 0,
    turn: 0,
    hands: [
      [1, 2, 3, 10, 11, 12, 19, 20, 21, 26, 5],   // 九筒早就在手里，这一巡摸的是六万
      [22, 23, 24, 25, 27, 28, 29, 30, 32, 33, 13, 14, 15],
      [13, 14, 15, 16, 17, 18, 27, 28, 29, 30, 32, 33, 22],
      [4, 4, 6, 6, 7, 7, 9, 9, 16, 16, 17, 17, 18],
    ],
    melds: [[{ kind: 'pong', types: [26, 26, 26], open: true }], [], [], []],
  });
  assert.equal(tileType(state.lastDraw), 5, '这一巡摸到的是六万，不是九筒');
  const added = legalActions(state, 0).find(a => a.kind === 'addedKong');
  assert.ok(added, '手里早先留着的九筒应当可以补杠');
  assert.equal(tileType(added.tile), 26);
  const after = applyAction(state, added);
  validateState(after);
  assert.equal(after.melds[0][0].kind, 'kong');
  assert.equal(after.melds[0][0].tiles.length, 4);
  assert.equal(after.gangKai, true, '补杠后从王牌补一张，可能杠上开花');
  // 刚碰完、还没摸牌：不能补杠
  const justPonged = { ...state, canSelfKong: [false, false, false, false] };
  assert.ok(!legalActions(justPonged, 0).some(a => a.kind === 'addedKong'));
});

test('封顶热更新：牌局中途改封顶，胡牌时按新封顶结算，结果里记下所用的封顶', () => {
  const make = () => constructedState({
    dealer: 0,
    turn: 0,
    hands: [
      [16, 18, 19, 20, 21, 22, 23, 24, 25, 26, 27, 28, 29, 30],
      [9, 9, 9, 10, 10, 10, 11, 11, 11, 13, 13, 13, 16],   // 条子清一色碰碰胡，单钓八条
      [3, 4, 5, 6, 7, 3, 4, 5, 6, 7, 27, 28, 29],
      [12, 12, 14, 14, 15, 15, 17, 17, 32, 32, 33, 33, 30],
    ],
  });
  const winAfterDiscard = (state) => {
    const discard = legalActions(state, 0).find(a => a.kind === 'discard' && tileType(a.tile) === 16);
    const pending = applyAction(state, discard);
    const win = legalActions(pending, 1).find(a => a.kind === 'win');
    assert.ok(win, '东家应当能胡八条');
    let done = applyAction(pending, win);
    for (const p of [2, 3]) if (done.phase === 'reaction') done = applyAction(done, { kind: 'pass', player: p });
    return done;
  };
  // 对照：50 封顶，胡家 ×128 达到封顶 → 三家各付 50 + 未开口半顶 25
  const at50 = winAfterDiscard(make());
  assert.deepEqual(at50.result.score.payments, [75, 0, 75, 75]);
  assert.equal(at50.result.cap, 50);
  // 中途把封顶改成 10（界面热更新做的就是改 rules.cap）
  const s = make();
  s.rules.cap = 10;
  const at10 = winAfterDiscard(s);
  assert.deepEqual(at10.result.score.payments, [15, 0, 15, 15], '按新封顶 10 + 半顶 5 结算');
  assert.equal(at10.result.cap, 10);
  assert.equal(nextRound(at10).rules.cap, 10, '下一局沿用新封顶');
});

'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');

// ─── Load & deduplicate questions ────────────────────────────────────────────
const rawQ = require('./data/questions');
const _seen = new Set();
const QUESTIONS = rawQ.filter(q => {
  if (_seen.has(q.q)) return false;
  _seen.add(q.q);
  return true;
});
console.log(`Fragen geladen: ${QUESTIONS.length} (${rawQ.length - QUESTIONS.length} Duplikate entfernt)`);

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

app.use(express.static(path.join(__dirname, 'public')));
app.get('/host', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'host.html'))
);

// ─── Game state ───────────────────────────────────────────────────────────────
function freshState() {
  return {
    phase:         'lobby',
    players:       [],
    question:      null,
    usedQ:         new Set(),
    timer:         { rem: 180, total: 180, running: false },
    timerDone:     false,   // true when timer expired but current Q not judged yet
    votes:         {},
    voted:         [],
    tiebreak:      [],
    eliminated:    null,
    finals:        null,
    winner:        null,
    currentPlayer: null,
    roundHistory:  [],
  };
}

function nextAlivePlayer() {
  const alive = G.players.filter(p => p.alive);
  if (!alive.length) return null;
  const idx = alive.findIndex(p => p.name === G.currentPlayer);
  return alive[(idx + 1) % alive.length].name;
}

let G         = freshState();
let timerTick = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function pickQ() {
  const avail = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    if (!G.usedQ.has(i)) avail.push(i);
  }
  if (!avail.length) { G.usedQ = new Set(); return pickQ(); }
  const i = avail[Math.floor(Math.random() * avail.length)];
  G.usedQ.add(i);
  return QUESTIONS[i];
}

function pickN(n) {
  const arr = [];
  for (let k = 0; k < n; k++) arr.push(pickQ());
  return arr;
}

function toClient() {
  return {
    phase:         G.phase,
    players:       G.players,
    question:      G.question,
    timer:         G.timer,
    timerDone:     G.timerDone,
    votes:         G.votes,
    voted:         G.voted,
    tiebreak:      G.tiebreak,
    eliminated:    G.eliminated,
    finals:        G.finals,
    winner:        G.winner,
    qUsed:         G.usedQ.size,
    currentPlayer: G.currentPlayer,
    roundHistory:  G.roundHistory,
  };
}

function pub() { io.emit('S', toClient()); }

function stopTimer() {
  if (timerTick) { clearInterval(timerTick); timerTick = null; }
  G.timer.running = false;
}

function startTimer() {
  stopTimer();
  G.timer.running = true;
  timerTick = setInterval(() => {
    G.timer.rem--;
    if (G.timer.rem <= 0) {
      G.timer.rem = 0;
      stopTimer();
      // ⚠️ Do NOT auto-transition to voting.
      // Set timerDone = true so host must judge current question first.
      if (G.phase === 'question') {
        G.timerDone = true;
      }
    }
    pub();
  }, 1000);
}

function tally(pool) {
  const counts = {};
  pool.forEach(n => { counts[n] = 0; });
  Object.values(G.votes).forEach(t => {
    if (counts[t] !== undefined) counts[t]++;
  });
  return counts;
}

function applyLoss(loserName) {
  const p = G.players.find(x => x.name === loserName);
  if (!p) return;
  p.hearts = Math.max(0, p.hearts - 1);
  if (p.hearts === 0) p.alive = false;
  G.eliminated = { name: loserName, heartsLeft: p.hearts, isOut: !p.alive };
  const alive = G.players.filter(x => x.alive);
  if (alive.length <= 1) {
    G.winner = alive.length ? alive[0].name : loserName;
    G.phase  = 'gameover';
  } else {
    G.phase = 'elimination';
  }
  pub();
}

// ─── Socket handlers ──────────────────────────────────────────────────────────
io.on('connection', socket => {
  socket.emit('S', toClient());

  /* ── LOBBY ── */
  socket.on('addPlayer', name => {
    if (G.phase !== 'lobby') return;
    name = (name || '').trim();
    if (!name || name.length > 20) return;
    if (G.players.find(p => p.name === name)) return;
    G.players.push({ name, hearts: 3, alive: true });
    pub();
  });

  socket.on('removePlayer', name => {
    if (G.phase !== 'lobby') return;
    G.players = G.players.filter(p => p.name !== name);
    pub();
  });

  socket.on('startGame', () => {
    if (G.phase !== 'lobby' || G.players.length < 2) return;
    G.currentPlayer = G.players[0].name;
    G.question      = pickQ();
    G.roundHistory  = [];
    G.timerDone     = false;
    G.phase         = 'question';
    G.timer         = { rem: 180, total: 180, running: true };
    startTimer();
    pub();
  });

  /* ── QUESTION / TIMER ── */
  socket.on('pauseTimer', () => {
    if (G.phase !== 'question' || !G.timer.running) return;
    stopTimer();
    pub();
  });

  socket.on('resumeTimer', () => {
    if (G.phase !== 'question' || G.timer.running || G.timer.rem <= 0) return;
    startTimer();
    pub();
  });

  // Host marks answer as correct/wrong → next question OR transition to voting if timer done
  socket.on('markAnswer', correct => {
    if (G.phase !== 'question' || !G.question) return;
    G.roundHistory.push({
      player:  G.currentPlayer,
      q:       G.question.q,
      a:       G.question.a,
      correct: !!correct,
    });

    if (G.timerDone) {
      // Timer already expired → go to voting after judging this question
      G.timerDone = false;
      G.phase     = 'voting';
      G.votes     = {};
      G.voted     = [];
      G.tiebreak  = [];
    } else {
      // Timer still running → next player, next question
      G.currentPlayer = nextAlivePlayer();
      G.question      = pickQ();
    }
    pub();
  });

  // Manual early voting start (skips current question without judging)
  socket.on('startVoting', () => {
    if (G.phase !== 'question') return;
    stopTimer();
    G.timerDone = false;
    G.phase     = 'voting';
    G.votes     = {};
    G.voted     = [];
    G.tiebreak  = [];
    pub();
  });

  /* ── VOTING ── */
  socket.on('vote', ({ voter, target }) => {
    if (!['voting', 'tiebreak'].includes(G.phase)) return;
    if (G.voted.includes(voter)) return;
    const alive = G.players.filter(p => p.alive).map(p => p.name);
    if (!alive.includes(voter) || voter === target) return;
    const pool = G.phase === 'tiebreak' ? G.tiebreak : alive;
    if (!pool.includes(target)) return;
    G.votes[voter] = target;
    G.voted.push(voter);
    pub();
  });

  // Host resets the current vote round (clears all votes, players can vote again)
  socket.on('resetVotes', () => {
    if (!['voting', 'tiebreak'].includes(G.phase)) return;
    G.votes  = {};
    G.voted  = [];
    pub();
  });

  // Host resets a single player's vote so they can vote again
  socket.on('resetVote', name => {
    if (!['voting', 'tiebreak'].includes(G.phase)) return;
    delete G.votes[name];
    G.voted = G.voted.filter(v => v !== name);
    pub();
  });

  socket.on('resolveVotes', () => {
    if (!['voting', 'tiebreak'].includes(G.phase)) return;
    const pool   = G.phase === 'tiebreak' ? G.tiebreak
                                           : G.players.filter(p => p.alive).map(p => p.name);
    const counts = tally(pool);
    const max    = Math.max(0, ...Object.values(counts));

    if (max === 0) {
      const alive = G.players.filter(p => p.alive);
      return applyLoss(alive[Math.floor(Math.random() * alive.length)].name);
    }

    const losers = Object.keys(counts).filter(k => counts[k] === max);
    if (losers.length > 1) {
      G.phase    = 'tiebreak';
      G.tiebreak = losers;
      G.votes    = {};
      G.voted    = [];
      pub();
    } else {
      applyLoss(losers[0]);
    }
  });

  /* ── ELIMINATION → NEXT ── */
  socket.on('nextRound', () => {
    if (G.phase !== 'elimination') return;
    const alive = G.players.filter(p => p.alive);

    if (alive.length === 2) {
      G.finals = {
        playerA: alive[0].name, playerB: alive[1].name,
        questions: pickN(10), qIdx: 0, current: alive[0].name,
        scoresA: [], scoresB: [], scoreA: 0, scoreB: 0,
        round: 1, subphase: 'A_answering',
      };
      G.phase      = 'finals';
      G.eliminated = null;
    } else {
      G.currentPlayer = nextAlivePlayer();
      G.question      = pickQ();
      G.roundHistory  = [];
      G.timerDone     = false;
      G.phase         = 'question';
      G.timer         = { rem: 180, total: 180, running: true };
      G.votes         = {};
      G.voted         = [];
      G.tiebreak      = [];
      G.eliminated    = null;
      startTimer();
    }
    pub();
  });

  /* ── FINALS ── */
  socket.on('judgeAnswer', correct => {
    if (G.phase !== 'finals' || !G.finals) return;
    const F = G.finals;
    if (F.current === F.playerA) F.scoresA.push(!!correct);
    else                          F.scoresB.push(!!correct);
    F.qIdx++;
    if (F.qIdx >= F.questions.length) {
      if (F.current === F.playerA) {
        F.current = F.playerB; F.qIdx = 0; F.subphase = 'B_answering';
      } else {
        F.scoreA = F.scoresA.filter(Boolean).length;
        F.scoreB = F.scoresB.filter(Boolean).length;
        F.subphase = 'results';
        if (F.scoreA !== F.scoreB) {
          G.winner = F.scoreA > F.scoreB ? F.playerA : F.playerB;
          G.phase  = 'gameover';
        }
      }
    }
    pub();
  });

  socket.on('finalsNextRound', () => {
    if (G.phase !== 'finals' || !G.finals) return;
    const F = G.finals;
    if (F.subphase !== 'results') return;
    F.round++; F.questions = pickN(10); F.qIdx = 0; F.current = F.playerA;
    F.scoresA = []; F.scoresB = []; F.scoreA = 0; F.scoreB = 0;
    F.subphase = 'A_answering';
    pub();
  });

  /* ── RESET ── */
  socket.on('resetGame', () => { stopTimer(); G = freshState(); pub(); });
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮  GoodToKnow läuft auf http://localhost:${PORT}`);
  console.log(`👑  Hostansicht:  http://localhost:${PORT}/host`);
  console.log(`👥  Spieleransicht: http://localhost:${PORT}/\n`);
});

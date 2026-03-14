'use strict';

const express  = require('express');
const http     = require('http');
const { Server } = require('socket.io');
const path     = require('path');
const QUESTIONS = require('./data/questions');

const app    = express();
const server = http.createServer(app);
const io     = new Server(server, { cors: { origin: '*' } });

// ─── Static files ────────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

app.get('/host', (_req, res) =>
  res.sendFile(path.join(__dirname, 'public', 'host.html'))
);

// ─── Game state ───────────────────────────────────────────────────────────────
/*
  Phases:
    lobby       → Spieler hinzufügen
    question    → Frage + Timer
    voting      → Abstimmung läuft
    tiebreak    → Unentschieden-Abstimmung
    elimination → Ergebnis zeigen (Herz verloren / raus)
    finals      → Finale (subphase: A_answering | B_answering | results)
    gameover    → Gewinner feststehen
*/

function freshState() {
  return {
    phase:     'lobby',
    players:   [],           // [{name, hearts, alive}]
    question:  null,         // {q, a}
    usedQ:     new Set(),
    timer:     { rem: 180, total: 180, running: false },
    votes:     {},           // {voter: target}
    voted:     [],           // names that already voted
    tiebreak:  [],           // names in tiebreak round
    eliminated: null,        // {name, heartsLeft, isOut}
    finals:    null,
    winner:    null,
  };
}

/*
  finals shape:
  {
    playerA, playerB,
    questions: [{q,a}, ...],
    qIdx: number,
    current: playerA | playerB,
    scoresA: [bool, ...],
    scoresB: [bool, ...],
    scoreA: number,   (set after B finishes)
    scoreB: number,
    round: number,
    subphase: 'A_answering' | 'B_answering' | 'results'
  }
*/

let G          = freshState();
let timerTick  = null;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function pickQ() {
  const avail = [];
  for (let i = 0; i < QUESTIONS.length; i++) {
    if (!G.usedQ.has(i)) avail.push(i);
  }
  if (!avail.length) {
    G.usedQ = new Set();
    return pickQ();
  }
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
  // Convert Set to a plain count so JSON.stringify works
  return {
    phase:     G.phase,
    players:   G.players,
    question:  G.question,
    timer:     G.timer,
    votes:     G.votes,
    voted:     G.voted,
    tiebreak:  G.tiebreak,
    eliminated: G.eliminated,
    finals:    G.finals,
    winner:    G.winner,
    qUsed:     G.usedQ.size,
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
      // Auto-transition to voting when timer hits 0
      if (G.phase === 'question') {
        G.phase   = 'voting';
        G.votes   = {};
        G.voted   = [];
        G.tiebreak = [];
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
    G.question = pickQ();
    G.phase    = 'question';
    G.timer    = { rem: 180, total: 180, running: true };
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

  socket.on('startVoting', () => {
    if (G.phase !== 'question') return;
    stopTimer();
    G.phase    = 'voting';
    G.votes    = {};
    G.voted    = [];
    G.tiebreak = [];
    pub();
  });

  /* ── VOTING (player & host) ── */
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

  socket.on('resolveVotes', () => {
    if (!['voting', 'tiebreak'].includes(G.phase)) return;
    const pool   = G.phase === 'tiebreak' ? G.tiebreak
                                           : G.players.filter(p => p.alive).map(p => p.name);
    const counts = tally(pool);
    const max    = Math.max(0, ...Object.values(counts));

    // If nobody voted → pick a random player to lose
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
      // → Finale
      G.finals = {
        playerA:  alive[0].name,
        playerB:  alive[1].name,
        questions: pickN(10),
        qIdx:     0,
        current:  alive[0].name,
        scoresA:  [],
        scoresB:  [],
        scoreA:   0,
        scoreB:   0,
        round:    1,
        subphase: 'A_answering',
      };
      G.phase      = 'finals';
      G.eliminated = null;
    } else {
      G.question   = pickQ();
      G.phase      = 'question';
      G.timer      = { rem: 180, total: 180, running: true };
      G.votes      = {};
      G.voted      = [];
      G.tiebreak   = [];
      G.eliminated = null;
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
        // Switch to Player B
        F.current  = F.playerB;
        F.qIdx     = 0;
        F.subphase = 'B_answering';
      } else {
        // Both players done
        F.scoreA   = F.scoresA.filter(Boolean).length;
        F.scoreB   = F.scoresB.filter(Boolean).length;
        F.subphase = 'results';

        if (F.scoreA !== F.scoreB) {
          G.winner = F.scoreA > F.scoreB ? F.playerA : F.playerB;
          G.phase  = 'gameover';
        }
        // If tied: wait for host to start new finals round
      }
    }
    pub();
  });

  socket.on('finalsNextRound', () => {
    if (G.phase !== 'finals' || !G.finals) return;
    const F = G.finals;
    if (F.subphase !== 'results') return;
    F.round++;
    F.questions = pickN(10);
    F.qIdx      = 0;
    F.current   = F.playerA;
    F.scoresA   = [];
    F.scoresB   = [];
    F.scoreA    = 0;
    F.scoreB    = 0;
    F.subphase  = 'A_answering';
    pub();
  });

  /* ── RESET ── */
  socket.on('resetGame', () => {
    stopTimer();
    G = freshState();
    pub();
  });
});

// ─── Start ────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`\n🎮  GoodToKnow läuft auf http://localhost:${PORT}`);
  console.log(`👑  Hostansicht:  http://localhost:${PORT}/host`);
  console.log(`👥  Spieleransicht: http://localhost:${PORT}/\n`);
});

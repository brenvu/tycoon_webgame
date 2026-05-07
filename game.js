// ============================================================
// TYCOON — Core Game State Machine
// ============================================================

const RANKS_ORDER = ['tycoon', 'rich', 'commoner', 'beggar'];
const POINTS = { tycoon: 30, rich: 20, commoner: 10, beggar: 0 };

const GamePhase = {
  LOBBY: 'lobby',
  EXCHANGE: 'exchange',
  PLAYING: 'playing',
  ROUND_END: 'round_end',
  GAME_OVER: 'game_over'
};

class TycoonGame {
  constructor() {
    this.reset();
  }

  reset() {
    this.phase = GamePhase.LOBBY;
    this.players = [];       // [{id, nickname, avatar, rank, score, hand, finishOrder}]
    this.round = 1;
    this.totalRounds = 3;
    this.currentTurn = 0;   // player index
    this.pile = [];          // all cards played this "trick"
    this.currentPlay = null; // {cards, count, topStrength, playerId}
    this.passCount = 0;
    this.revolutionActive = false;
    this.finishOrder = [];   // player indices in order they finished
    this.turnTimer = 90;
    this.timerInterval = null;
    this.exchangePending = []; // [{giverId, receiverId, count}]
    this.exchangesDone = new Set();
    this.localPlayerIndex = -1;
    this.hostIndex = 0;
    this.onStateChange = null; // callback
    this.onTurnTimeout = null;
    this.onRoundEnd = null;
    this.onGameOver = null;
    this.onActionLog = null;
    this.previousTycoon = -1;
    this.tycoonBankruptCheck = false;
  }

  // ---- Setup ----

  addPlayer(id, nickname, avatar) {
    if (this.players.length >= 4) return false;
    this.players.push({
      id, nickname, avatar,
      rank: 'commoner',
      score: 0,
      hand: [],
      finished: false,
      finishPosition: null,
      connected: true
    });
    return true;
  }

  startRound() {
    const deck = Cards.createDeck();
    const hands = Cards.dealCards(deck, this.players.length);

    this.players.forEach((p, i) => {
      p.hand = Cards.sortHand(hands[i], this.revolutionActive);
      p.finished = false;
      p.finishPosition = null;
    });

    this.pile = [];
    this.currentPlay = null;
    this.passCount = 0;
    this.revolutionActive = false;
    this.finishOrder = [];

    // First turn: player with 3♦
    this.currentTurn = Cards.findStartingPlayer(this.players.map(p => p.hand));
    this.phase = GamePhase.PLAYING;

    this._log(`Round ${this.round} started! ${this.players[this.currentTurn].nickname} goes first (has 3♦)`);
    this._notify();
    this.startTurnTimer();
  }

  // ---- Card Exchange (between rounds) ----

  setupExchange() {
    // Find ranks
    const tycoon  = this.players.find(p => p.rank === 'tycoon');
    const rich     = this.players.find(p => p.rank === 'rich');
    const commoner = this.players.find(p => p.rank === 'commoner');
    const beggar   = this.players.find(p => p.rank === 'beggar');

    this.exchangePending = [];
    this.exchangesDone = new Set();

    if (!tycoon || !rich || !commoner || !beggar) {
      // First round or < 4 players — no exchange
      this.startRound();
      return;
    }

    // Beggar must give 2 best cards to Tycoon
    this.exchangePending.push({ giverId: beggar.id,   receiverId: tycoon.id,  count: 2, giversChoice: false });
    // Commoner must give 1 best card to Rich
    this.exchangePending.push({ giverId: commoner.id, receiverId: rich.id,    count: 1, giversChoice: false });
    // Tycoon chooses 2 cards to give Beggar
    this.exchangePending.push({ giverId: tycoon.id,   receiverId: beggar.id,  count: 2, giversChoice: true  });
    // Rich chooses 1 card to give Commoner
    this.exchangePending.push({ giverId: rich.id,     receiverId: commoner.id,count: 1, giversChoice: true  });

    this.phase = GamePhase.EXCHANGE;
    this._notify();
  }

  getExchangeForPlayer(playerId) {
    return this.exchangePending.find(e => e.giverId === playerId && !this.exchangesDone.has(e.giverId + '->' + e.receiverId));
  }

  submitExchange(giverId, cards) {
    const exchange = this.exchangePending.find(e => e.giverId === giverId && !this.exchangesDone.has(e.giverId + '->' + e.receiverId));
    if (!exchange) return false;

    const giver = this.players.find(p => p.id === giverId);
    const receiver = this.players.find(p => p.id === exchange.receiverId);

    if (!giver || !receiver) return false;
    if (cards.length !== exchange.count) return false;

    // Remove from giver, add to receiver
    cards.forEach(card => {
      const idx = giver.hand.findIndex(c => c.id === card.id);
      if (idx !== -1) giver.hand.splice(idx, 1);
      receiver.hand.push(card);
    });

    giver.hand = Cards.sortHand(giver.hand, this.revolutionActive);
    receiver.hand = Cards.sortHand(receiver.hand, this.revolutionActive);

    this.exchangesDone.add(giverId + '->' + exchange.receiverId);
    this._log(`${giver.nickname} gave ${cards.length} card(s) to ${receiver.nickname}`);

    // Check if all exchanges done
    const allDone = this.exchangePending.every(e => this.exchangesDone.has(e.giverId + '->' + e.receiverId));
    if (allDone) {
      this.startRound();
    } else {
      this._notify();
    }
    return true;
  }

  // ---- Turn Logic ----

  startTurnTimer() {
    this.stopTurnTimer();
    this.turnTimer = 90;
    this.timerInterval = setInterval(() => {
      this.turnTimer--;
      this._notify();
      if (this.turnTimer <= 0) {
        this.stopTurnTimer();
        this._log(`${this.players[this.currentTurn].nickname} timed out! Auto-passing.`);
        this.pass(this.players[this.currentTurn].id);
      }
    }, 1000);
  }

  stopTurnTimer() {
    if (this.timerInterval) {
      clearInterval(this.timerInterval);
      this.timerInterval = null;
    }
  }

  isPlayerTurn(playerId) {
    return this.phase === GamePhase.PLAYING &&
      this.players[this.currentTurn]?.id === playerId &&
      !this.players[this.currentTurn]?.finished;
  }

  playCards(playerId, selectedCards) {
    if (!this.isPlayerTurn(playerId)) return { ok: false, reason: 'Not your turn.' };

    const player = this.players[this.currentTurn];
    const result = Cards.validatePlay(selectedCards, this.currentPlay, this.revolutionActive);

    if (!result.valid) return { ok: false, reason: result.reason };

    // Remove cards from hand
    selectedCards.forEach(card => {
      const idx = player.hand.findIndex(c => c.id === card.id);
      if (idx !== -1) player.hand.splice(idx, 1);
    });

    // Add to pile
    this.pile.push(...selectedCards);

    // Determine new topStrength
    const topStrength = Cards.getPlayStrength(selectedCards, this.revolutionActive);
    const newPlay = {
      cards: selectedCards,
      count: selectedCards.length,
      topStrength,
      playerId,
      playerName: player.nickname,
      isStop: result.isStop || false,
      is3Spades: result.is3Spades || false,
      isRevolution: result.isRevolution || false,
      allEights: selectedCards.every(c => Cards.is8Stop(c))
    };
    this.currentPlay = newPlay;

    const names = selectedCards.map(c => Cards.cardDisplayName(c)).join(', ');
    this._log(`${player.nickname} played: ${names}`);

    // Check Revolution
    if (result.isRevolution) {
      this.revolutionActive = !this.revolutionActive;
      this._log(`⚡ REVOLUTION! Card values are ${this.revolutionActive ? 'REVERSED' : 'RESTORED'}!`);
      // Re-sort all hands
      this.players.forEach(p => {
        p.hand = Cards.sortHand(p.hand, this.revolutionActive);
      });
    }

    // Check if 3♠ played (ends trick)
    if (result.is3Spades) {
      this._log(`3♠ SPADE REVERSAL! ${player.nickname} wins the trick!`);
      this.clearPile(this.currentTurn);
      this.checkPlayerFinished(this.currentTurn);
      this._notify();
      if (this.phase === GamePhase.PLAYING) this.startTurnTimer();
      return { ok: true };
    }

    // Check if 8 Stop
    if (newPlay.allEights) {
      this._log(`8 STOP! ${player.nickname} clears the pile and goes again!`);
      this.checkPlayerFinished(this.currentTurn);
      if (this.phase === GamePhase.PLAYING) {
        this.clearPile(this.currentTurn);
        this.startTurnTimer();
      }
      this._notify();
      return { ok: true };
    }

    // Check if player finished
    this.checkPlayerFinished(this.currentTurn);
    if (this.phase !== GamePhase.PLAYING) {
      this._notify();
      return { ok: true };
    }

    // Move to next player
    this.passCount = 0;
    this.advanceTurn();
    this._notify();
    this.startTurnTimer();
    return { ok: true };
  }

  pass(playerId) {
    if (!this.isPlayerTurn(playerId)) return;

    const player = this.players[this.currentTurn];
    this._log(`${player.nickname} passed.`);
    this.passCount++;

    // Count active (non-finished) players still in this trick
    const activePlayers = this.players.filter(p => !p.finished).length;

    // If all remaining players passed (except last player who played), clear pile
    if (this.passCount >= activePlayers - 1) {
      // Find who played last
      const lastPlayerId = this.currentPlay?.playerId;
      const lastPlayerIdx = this.players.findIndex(p => p.id === lastPlayerId);
      this._log(`All others passed. ${this.players[lastPlayerIdx]?.nickname || 'Someone'} wins the trick!`);
      this.clearPile(lastPlayerIdx !== -1 ? lastPlayerIdx : this.currentTurn);
    } else {
      this.advanceTurn();
      this._notify();
      this.startTurnTimer();
    }
  }

  clearPile(nextPlayerIdx) {
    this.pile = [];
    this.currentPlay = null;
    this.passCount = 0;
    this.currentTurn = nextPlayerIdx;

    // Skip finished players
    let attempts = 0;
    while (this.players[this.currentTurn]?.finished && attempts < this.players.length) {
      this.currentTurn = (this.currentTurn + 1) % this.players.length;
      attempts++;
    }
    this._notify();
    this.startTurnTimer();
  }

  advanceTurn() {
    let next = (this.currentTurn + 1) % this.players.length;
    let attempts = 0;
    while (this.players[next]?.finished && attempts < this.players.length) {
      next = (next + 1) % this.players.length;
      attempts++;
    }
    this.currentTurn = next;
  }

  checkPlayerFinished(playerIdx) {
    const player = this.players[playerIdx];
    if (player.hand.length === 0 && !player.finished) {
      player.finished = true;
      this.finishOrder.push(playerIdx);
      const pos = this.finishOrder.length;
      player.finishPosition = pos;
      this._log(`🏆 ${player.nickname} finished ${pos}${ordinal(pos)}!`);

      // Check if round is over (all but last player finished)
      const unfinished = this.players.filter(p => !p.finished);
      if (unfinished.length <= 1) {
        // Last player auto-finishes
        if (unfinished.length === 1) {
          unfinished[0].finished = true;
          this.finishOrder.push(this.players.indexOf(unfinished[0]));
          unfinished[0].finishPosition = this.finishOrder.length;
        }
        this.endRound();
      }
    }
  }

  // ---- Round End ----

  endRound() {
    this.stopTurnTimer();
    this.phase = GamePhase.ROUND_END;

    // Assign ranks based on finish order
    // 4 players: 1st=tycoon(30), 2nd=rich(20), 3rd=commoner(10), 4th=beggar(0)
    const rankNames = ['tycoon', 'rich', 'commoner', 'beggar'];
    // For < 4 players adapt
    const rankAssignment = this.finishOrder.map((playerIdx, pos) => {
      const rName = rankNames[pos] || 'beggar';
      return { playerIdx, rank: rName };
    });

    // Check tycoon bankruptcy rule
    if (this.round > 1) {
      const tycoonPlayer = this.players.find(p => p.rank === 'tycoon');
      if (tycoonPlayer) {
        const tycoonIdx = this.players.indexOf(tycoonPlayer);
        const finishedFirst = this.finishOrder[0] === tycoonIdx;
        if (!finishedFirst) {
          // Tycoon didn't maintain first place — bankruptcy!
          this._log(`💀 BANKRUPTCY! ${tycoonPlayer.nickname} (Tycoon) failed to maintain 1st place!`);
          // They become beggar regardless of finish position
          const assignment = rankAssignment.find(r => r.playerIdx === tycoonIdx);
          if (assignment) assignment.rank = 'beggar';
          // The one who would have been beggar gets their original rank back
        }
      }
    }

    // Apply ranks and points
    rankAssignment.forEach(({ playerIdx, rank }) => {
      const player = this.players[playerIdx];
      const pts = POINTS[rank] || 0;
      player.score += pts;
      player.rank = rank;
      this._log(`${player.nickname} → ${rank.toUpperCase()} (+${pts} pts)`);
    });

    // Special: "poor" rank for 4th place in 4-player
    // With 4 players: 1st=tycoon, 2nd=rich, 3rd=poor, 4th=beggar
    // Wait — re-check original: 1st=Tycoon, 2nd=Rich, 3rd=Beggar, 4th=Poor
    // Actually from the rules: 1st=Tycoon(30pts), 2nd=Rich(20pts), 3rd=Commoner(10pts), 4th=Beggar(0pts)
    // But rank names in exchange: Tycoon, Rich, Poor, Beggar
    // Let me re-map: rankNames = ['tycoon','rich','poor','beggar'] for exchange
    // and point winners = ['tycoon','rich','commoner','beggar'] for scoring
    // Per original request: "3rd is the Commoner gaining 10 points, Fourth is the Beggar gaining no points"
    // But exchange mentions "Poor" and "Commoner"... let me use the game image as source
    // Image shows: Tycoon, Rich, Poor, Beggar (4 ranks)
    // So re-do: rankNames = ['tycoon','rich','poor','beggar']
    // Points: tycoon=30, rich=20, poor=10(?), beggar=0
    // Actually description says "3rd is Commoner gaining 10" so I'll keep commoner for 3rd place rank
    // and the exchange involves: Tycoon/Rich give cards to Commoner/Beggar and vice versa

    this._notify();

    if (this.round >= this.totalRounds) {
      setTimeout(() => this.endGame(), 3000);
    } else {
      this.round++;
    }
  }

  endGame() {
    this.phase = GamePhase.GAME_OVER;
    this.stopTurnTimer();
    // Sort by score
    const sorted = [...this.players].sort((a, b) => b.score - a.score);
    this._log(`🎉 GAME OVER! Winner: ${sorted[0].nickname} with ${sorted[0].score} points!`);
    this._notify();
  }

  // ---- Helpers ----

  _log(msg) {
    if (this.onActionLog) this.onActionLog(msg);
  }

  _notify() {
    if (this.onStateChange) this.onStateChange(this.getState());
  }

  getState() {
    return {
      phase: this.phase,
      players: this.players.map(p => ({
        id: p.id,
        nickname: p.nickname,
        avatar: p.avatar,
        rank: p.rank,
        score: p.score,
        handCount: p.hand.length,
        finished: p.finished,
        finishPosition: p.finishPosition,
        connected: p.connected
      })),
      round: this.round,
      totalRounds: this.totalRounds,
      currentTurn: this.currentTurn,
      currentPlay: this.currentPlay,
      pile: this.pile,
      revolutionActive: this.revolutionActive,
      finishOrder: this.finishOrder,
      turnTimer: this.turnTimer,
      exchangePending: this.exchangePending,
      exchangesDone: [...this.exchangesDone],
      localPlayerIndex: this.localPlayerIndex
    };
  }

  getLocalHand() {
    if (this.localPlayerIndex < 0) return [];
    return this.players[this.localPlayerIndex]?.hand || [];
  }

  getExchangeInfo() {
    if (this.localPlayerIndex < 0) return null;
    const localId = this.players[this.localPlayerIndex]?.id;
    return this.getExchangeForPlayer(localId);
  }
}

function ordinal(n) {
  const s = ['th','st','nd','rd'];
  const v = n % 100;
  return (s[(v-20)%10] || s[v] || s[0]);
}

window.TycoonGame = TycoonGame;
window.GamePhase = GamePhase;

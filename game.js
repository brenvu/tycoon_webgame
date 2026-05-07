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
    this.onStateChange = null; 
    this.onActionLog = null;
    this.previousTycoon = -1;
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

  // ---- Card Exchange Logic ----

  setupExchange() {
    // FIX: Reset revolution state BEFORE sorting hands for the exchange
    this.revolutionActive = false;
    
    const tycoon  = this.players.find(p => p.rank === 'tycoon');
    const rich     = this.players.find(p => p.rank === 'rich');
    const commoner = this.players.find(p => p.rank === 'commoner');
    const beggar   = this.players.find(p => p.rank === 'beggar');

    this.exchangePending = [];
    this.exchangesDone = new Set();

    // Re-sort hands for everyone so ranks are standard (3 low, 2 high)
    this.players.forEach(p => {
        p.hand = Cards.sortHand(p.hand, false);
    });

    if (!tycoon || !rich || !commoner || !beggar) {
        this.startRound();
        return;
    }

    // Beggar must give 2 best to Tycoon, Commoner 1 best to Rich
    this.exchangePending.push({ giverId: beggar.id,   receiverId: tycoon.id,  count: 2, giversChoice: false });
    this.exchangePending.push({ giverId: commoner.id, receiverId: rich.id,    count: 1, giversChoice: false });
    this.exchangePending.push({ giverId: tycoon.id,   receiverId: beggar.id,  count: 2, giversChoice: true  });
    this.exchangePending.push({ giverId: rich.id,     receiverId: commoner.id,count: 1, giversChoice: true  });

    this.phase = GamePhase.EXCHANGE;
    this._notify();
  }

  startRound() {
    const deck = Cards.createDeck();
    const hands = Cards.dealCards(deck, this.players.length);

    // FIX: Ensure revolution is false before sorting dealt cards
    this.revolutionActive = false; 

    this.players.forEach((p, i) => {
      p.hand = Cards.sortHand(hands[i], false);
      p.finished = false;
      p.finishPosition = null;
    });

    this.pile = [];
    this.currentPlay = null;
    this.passCount = 0;
    this.finishOrder = [];

    this.currentTurn = Cards.findStartingPlayer(this.players.map(p => p.hand));
    this.phase = GamePhase.PLAYING;

    this._log(`Round ${this.round} started!`);
    this._notify();
    this.startTurnTimer();
  }

  submitExchange(giverId, cards) {
    const exchange = this.exchangePending.find(e => e.giverId === giverId && !this.exchangesDone.has(e.giverId + '->' + e.receiverId));
    if (!exchange) return false;

    const giver = this.players.find(p => p.id === giverId);
    const receiver = this.players.find(p => p.id === exchange.receiverId);

    if (!giver || !receiver) return false;
    
    cards.forEach(card => {
      const idx = giver.hand.findIndex(c => c.id === card.id);
      if (idx !== -1) giver.hand.splice(idx, 1);
      receiver.hand.push(card);
    });

    // Re-sort in standard order after swap
    giver.hand = Cards.sortHand(giver.hand, false);
    receiver.hand = Cards.sortHand(receiver.hand, false);

    this.exchangesDone.add(giverId + '->' + exchange.receiverId);
    this._log(`${giver.nickname} finished exchange.`);

    if (this.exchangePending.every(e => this.exchangesDone.has(e.giverId + '->' + e.receiverId))) {
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

    selectedCards.forEach(card => {
      const idx = player.hand.findIndex(c => c.id === card.id);
      if (idx !== -1) player.hand.splice(idx, 1);
    });

    this.pile.push(...selectedCards);
    const topStrength = Cards.getPlayStrength(selectedCards, this.revolutionActive);
    this.currentPlay = {
      cards: selectedCards,
      count: selectedCards.length,
      topStrength,
      playerId,
      playerName: player.nickname
    };

    if (result.isRevolution) {
      this.revolutionActive = !this.revolutionActive;
      this.players.forEach(p => p.hand = Cards.sortHand(p.hand, this.revolutionActive));
    }

    this.checkPlayerFinished(this.currentTurn);
    if (this.phase === GamePhase.PLAYING) {
        if (result.is3Spades || selectedCards.every(c => Cards.is8Stop(c))) {
            this.clearPile(this.currentTurn);
        } else {
            this.advanceTurn();
        }
    }
    this._notify();
    return { ok: true };
  }

  pass(playerId) {
    if (!this.isPlayerTurn(playerId)) return;
    this.passCount++;
    const activePlayers = this.players.filter(p => !p.finished).length;
    if (this.passCount >= activePlayers - 1) {
      const lastPlayerId = this.currentPlay?.playerId;
      const lastPlayerIdx = this.players.findIndex(p => p.id === lastPlayerId);
      this.clearPile(lastPlayerIdx !== -1 ? lastPlayerIdx : this.currentTurn);
    } else {
      this.advanceTurn();
      this._notify();
    }
  }

  clearPile(nextPlayerIdx) {
    this.pile = [];
    this.currentPlay = null;
    this.passCount = 0;
    this.currentTurn = nextPlayerIdx;
    let attempts = 0;
    while (this.players[this.currentTurn]?.finished && attempts < this.players.length) {
      this.currentTurn = (this.currentTurn + 1) % this.players.length;
      attempts++;
    }
    this.startTurnTimer();
  }

  advanceTurn() {
    let next = (this.currentTurn + 1) % this.players.length;
    while (this.players[next]?.finished) {
      next = (next + 1) % this.players.length;
    }
    this.currentTurn = next;
    this.startTurnTimer();
  }

  checkPlayerFinished(playerIdx) {
    const player = this.players[playerIdx];
    if (player.hand.length === 0 && !player.finished) {
      player.finished = true;
      this.finishOrder.push(playerIdx);
      player.finishPosition = this.finishOrder.length;
      const unfinished = this.players.filter(p => !p.finished);
      if (unfinished.length <= 1) {
        if (unfinished.length === 1) {
          unfinished[0].finished = true;
          this.finishOrder.push(this.players.indexOf(unfinished[0]));
          unfinished[0].finishPosition = this.finishOrder.length;
        }
        this.endRound();
      }
    }
  }

  endRound() {
    this.stopTurnTimer();
    this.phase = GamePhase.ROUND_END;
    const rankNames = ['tycoon', 'rich', 'commoner', 'beggar'];
    
    this.finishOrder.forEach((playerIdx, pos) => {
        const player = this.players[playerIdx];
        const rank = rankNames[pos] || 'beggar';
        player.rank = rank;
        player.score += POINTS[rank] || 0;
    });

    if (this.round >= this.totalRounds) {
        this.phase = GamePhase.GAME_OVER;
    } else {
        this.round++;
    }
    this._notify();
  }

  _log(msg) { if (this.onActionLog) this.onActionLog(msg); }
  _notify() { if (this.onStateChange) this.onStateChange(this.getState()); }

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
    return this.players[this.localPlayerIndex]?.hand || [];
  }

  getExchangeInfo() {
    if (this.localPlayerIndex < 0) return null;
    const localId = this.players[this.localPlayerIndex].id;
    return this.exchangePending.find(e => e.giverId === localId && !this.exchangesDone.has(e.giverId + '->' + e.receiverId));
  }
}

window.TycoonGame = TycoonGame;
window.GamePhase = GamePhase;
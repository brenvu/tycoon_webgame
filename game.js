// ============================================================
// TYCOON — Core Game State Machine
// ============================================================

const RANKS_ORDER = ['tycoon', 'rich', 'poor', 'beggar'];
const POINTS = { tycoon: 30, rich: 20, poor: 10, beggar: 0, commoner: 10 }; // commoner kept for compat

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
    this.exchangeNewHands = {}; // playerId -> newly dealt hand (choosing from this)
    this.exchangeBuffer = {};   // giverId -> cards they chose to give
    this.bankruptTycoonId = null; // set when tycoon goes bankrupt, cleared after next startRound
    this.localPlayerIndex = -1;
    this.hostIndex = 0;
    this.onStateChange = null; // callback
    this.onTurnTimeout = null;
    this.onRoundEnd = null;
    this.onGameOver = null;
    this.onActionLog = null;
    this.recentLogs = []; // last N log messages for broadcasting to guests
    this.logSeq = 0; // monotonic counter — never resets
    this.previousTycoon = -1;
    this.tycoonBankruptCheck = false;
  }

  // ---- Setup ----

  addPlayer(id, nickname, avatar) {
    if (this.players.length >= 4) return false;
    this.players.push({
      id, nickname, avatar,
      rank: 'poor',
      score: 0,
      hand: [],
      finished: false,
      finishPosition: null,
      connected: true
    });
    return true;
  }

  startRound() {
    // Reset revolution BEFORE sorting
    this.pile = [];
    this.currentPlay = null;
    this.passCount = 0;
    this.revolutionActive = false;
    this.finishOrder = [];
    // Note: recentLogs is NOT cleared here — guests use seq numbers to deduplicate

    // Only deal new cards if hands weren't already set by exchange
    const handsAlreadyDealt = this.players.every(p => p.hand && p.hand.length > 0);
    if (!handsAlreadyDealt) {
      const deck = Cards.createDeck();
      const hands = Cards.dealCards(deck, this.players.length);
      this.players.forEach((p, i) => {
        p.hand = Cards.sortHand(hands[i], false);
      });
    }

    this.players.forEach(p => {
      p.finished = false;
      p.finishPosition = null;
      p.bankrupted = false;
    });

    // Bankrupt tycoon (became beggar from bankruptcy) is auto-finished — they sit out this round
    // We track this via the bankruptTycoonId set during endRound
    if (this.bankruptTycoonId) {
      const bt = this.players.find(p => p.id === this.bankruptTycoonId);
      if (bt) {
        bt.finished = true;
        bt.finishPosition = this.players.length; // last place
        bt.bankrupted = true;
        this.finishOrder.push(this.players.indexOf(bt));
        this._log(`💀 ${bt.nickname} (bankrupted Tycoon) sits out this round!`);
      }
      this.bankruptTycoonId = null;
    }

    // First turn: player with 3♦ (skip bankrupt player)
    this.currentTurn = Cards.findStartingPlayer(this.players.map(p => p.hand));
    // Make sure starting player isn't the bankrupt one
    let safety = 0;
    while (this.players[this.currentTurn]?.finished && safety < this.players.length) {
      this.currentTurn = (this.currentTurn + 1) % this.players.length;
      safety++;
    }

    this.phase = GamePhase.PLAYING;
    this._log(`Round ${this.round} started! ${this.players[this.currentTurn].nickname} goes first (has 3♦)`);
    this._notify();
    this.startTurnTimer();
  }

  // ---- Card Exchange (between rounds) ----

  setupExchange() {
    // Reset revolution state
    this.revolutionActive = false;

    // Find ranks from PREVIOUS round
    const tycoon  = this.players.find(p => p.rank === 'tycoon');
    const rich     = this.players.find(p => p.rank === 'rich');
    const commoner = this.players.find(p => p.rank === 'poor');
    const beggar   = this.players.find(p => p.rank === 'beggar');

    this.exchangePending = [];
    this.exchangesDone = new Set();
    this.exchangeNewHands = {};
    this.exchangeBuffer = {};

    if (!tycoon || !rich || !commoner || !beggar) {
      // First round or < 4 players — skip exchange, go straight to round
      this.startRound();
      return;
    }

    // Deal new hands NOW — players will choose from these fresh hands
    const deck = Cards.createDeck();
    const hands = Cards.dealCards(deck, this.players.length);
    this.players.forEach((p, i) => {
      this.exchangeNewHands[p.id] = Cards.sortHand(hands[i], false);
    });

    // Beggar must give 2 highest cards to Tycoon (no choice)
    this.exchangePending.push({ giverId: beggar.id,   receiverId: tycoon.id,  count: 2, giversChoice: false });
    // Commoner must give 1 highest card to Rich (no choice)
    this.exchangePending.push({ giverId: commoner.id, receiverId: rich.id,    count: 1, giversChoice: false });
    // Tycoon chooses 2 cards to give Beggar
    this.exchangePending.push({ giverId: tycoon.id,   receiverId: beggar.id,  count: 2, giversChoice: true  });
    // Rich chooses 1 card to give Commoner
    this.exchangePending.push({ giverId: rich.id,     receiverId: commoner.id,count: 1, giversChoice: true  });

    // Players with no choice auto-submit their top N cards
    [
      { p: beggar,   count: 2 },
      { p: commoner, count: 1 }
    ].forEach(({ p, count }) => {
      const newHand = this.exchangeNewHands[p.id];
      const topN = newHand.slice(-count); // sorted ascending, so last N = highest
      const key = p.id + '->' + this.exchangePending.find(e => e.giverId === p.id).receiverId;
      this.exchangeBuffer[p.id] = topN;
      this.exchangesDone.add(key);
    });

    this.phase = GamePhase.EXCHANGE;
    this._notify();
  }

  getExchangeForPlayer(playerId) {
    return this.exchangePending.find(e => e.giverId === playerId && !this.exchangesDone.has(e.giverId + '->' + e.receiverId));
  }

  // Returns the new hand for exchange selection (freshly dealt, not yet modified by exchange)
  getExchangeNewHand(playerId) {
    return this.exchangeNewHands[playerId] || null;
  }

  submitExchange(giverId, cards) {
    const exchange = this.exchangePending.find(e => e.giverId === giverId && !this.exchangesDone.has(e.giverId + '->' + e.receiverId));
    if (!exchange) return false;
    if (cards.length !== exchange.count) return false;

    // Buffer this submission — don't touch hands yet
    this.exchangeBuffer[giverId] = cards;
    this.exchangesDone.add(giverId + '->' + exchange.receiverId);
    this._log(`${this.players.find(p => p.id === giverId)?.nickname} chose their exchange cards`);

    // Check if Tycoon AND Rich have both submitted (Beggar/Commoner auto-submitted in setupExchange)
    const allDone = this.exchangePending.every(e => this.exchangesDone.has(e.giverId + '->' + e.receiverId));
    if (allDone) {
      // Apply ALL exchanges simultaneously from the freshly dealt hands
      const finalHands = {};
      this.players.forEach(p => {
        finalHands[p.id] = [...(this.exchangeNewHands[p.id] || [])];
      });

      // Remove given cards from givers, add to receivers (mark received cards as new)
      this.exchangePending.forEach(e => {
        const givenCards = this.exchangeBuffer[e.giverId] || [];
        givenCards.forEach(card => {
          const idx = finalHands[e.giverId].findIndex(c => c.id === card.id);
          if (idx !== -1) finalHands[e.giverId].splice(idx, 1);
        });
        givenCards.forEach(card => {
          finalHands[e.receiverId].push({ ...card, isNew: true });
        });
      });

      // Apply final hands — isNew flag will be used by client to show "You received" toast
      this.players.forEach(p => {
        p.hand = Cards.sortHand(finalHands[p.id] || [], false);
      });

      this.exchangeNewHands = {};
      this.exchangeBuffer = {};
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
      isCounterRevolution: result.isCounterRevolution || false,
      allEights: selectedCards.every(c => Cards.is8Stop(c))
    };
    this.currentPlay = newPlay;

    const names = selectedCards.map(c => Cards.cardDisplayName(c)).join(', ');
    this._log(`${player.nickname} played: ${names}`);

    // Check Revolution / Counter-Revolution
    if (result.isRevolution) {
      if (result.isCounterRevolution) {
        // Counter-revolution: cancels the active revolution, restores normal order
        this.revolutionActive = false;
        this._log(`🔄 COUNTER-REVOLUTION! ${player.nickname} undoes the revolution — values RESTORED!`);
      } else {
        // New revolution: flip values
        this.revolutionActive = !this.revolutionActive;
        this._log(`⚡ REVOLUTION! Card values are ${this.revolutionActive ? 'REVERSED' : 'RESTORED'}!`);
      }
      // Re-sort all hands with new ordering
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

    // Move to next player — new card played, clear pass state
    this.passCount = 0;
    this.players.forEach(p => { p.passedThisTrick = false; });
    this.advanceTurn();
    this._notify();
    this.startTurnTimer();
    return { ok: true };
  }

  pass(playerId) {
    if (!this.isPlayerTurn(playerId)) return;

    const player = this.players[this.currentTurn];
    this._log(`${player.nickname} passed.`);
    player.passedThisTrick = true;
    this.passCount++;

    // Find who last played a card (they won't pass — they win if everyone else passes)
    const lastPlayerId = this.currentPlay?.playerId;
    const lastPlayerIdx = this.players.findIndex(p => p.id === lastPlayerId);

    // Count players who still need to pass: non-finished AND not the last player who played
    const needToPass = this.players.filter(p =>
      !p.finished && p.id !== lastPlayerId && !p.passedThisTrick
    ).length;

    if (needToPass === 0) {
      // Everyone else has passed — last player wins the trick
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
    // Clear per-player pass flags for new trick
    this.players.forEach(p => { p.passedThisTrick = false; });
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

    // 4-player ranks: 1st=tycoon, 2nd=rich, 3rd=poor, 4th=beggar
    const rankNames = ['tycoon', 'rich', 'poor', 'beggar'];
    const rankAssignment = this.finishOrder.map((playerIdx, pos) => ({
      playerIdx,
      rank: rankNames[pos] ?? 'beggar'
    }));

    // Tycoon bankruptcy (round 2+): if prev tycoon didn't finish 1st, they become beggar
    // and the last finisher is bumped from beggar to poor
    if (this.round > 1) {
      const tycoonPlayer = this.players.find(p => p.rank === 'tycoon');
      if (tycoonPlayer) {
        const tycoonIdx = this.players.indexOf(tycoonPlayer);
        const finishedFirst = this.finishOrder[0] === tycoonIdx;
        if (!finishedFirst) {
          this._log(`💀 BANKRUPTCY! ${tycoonPlayer.nickname} (Tycoon) failed to defend — becomes Beggar!`);
          const tycoonAssign = rankAssignment.find(r => r.playerIdx === tycoonIdx);
          if (tycoonAssign) {
            // Last finisher gets bumped to poor (not beggar) since bankrupt tycoon takes that slot
            const lastAssign = rankAssignment[rankAssignment.length - 1];
            if (lastAssign && lastAssign.playerIdx !== tycoonIdx) {
              lastAssign.rank = 'poor';
            }
            tycoonAssign.rank = 'beggar';
          }
          // Mark this player to auto-finish next round
          this.bankruptTycoonId = tycoonPlayer.id;
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

    this._notify();

    // Only increment round if not on final round (fix: was resetting after final round)
    if (this.round < this.totalRounds) {
      this.round++;
    } else {
      setTimeout(() => this.endGame(), 3000);
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
    // Keep a rolling buffer with seq numbers for guest deduplication
    this.logSeq++;
    this.recentLogs.push({ seq: this.logSeq, msg });
    if (this.recentLogs.length > 20) this.recentLogs.shift();
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
        passedThisTrick: p.passedThisTrick || false,
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
      exchangeNewHands: this.exchangeNewHands,
      recentLogs: [...this.recentLogs],
      logSeq: this.logSeq,
      localPlayerIndex: this.localPlayerIndex
    };
  }

  getLocalHand() {
    if (this.localPlayerIndex < 0) return [];
    return this.players[this.localPlayerIndex]?.hand || [];
  }

  getLocalExchangeHand() {
    if (this.localPlayerIndex < 0) return null;
    const localId = this.players[this.localPlayerIndex]?.id;
    return this.exchangeNewHands[localId] || null;
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

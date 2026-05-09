// ============================================================
// TYCOON — Main Application Controller (Fixed Disconnect Bug)
// ============================================================

const KNOWN_AVATARS = ['Ren Amamiya.png'];

class TycoonApp {
  constructor() {
    this.net = new TycoonNetwork();
    this.game = new TycoonGame();
    this.localId = null;
    this.localPlayerIndex = -1;
    this.selectedCards = new Set();
    this.exchangeSelected = new Set();
    this.isHost = false;
    this.playerInfo = { nickname: 'Phantom', avatar: '', game: 'Persona 5', avatarColor: '#ffffff' };
    this._readySet = new Set();     // IDs of ready players in lobby
    this._playAgainSet = new Set(); // IDs who voted play again
    this._localReady = false;
    this.pendingExchange = null;
    this._timerTick = null;
    this._lastKnownTimer = 90;
    this._receivedModalShown = false;
    this._exchangeSubmitted = false;
    this._lastSeenLogSeq = 0;
    this._pendingReceivedCards = null;
    this._pendingReceivedCardIds = null;
    this._prevPhase = null;

    this.game.onStateChange = (state) => this.onGameStateChange(state);
    this.game.onActionLog = (msg) => UI.addLogEntry(msg);

    this.init();
  }

  init() {
    this.loadProfile();
    // Populate avatars after profile loads (uses saved game)
    setTimeout(() => this.populateAvatars(this.playerInfo.game || 'Persona 5'), 0);
    this.setupLobbyUI();
    this.populateAvatars();
    UI.showScreen('lobby');
  }

  // ---- Profile ----

  loadProfile() {
    try {
      const saved = localStorage.getItem('tycoon_profile');
      if (saved) {
        const p = JSON.parse(saved);
        this.playerInfo = { ...this.playerInfo, ...p };
      }
    } catch(e) {}
    const nickInput = document.getElementById('input-nickname');
    const avatarSel = document.getElementById('select-avatar');
    if (nickInput) nickInput.value = this.playerInfo.nickname;
    if (avatarSel && this.playerInfo.avatar) avatarSel.value = this.playerInfo.avatar;
  }

  saveProfile() {
    const nickInput = document.getElementById('input-nickname');
    const avatarSel = document.getElementById('select-avatar');
    if (nickInput) this.playerInfo.nickname = nickInput.value.trim() || 'Phantom';
    if (avatarSel) this.playerInfo.avatar = avatarSel.value;
    const gameSelSave = document.getElementById('select-game');
    if (gameSelSave) this.playerInfo.game = gameSelSave.value;
    // avatarColor is kept current in this.playerInfo.avatarColor by the cycler
    try { localStorage.setItem('tycoon_profile', JSON.stringify(this.playerInfo)); } catch(e) {}
  }

  populateAvatars(game) {
    const g = game || this.playerInfo.game || 'Persona 5';
    fetch('avatars/manifest.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(manifest => {
        const list = (manifest[g] || []).map(f => g + '/' + f);
        UI.populateAvatarSelect(list, g);
      })
      .catch(() => UI.populateAvatarSelect([], g));
  }

  _startClientTimer(seconds) {
    this._stopClientTimer();
    this._lastKnownTimer = seconds;
    if (this.isHost) return; 
    this._timerTick = setInterval(() => {
      this._lastKnownTimer = Math.max(0, this._lastKnownTimer - 1);
      UI.renderTimer(this._lastKnownTimer);
      if (this._lastKnownTimer <= 0) this._stopClientTimer();
    }, 1000);
  }

  _stopClientTimer() {
    if (this._timerTick) {
      clearInterval(this._timerTick);
      this._timerTick = null;
    }
  }

  // ---- Lobby UI ----

  setupLobbyUI() {
    document.getElementById('btn-host').addEventListener('click', () => this.hostGame());
    document.getElementById('btn-join').addEventListener('click', () => this.joinGame());
    document.getElementById('btn-copy-code').addEventListener('click', () => this.copyRoomCode());
    // btn-start-game is hidden — game starts via ready vote (_checkReadyStart)
    document.getElementById('btn-next-round').addEventListener('click', () => this.nextRound());
    document.getElementById('btn-play-again').addEventListener('click', () => this.playAgain());
    document.getElementById('btn-play').addEventListener('click', () => this.submitPlay());
    document.getElementById('btn-pass').addEventListener('click', () => this.submitPass());
    document.getElementById('btn-confirm-exchange').addEventListener('click', () => this.submitExchangeFromGame());
    document.getElementById('btn-leave-lobby')?.addEventListener('click', () => this.leaveLobby());
    document.getElementById('btn-disband-lobby')?.addEventListener('click', () => this.disbandLobby());
    document.getElementById('btn-ready-host')?.addEventListener('click', () => this.toggleReady());
    document.getElementById('btn-ready-guest')?.addEventListener('click', () => this.toggleReady());

    document.getElementById('input-room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinGame();
    });
    document.getElementById('input-nickname').addEventListener('blur', () => this.saveProfile());

    // Game dropdown — repopulate avatars on change
    const gameSelect = document.getElementById('select-game');
    if (gameSelect) {
      gameSelect.value = this.playerInfo.game || 'Persona 5';
      gameSelect.addEventListener('change', () => {
        this.playerInfo.game = gameSelect.value;
        this.saveProfile();
        this.populateAvatars(gameSelect.value);
      });
    }

    // Color cycler — arrow buttons cycle through palette
    const COLOR_PALETTE = [
      { value: '#ffffff', label: 'White' },
      { value: '#111111', label: 'Black' },
      { value: '#e8001c', label: 'Red' },
      { value: '#a855f7', label: 'Purple' },
      { value: '#3b82f6', label: 'Blue' },
      { value: '#67e8f9', label: 'Light Blue' },
      { value: '#4ade80', label: 'Green' },
      { value: '#fbbf24', label: 'Yellow' },
      { value: '#f97316', label: 'Orange' },
    ];
    let _colorIdx = COLOR_PALETTE.findIndex(c => c.value === (this.playerInfo.avatarColor || '#ffffff'));
    if (_colorIdx < 0) _colorIdx = 0;

    const applyColor = (color) => {
      this.playerInfo.avatarColor = color;
      const display = document.getElementById('color-display');
      if (display) display.style.background = color;
      const previewBox = document.querySelector('.avatar-preview-box');
      if (previewBox) previewBox.style.background = color;
      this.saveProfile();
    };

    const setColorByIdx = (idx) => {
      _colorIdx = ((idx % COLOR_PALETTE.length) + COLOR_PALETTE.length) % COLOR_PALETTE.length;
      applyColor(COLOR_PALETTE[_colorIdx].value);
    };

    document.getElementById('color-prev')?.addEventListener('click', () => setColorByIdx(_colorIdx - 1));
    document.getElementById('color-next')?.addEventListener('click', () => setColorByIdx(_colorIdx + 1));
    applyColor(COLOR_PALETTE[_colorIdx].value);

    // Warn before leaving mid-game
    window.addEventListener('beforeunload', (e) => {
      if (this.game && this.game.phase !== 'lobby' && this.game.phase !== 'game_over') {
        e.preventDefault();
        e.returnValue = '';
      }
    });
  }

  showError(msg) {
    const errEl = document.getElementById('lobby-error');
    if (errEl) {
      errEl.textContent = msg;
      errEl.classList.remove('hidden');
      setTimeout(() => errEl.classList.add('hidden'), 5000);
    }
    UI.showToast(msg, 4000);
  }

  // ---- Networking ----

  _wireNet() {
    this.net.onPlayerJoined = (player) => {
      UI.showToast(player.nickname + ' joined!');
      // Only return to waiting room if game hasn't started
      if (this.game.phase === 'lobby' || !this.game.phase) {
        this.renderWaiting();
      }
    };

    this.net.onPlayerLeft = (peerId) => {
      // Always remove leaver from ready set immediately
      if (this._readySet.has(peerId)) {
        this._readySet.delete(peerId);
        // If this player was the local player (shouldn't happen) just clear
      }

      const pIdx = this.game ? this.game.players.findIndex(p => p.id === peerId) : -1;
      const playerName = pIdx !== -1 ? (this.game.players[pIdx].nickname || 'A player') : 'A player';
      UI.showToast(playerName + ' disconnected.');

      if (!this.game || this.game.phase === 'lobby' || !this.game.phase) {
        // Re-render waiting room; host re-broadcasts updated ready state
        this.renderWaiting();
      }
    };

    this.net.onConnectionChange = () => {
        if (this.game.phase === 'lobby' || !this.game.phase) this.renderWaiting();
    };

    this.net.onGameMessage = (msg, fromId) => this.handleGameMessage(msg, fromId);
    this.net.onError = (msg) => this.showError(msg);
  }

  async hostGame() {
    this.saveProfile();
    if (!this.playerInfo.nickname) { this.showError('Please enter a nickname.'); return; }

    const hostBtn = document.getElementById('btn-host');
    hostBtn.disabled = true;
    hostBtn.textContent = 'CONNECTING...';

    this.net = new TycoonNetwork();
    this.isHost = true;
    this._wireNet();

    this.net.onRoomReady = (code) => {
      this.localId = this.net.getLocalId();
      document.getElementById('display-room-code').textContent = code;
      document.getElementById('waiting-room').classList.remove('hidden');
      hostBtn.textContent = 'CREATE ROOM';
      hostBtn.disabled = false;
      this.renderWaiting();
    };

    try {
      await this.net.host(this.playerInfo);
    } catch(e) {
      this.showError('Hosting failed.');
      hostBtn.disabled = false;
    }
  }

  async joinGame() {
    this.saveProfile();
    const raw = document.getElementById('input-room-code').value.trim().toUpperCase().replace(/\s/g, '');
    if (!raw) return;

    const joinBtn = document.getElementById('btn-join');
    joinBtn.disabled = true;
    joinBtn.textContent = 'JOINING...';

    this.net = new TycoonNetwork();
    this.isHost = false;
    this._wireNet();

    this.net.onJoinSuccess = () => {
      this.localId = this.net.getLocalId();
      document.getElementById('display-room-code').textContent = raw;
      document.getElementById('waiting-room').classList.remove('hidden');
      joinBtn.textContent = 'JOIN ROOM';
      joinBtn.disabled = false;
      this.renderWaiting();
    };

    try {
      await this.net.join(raw, this.playerInfo);
    } catch(e) {
      this.showError('Join failed.');
      joinBtn.disabled = false;
    }
  }

  renderWaiting() {
    const players = this.net.getPlayers();
    UI.renderWaitingRoom(players, this.isHost, this.localId);
    document.getElementById('host-actions').style.display = this.isHost ? 'flex' : 'none';
    document.getElementById('guest-actions').style.display = !this.isHost ? 'flex' : 'none';
    if (this.isHost) {
      // Prune any IDs no longer in the lobby from the ready set
      const playerIds = new Set(players.map(p => p.id));
      this._readySet.forEach(id => { if (!playerIds.has(id)) this._readySet.delete(id); });
      // Broadcast updated state — but do NOT auto-start here (disconnect must not trigger start)
      this._broadcastReadyState();
    }
    UI.renderReadyStatus(this._readySet, players);
  }

  copyRoomCode() {
    const code = document.getElementById('display-room-code').textContent.trim();
    navigator.clipboard.writeText(code).then(() => {
      UI.showToast('Room code copied!');
    });
  }

  // ---- Game Start ----

  startGame() {
    if (!this.isHost) return;
    this.localId = this.net.getLocalId();
    const players = this.net.getPlayers();
    if (players.length < 4) { this.showError('Need at least 4 players to start.'); return; }

    this.net.broadcastGameMessage({ type: 'game_start', players });
    this._initGameLocally(players);
  }

  _initGameLocally(netPlayers) {
    this._stopClientTimer();
    this.game.reset();
    
    this.game.onStateChange = (state) => this.onGameStateChange(state);
    this.game.onActionLog   = (msg)   => UI.addLogEntry(msg);

    netPlayers.forEach(p => this.game.addPlayer(p.id, p.nickname, p.avatar, p.avatarColor || '#ffffff'));

    const idx = this.game.players.findIndex(p => p.id === this.localId);
    this.localPlayerIndex      = idx;
    this.game.localPlayerIndex = idx;
    
    // Dynamically find host index
    const hostIdx = this.game.players.findIndex(p => p.id === (this.isHost ? this.localId : this.net.hostPeerId));
    this.game.hostIndex = (hostIdx === -1) ? 0 : hostIdx;

    UI.showScreen('game');
    
    if (this.isHost) {
      this.game.startRound(); 
      this._broadcastFullState();
    }
  }

  _broadcastFullState() {
    if (!this.isHost) return;
    this.net.broadcastPerPlayerState((guestPeerId) => {
      const guestIdx = this.game.players.findIndex(p => p.id === guestPeerId);
      if (guestIdx === -1) return null;
      const guestId = guestPeerId;
      return {
        type: 'state_sync',
        state: {
          players: this.game.players.map((p, i) => ({
            id: p.id, nickname: p.nickname, avatar: p.avatar,
            rank: p.rank, score: p.score,
            hand: i === guestIdx ? p.hand : [],
            handCount: p.hand ? p.hand.length : 0,
            finished: p.finished, finishPosition: p.finishPosition,
            passedThisTrick: p.passedThisTrick || false
          })),
          round:            this.game.round,
          currentTurn:      this.game.currentTurn,
          currentPlay:      this.game.currentPlay,
          pile:             this.game.pile,
          revolutionActive: this.game.revolutionActive,
          finishOrder:      this.game.finishOrder,
          turnTimer:        this.game.turnTimer,
          phase:            this.game.phase,
          localPlayerIndex: guestIdx,
          exchangePending:  this.game.exchangePending,
          exchangesDone:    [...this.game.exchangesDone],
          // Only send this player's own new exchange hand
          exchangeNewHand:  this.game.exchangeNewHands[guestId] || null,
          // Log messages for guest event feed (tagged with seq numbers)
          recentLogs: this.game.recentLogs ? [...this.game.recentLogs] : [],
          logSeq: this.game.logSeq || 0,
          // receivedCardIds removed — sent as separate message to avoid re-fire
        }
      };
    });
  }

  handleGameMessage(msg, fromId) {
    if (!msg || !msg.type) return;
    switch (msg.type) {
      case 'game_start':
        if (!this.isHost) this._initGameLocally(msg.players);
        break;
      case 'state_sync':
        if (!this.isHost) this._applyRemoteState(msg.state);
        break;
      case 'play_cards':
        if (this.isHost) {
          const result = this.game.playCards(fromId, msg.cards);
          if (!result.ok) {
            const conn = this.net.connections.find(c => c.peer === fromId);
            if (conn) conn.send({ type: 'play_error', reason: result.reason });
          } else {
            this._broadcastFullState();
          }
        }
        break;
      case 'pass_turn':
        if (this.isHost) {
          this.game.pass(fromId);
          this._broadcastFullState();
        }
        break;
      case 'exchange_submit':
        if (this.isHost) {
          this.game.submitExchange(fromId, msg.cards);
          this._broadcastFullState();
        }
        break;
      case 'next_round':
        if (this.isHost) {
          this.game.setupExchange();
          this._broadcastFullState();
        }
        break;
      case 'received_cards':
        // Store card IDs — will be shown once hand arrives via state_sync
        if (!this.isHost && msg.cardIds && msg.cardIds.length > 0 && !this._receivedModalShown) {
          this._pendingReceivedCardIds = msg.cardIds;
          // Try immediately in case state_sync already arrived
          this._tryShowReceivedModal();
        }
        break;
      case 'ready_state':
        // Host broadcast who is ready
        UI.renderReadyStatus(new Set(msg.readyIds || []), this.net.getPlayers());
        break;
      case 'game_start_ready':
        // All ready — game starts
        if (msg.players) this._initGameLocally(msg.players);
        break;
      case 'lobby_disbanded':
        UI.showToast('Lobby disbanded by host.', 3000);
        setTimeout(() => location.reload(), 1500);
        break;
      case 'play_again_vote':
        // Show updated vote count
        UI.showToast(`Play again vote: ${msg.count}/${msg.total}`, 2000);
        break;
      case 'play_again_count':
        UI.showToast(`Play again: ${msg.count}/${msg.total} voted`, 2000);
        break;
      case 'play_again_go':
        // All voted — start new game
        this._playAgainSet.clear();
        if (msg.players) this._initGameLocally(msg.players);
        break;
      case 'play_again':
        // Legacy compat
        if (msg.players) this._initGameLocally(msg.players);
        break;
      case 'play_again_ready':
        break;
      case 'player_ready':
        this._readySet.add(fromId);
        this._broadcastReadyState();
        this._checkReadyStart();
        break;
      case 'player_unready':
        this._readySet.delete(fromId);
        this._broadcastReadyState();
        break;
      case 'play_again_vote':
        this._playAgainSet.add(fromId);
        this._checkPlayAgain();
        break;
      case 'play_error':
        UI.showToast('Invalid: ' + msg.reason, 3000);
        break;
    }
  }

  _applyRemoteState(state) {
    if (!state) return;
    const g = this.game;
    const prevTurn  = g.currentTurn;
    const prevTimer = g.turnTimer;
    const prevPhase = g.phase;

    g.round            = state.round;
    g.currentTurn      = state.currentTurn;
    g.currentPlay      = state.currentPlay;
    g.pile             = state.pile || [];
    g.revolutionActive = state.revolutionActive;
    g.pileClearPending = state.pileClearPending || false;
    g.finishOrder      = state.finishOrder || [];
    g.turnTimer        = state.turnTimer;
    g.phase            = state.phase;
    g.exchangePending  = state.exchangePending || [];
    g.exchangesDone    = new Set(state.exchangesDone || []);
    // Restore this player's exchange new hand if present
    if (state.exchangeNewHand && state.localPlayerIndex !== undefined) {
      const localId = g.players[state.localPlayerIndex]?.id;
      if (localId) {
        if (!g.exchangeNewHands) g.exchangeNewHands = {};
        g.exchangeNewHands[localId] = state.exchangeNewHand;
      }
    } else if (state.phase !== 'exchange') {
      g.exchangeNewHands = {};
    }

    if (state.localPlayerIndex !== undefined) {
      this.localPlayerIndex      = state.localPlayerIndex;
      g.localPlayerIndex         = state.localPlayerIndex;
    }

    if (state.players) {
      state.players.forEach((sp, i) => {
        if (!g.players[i]) g.players[i] = {};
        const lp = g.players[i];
        lp.id             = sp.id;
        lp.nickname       = sp.nickname;
        lp.avatar         = sp.avatar;
        lp.rank           = sp.rank;
        lp.score          = sp.score;
        lp.finished       = sp.finished;
        lp.finishPosition = sp.finishPosition;
        lp.handCount      = sp.handCount || 0;
        lp.avatarColor    = sp.avatarColor || '#ffffff';
        lp.passedThisTrick = sp.passedThisTrick || false;
        if (sp.hand && sp.hand.length > 0) {
          lp.hand = sp.hand;
          lp.handCount = sp.hand.length; // keep in sync
        } else if (lp.handCount === 0) {
          lp.hand = [];
        }
        // Always store handCount so getState() fallback works for other players
      });
      while (g.players.length > state.players.length) g.players.pop();
    }

    // Start client timer if turn changed, timer jumped, OR phase just became 'playing'
    const phaseJustStarted = g.phase === 'playing' && prevPhase !== 'playing';
    if (g.phase === 'playing' && (phaseJustStarted || g.currentTurn !== prevTurn || Math.abs(g.turnTimer - prevTimer) > 2)) {
      this._startClientTimer(g.turnTimer);
    }

    // Replay new log entries for guests using seq-based deduplication
    if (state.recentLogs && Array.isArray(state.recentLogs)) {
      const lastSeenSeq = this._lastSeenLogSeq || 0;
      const newEntries = state.recentLogs.filter(e => e && e.seq && e.seq > lastSeenSeq);
      newEntries.forEach(e => UI.addLogEntry(e.msg));
      if (newEntries.length > 0) {
        this._lastSeenLogSeq = newEntries[newEntries.length - 1].seq;
      }
    }

    this.renderGameState();

    // Screen Switching
    if (state.phase === 'exchange') {
      // Reset received modal state for new exchange cycle
      this._receivedModalShown = false;
      this._pendingReceivedCardIds = null;
      UI.showScreen('game');
      this.renderExchangeOnGameScreen();
    } else if (state.phase === 'playing') {
      this._hideExchangeBanner();
      UI.showScreen('game');
      // Try to show received cards modal if pending card IDs have now arrived
      if (!this.isHost && this._pendingReceivedCardIds) {
        this._tryShowReceivedModal();
      }
    } else if (state.phase === 'round_end') {
      this._stopClientTimer();
      UI.showScreen('round-end');
      UI.renderRoundEnd(g.players, g.round, g.finishOrder);
    } else if (state.phase === 'game_over') {
      this._stopClientTimer();
      UI.showScreen('gameover');
      UI.renderGameOver(g.players);
    }
  }

  onGameStateChange(state) {
    this.renderGameState();

    const phase = state.phase;
    if (phase === 'playing' && this._prevPhase === 'exchange' && this.isHost) {
      // Exchange just finished — send received_cards to each guest as a dedicated one-time message
      this.game.players.forEach(p => {
        const newCards = (p.hand || []).filter(c => c.isNew).map(c => c.id);
        if (newCards.length > 0 && p.id !== this.localId) {
          this.net.sendToPlayer(p.id, { type: 'received_cards', cardIds: newCards });
        }
      });
    }
    this._prevPhase = phase;

    if (this.isHost) this._broadcastFullState();

    if (phase === 'exchange') {
      // Reset received modal state so next round's modal can show
      this._receivedModalShown = false;
      this._pendingReceivedCardIds = null;
      UI.showScreen('game');
      this.renderExchangeOnGameScreen();
    }
    else if (phase === 'playing') {
      this._hideExchangeBanner();
      UI.showScreen('game');
      this._showReceivedCardsToast();
    }
    else if (phase === 'round_end') {
      UI.showScreen('round-end');
      UI.renderRoundEnd(this.game.players, this.game.round, this.game.finishOrder);
    }
    else if (phase === 'game_over') {
      UI.showScreen('gameover');
      UI.renderGameOver(this.game.players);
    }
  }

  renderGameState() {
    const g           = this.game;
    const state       = g.getState();
    const localPlayer = g.players[this.localPlayerIndex];
    const isMyTurn    = g.isPlayerTurn(this.localId);

    // Update round counter in topbar
    const roundEl = document.getElementById('display-round');
    if (roundEl) roundEl.textContent = g.round;

    UI.renderScoresMini(state.players);
    UI.renderLocalPlayer(localPlayer, g.revolutionActive);
    UI.renderOpponents(state.players, this.localPlayerIndex, g.currentTurn, g.revolutionActive);
    UI.renderPile(g.pile, g.currentPlay);
    UI.renderRevolution(g.revolutionActive);
    UI.renderTimer(this.isHost ? g.turnTimer : this._lastKnownTimer);

    // Revolution outline on game-upper area + label in play-area
    const gameUpper = document.getElementById('game-upper');
    const revLabel = document.getElementById('revolution-label');
    if (gameUpper) {
      gameUpper.classList.toggle('revolution-active', !!g.revolutionActive);
    }
    if (revLabel) {
      revLabel.classList.toggle('rev-visible', !!g.revolutionActive);
    }

    // Your-turn glow + label on local player area
    const isActiveTurn = !!isMyTurn && g.phase === 'playing' && !g.pileClearPending;
    const localArea = document.getElementById('local-player-area');
    const yourTurnLabel = document.getElementById('your-turn-label');
    if (localArea) {
      localArea.classList.toggle('your-turn', isActiveTurn);
    }
    if (yourTurnLabel) {
      yourTurnLabel.classList.toggle('turn-visible', isActiveTurn);
    }

    // During exchange phase, clear the main hand display and pile
    if (g.phase === 'exchange') {
      const handEl = document.getElementById('hand-cards');
      if (handEl) handEl.innerHTML = '';
      const pileEl = document.getElementById('card-pile');
      if (pileEl) {
        pileEl.innerHTML = '';
        const emptyMsg = document.createElement('div');
        emptyMsg.className = 'pile-empty-msg';
        emptyMsg.id = 'pile-empty';
        emptyMsg.textContent = '';
        emptyMsg.style.display = 'none';
        pileEl.appendChild(emptyMsg);
      }
      const pileInfo = document.getElementById('pile-info');
      if (pileInfo) pileInfo.textContent = '';
      return;
    }

    const hand = g.getLocalHand() || [];
    const playableIds = (isMyTurn && !g.pileClearPending) ? Cards.getPlayableCards(hand, g.currentPlay, g.revolutionActive) : new Set();
    UI.renderHand(hand, this.selectedCards, playableIds, (card) => this.toggleCard(card), g.revolutionActive);

    const playBtn = document.getElementById('btn-play');
    const passBtn = document.getElementById('btn-pass');
    const selInfo = document.getElementById('selected-info');

    // During pile-clear delay: lock ALL players
    const pilePending = !!g.pileClearPending;
    const actionBtnsEl = document.getElementById('action-buttons');
    if (actionBtnsEl) actionBtnsEl.classList.toggle('pile-clearing', pilePending);
    if (playBtn) playBtn.disabled = pilePending || !isMyTurn || this.selectedCards.size === 0;
    if (passBtn) passBtn.disabled = pilePending || !isMyTurn;
    // Clear selection during pile-clear delay
    if (pilePending && this.selectedCards.size > 0) {
      this.selectedCards.clear();
    }

    if (selInfo) {
      if (localPlayer && localPlayer.finished) {
        selInfo.textContent = "You finished! Waiting for others...";
      } else if (localPlayer && localPlayer.passedThisTrick) {
        selInfo.textContent = "You passed — waiting for others...";
      } else if (!isMyTurn) {
        const curr = g.players[g.currentTurn];
        selInfo.textContent = curr ? 'Waiting for ' + curr.nickname + '...' : 'Waiting...';
      } else {
        selInfo.textContent = this.selectedCards.size > 0 ? this.selectedCards.size + ' card(s) selected' : 'Your turn — select cards to play';
      }
    }
  }

  toggleCard(card) {
    if (!this.game.isPlayerTurn(this.localId)) return;
    const playableIds = Cards.getPlayableCards(this.game.getLocalHand() || [], this.game.currentPlay, this.game.revolutionActive);
    if (!playableIds.has(card.id)) return;
    if (this.selectedCards.has(card.id)) this.selectedCards.delete(card.id);
    else this.selectedCards.add(card.id);
    this.renderGameState();
  }

  submitPlay() {
    const hand = this.game.getLocalHand() || [];
    const cards = [...this.selectedCards].map(id => hand.find(c => c.id === id)).filter(Boolean);
    if (cards.length === 0) return;
    this.net.sendToHost({ type: 'play_cards', cards });
    this.selectedCards.clear();
    // Optimistically remove cards from local hand so they disappear immediately
    if (!this.isHost) {
      const localPlayer = this.game.players[this.localPlayerIndex];
      if (localPlayer) {
        cards.forEach(card => {
          const idx = localPlayer.hand.findIndex(c => c.id === card.id);
          if (idx !== -1) localPlayer.hand.splice(idx, 1);
        });
      }
    }
    this.renderGameState();
  }

  submitPass() {
    this.net.sendToHost({ type: 'pass_turn' });
  }

  nextRound() {
    this.net.sendToHost({ type: 'next_round' });
  }

  toggleReady() {
    this._localReady = !this._localReady;
    // Pick the correct button based on role
    const btn = document.getElementById(this.isHost ? 'btn-ready-host' : 'btn-ready-guest');
    if (btn) {
      btn.textContent = this._localReady ? 'UNREADY' : 'READY';
      btn.classList.toggle('is-ready', this._localReady);
    }
    if (this.isHost) {
      if (this._localReady) this._readySet.add(this.localId);
      else this._readySet.delete(this.localId);
      this._broadcastReadyState();
      this._checkReadyStart();
    } else {
      this.net.sendToHost({ type: this._localReady ? 'player_ready' : 'player_unready' });
    }
  }

  disbandLobby() {
    if (confirm('Disband the lobby? All players will be disconnected.')) {
      this.net.broadcastGameMessage({ type: 'lobby_disbanded' });
      try { this.net?.disconnect(); } catch(e) {}
      location.reload();
    }
  }

  leaveLobby() {
    if (confirm('Are you sure you want to leave the lobby?')) {
      try { this.net?.disconnect(); } catch(e) {}
      location.reload();
    }
  }

  _broadcastReadyState() {
    // Host tells everyone the current ready set
    this.net.broadcastGameMessage({
      type: 'ready_state',
      readyIds: [...this._readySet],
      total: this.net.getPlayers().length
    });
    UI.renderReadyStatus(this._readySet, this.net.getPlayers());
  }

  _checkReadyStart() {
    const players = this.net.getPlayers();
    // Need exactly 4 players, and every player in the lobby must be in the ready set
    if (players.length < 4) return; // not enough players — never start
    // Verify all current player IDs are in the ready set (not just count match)
    const allReady = players.every(p => this._readySet.has(p.id));
    if (!allReady) return;

    // All 4 ready — start the game
    this._readySet.clear();
    this._localReady = false;
    const readyBtnHost = document.getElementById('btn-ready-host');
    if (readyBtnHost) { readyBtnHost.textContent = 'READY'; readyBtnHost.classList.remove('is-ready'); }
    const allPlayers = players;
    this.net.broadcastGameMessage({ type: 'game_start_ready', players: allPlayers });
    this._initGameLocally(allPlayers);
  }

  playAgain() {
    // Vote system: all 4 must vote to play again
    this._playAgainSet.add(this.localId);
    if (this.isHost) {
      this.net.broadcastGameMessage({ type: 'play_again_vote', voterId: this.localId,
        count: this._playAgainSet.size, total: this.net.getPlayers().length });
      this._checkPlayAgain();
    } else {
      this.net.sendToHost({ type: 'play_again_vote' });
    }
    const btn = document.getElementById('btn-play-again');
    if (btn) { btn.textContent = 'VOTED!'; btn.disabled = true; }
  }

  _checkPlayAgain() {
    const players = this.net.getPlayers();
    if (this._playAgainSet.size >= players.length && players.length >= 4) {
      this._playAgainSet.clear();
      const allPlayers = players;
      this.net.broadcastGameMessage({ type: 'play_again_go', players: allPlayers });
      this._initGameLocally(allPlayers);
    } else if (this._playAgainSet.size < players.length) {
      // Announce vote count
      this.net.broadcastGameMessage({
        type: 'play_again_count',
        count: this._playAgainSet.size,
        total: players.length
      });
    }
  }

  _hideExchangeBanner() {
    const banner = document.getElementById('exchange-banner');
    if (banner) banner.classList.add('hidden');
    const confirmBtn = document.getElementById('btn-confirm-exchange');
    const playBtn = document.getElementById('btn-play');
    const passBtn = document.getElementById('btn-pass');
    if (confirmBtn) confirmBtn.classList.add('hidden');
    if (playBtn) playBtn.classList.remove('hidden');
    if (passBtn) passBtn.classList.remove('hidden');
    this._exchangeSubmitted = false; // reset for next round
  }

  _tryShowReceivedModal() {
    if (this._receivedModalShown || !this._pendingReceivedCardIds) return;
    const hand = this.game.getLocalHand() || [];
    if (hand.length === 0) return; // hand not arrived yet — wait

    // Stamp isNew on matching cards
    const ids = this._pendingReceivedCardIds;
    const matched = [];
    ids.forEach(id => {
      const card = hand.find(c => c.id === id);
      if (card) { card.isNew = true; matched.push(card); }
    });

    if (matched.length === 0) return; // cards not in hand yet — wait for next state sync

    this._pendingReceivedCardIds = null; // consume
    this._showReceivedCardsToast();
  }

  _showReceivedCardsToast() {
    if (this._receivedModalShown) return;
    const hand = this.game.getLocalHand() || [];
    // Snapshot received cards immediately before any async state updates
    const newCards = hand.filter(c => c.isNew).map(c => ({ ...c }));
    if (newCards.length === 0) return;

    // Clear isNew immediately so state syncs don't affect the display
    hand.forEach(c => { delete c.isNew; });

    this._receivedModalShown = true;

    const modal = document.getElementById('modal-received');
    const cardsContainer = document.getElementById('modal-received-cards');
    const okBtn = document.getElementById('btn-modal-received-ok');
    if (!modal || !cardsContainer || !okBtn) return;

    cardsContainer.innerHTML = '';
    newCards.forEach(card => {
      const el = UI.createCardEl(card, { playable: true });
      el.style.margin = '0';
      cardsContainer.appendChild(el);
    });

    modal.classList.remove('hidden');

    // Replace button with a clone to remove ALL previous listeners
    const freshBtn = okBtn.cloneNode(true);
    okBtn.parentNode.replaceChild(freshBtn, okBtn);
    freshBtn.addEventListener('click', () => {
      modal.classList.add('hidden');
      this._receivedModalShown = false;
    }, { once: true });
  }

  renderExchangeOnGameScreen() {
    const g = this.game;
    const localId = g.players[this.localPlayerIndex]?.id;
    const exchangeInfo = g.getExchangeInfo();        // null if Beggar/Commoner (auto-submitted)
    const newHand = g.getLocalExchangeHand();         // freshly dealt hand for this player

    const banner = document.getElementById('exchange-banner');
    const bannerTitle = document.getElementById('exchange-banner-title');
    const bannerDesc = document.getElementById('exchange-banner-desc');
    const playBtn = document.getElementById('btn-play');
    const passBtn = document.getElementById('btn-pass');
    const confirmBtn = document.getElementById('btn-confirm-exchange');
    const selInfo = document.getElementById('selected-info');
    const handEl = document.getElementById('hand-cards');

    // Always show banner, hide play/pass
    if (banner) banner.classList.remove('hidden');
    if (playBtn) playBtn.classList.add('hidden');
    if (passBtn) passBtn.classList.add('hidden');

    const alreadySubmitted = exchangeInfo === null && localId &&
      g.exchangePending.some(e => e.giverId === localId);

    if (!newHand) {
      // No exchange for this player at all (e.g. 2-3 player game fallback)
      if (bannerTitle) bannerTitle.textContent = 'CARD EXCHANGE';
      if (bannerDesc) bannerDesc.textContent = 'Waiting for other players...';
      if (confirmBtn) confirmBtn.classList.add('hidden');
      if (selInfo) selInfo.textContent = '';
      return;
    }

    // Determine role
    const isMustGiveBest = !exchangeInfo; // Beggar/Commoner auto-submitted, now waiting
    const required = exchangeInfo ? exchangeInfo.count : 0;

    // Build rank label for banner
    const localPlayer = g.players[this.localPlayerIndex];
    const rankLabel = localPlayer?.rank ? localPlayer.rank.toUpperCase() : '';

    // Check if this player already submitted (Tycoon/Rich who confirmed)
    const alreadySubmittedAsChooser = this._exchangeSubmitted;

    if (!exchangeInfo || alreadySubmittedAsChooser) {
      if (bannerTitle) bannerTitle.textContent = '⚔ CARD EXCHANGE — ' + rankLabel;
      const myPending = g.exchangePending.find(e => e.giverId === localId);

      if (alreadySubmittedAsChooser) {
        // Tycoon/Rich confirmed — waiting for others
        if (bannerDesc) bannerDesc.textContent = 'Cards submitted. Waiting for all players to complete their exchange...';
        if (confirmBtn) confirmBtn.classList.add('hidden');
        if (selInfo) selInfo.textContent = 'Waiting for other players...';
        this._renderExchangeHand(newHand, new Set(), 0, false);
      } else {
        // Beggar/Poor — auto-submitted, show what they're giving away
        if (myPending && bannerDesc) {
          const newHandSorted = [...newHand].sort((a,b) => Cards.cardStrength(a,false) - Cards.cardStrength(b,false));
          const giving = newHandSorted.slice(-myPending.count);
          const givingNames = giving.map(c => Cards.cardDisplayName(c)).join(' & ');
          bannerDesc.textContent = `Your ${myPending.count} highest card${myPending.count > 1 ? 's' : ''} (${givingNames}) will be given away. Waiting for others to select...`;
        }
        if (confirmBtn) confirmBtn.classList.add('hidden');
        if (selInfo) selInfo.textContent = 'Waiting for other players...';
        this._renderExchangeHand(newHand, null, myPending?.count || 0, false);
      }
      return;
    }

    // Tycoon or Rich — must choose cards to give
    if (bannerTitle) bannerTitle.textContent = '⚔ CARD EXCHANGE — ' + rankLabel;
    if (bannerDesc) bannerDesc.textContent = `Choose ${required} card${required > 1 ? 's' : ''} to give away to the lower-ranked player.`;

    if (confirmBtn) {
      confirmBtn.classList.remove('hidden');
      confirmBtn.disabled = this.exchangeSelected.size !== required;
      confirmBtn.onclick = () => this.submitExchangeFromGame();
    }
    if (selInfo) selInfo.textContent = `${this.exchangeSelected.size}/${required} selected`;

    this._renderExchangeHand(newHand, this.exchangeSelected, required, true);
  }

  _renderExchangeHand(newHand, selectedIds, requiredCount, isChooser) {
    const handEl = document.getElementById('hand-cards');
    if (!handEl) return;
    handEl.innerHTML = '';

    const sorted = Cards.sortHand(newHand, false);

    // For non-choosers: mark top N as "locked to give away"
    let lockedIds = new Set();
    if (!isChooser && requiredCount > 0) {
      sorted.slice(-requiredCount).forEach(c => lockedIds.add(c.id));
    }

    sorted.forEach(card => {
      const isLocked = lockedIds.has(card.id);
      const isSelected = selectedIds ? selectedIds.has(card.id) : false;

      const el = UI.createCardEl(card, {
        selected: isSelected,
        playable: isChooser || isLocked // dim everything that's neither selectable nor locked
      });

      // Locked cards (Beggar/Commoner's top N) get a special highlight
      if (isLocked) {
        el.classList.add('exchange-locked');
      }

      // Non-chooser, non-locked cards: dim them
      if (!isChooser && !isLocked) {
        el.style.opacity = '0.4';
        el.style.cursor = 'not-allowed';
      }

      if (isChooser) {
        el.style.cursor = 'pointer';
        el.style.marginLeft = ''; // reset — hand-cards handles overlap
        el.addEventListener('click', () => {
          if (selectedIds.has(card.id)) selectedIds.delete(card.id);
          else selectedIds.add(card.id);
          this.renderExchangeOnGameScreen();
        });
      }

      handEl.appendChild(el);
    });
  }

  submitExchangeFromGame() {
    const g = this.game;
    const newHand = g.getLocalExchangeHand();
    if (!newHand) return;
    const cards = [...this.exchangeSelected]
      .map(id => newHand.find(c => c.id === id))
      .filter(Boolean);
    const exchangeInfo = g.getExchangeInfo();
    if (!exchangeInfo || cards.length !== exchangeInfo.count) return;
    this.exchangeSelected.clear();
    this._exchangeSubmitted = true; // flag: waiting for others after we submit
    this.net.sendToHost({ type: 'exchange_submit', cards });
    // Re-render to show waiting state immediately
    this.renderExchangeOnGameScreen();
  }

  // Legacy — kept for compat but no longer used
  renderExchangeScreen() { this.renderExchangeOnGameScreen(); }
  toggleExchangeCard(card) {}
  submitExchange(cards) {}
}

window.addEventListener('DOMContentLoaded', () => {
  if (typeof Peer === 'undefined') return;
  window.app = new TycoonApp();
});
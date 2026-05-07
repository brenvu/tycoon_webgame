// ============================================================
// TYCOON — Main Application Controller
// ============================================================

// Avatar files available in the repo (populated dynamically)
// For GitHub Pages these must be committed to /avatars/
// We attempt to load a manifest, then fall back to known files

const KNOWN_AVATARS = [
  'Ren_Amamiya.png'
  // Add more as you commit avatar images to the /avatars/ folder
];

class TycoonApp {
  constructor() {
    this.net = new TycoonNetwork();
    this.game = new TycoonGame();
    this.localId = null;
    this.localPlayerIndex = -1;
    this.selectedCards = new Set(); // card IDs selected in hand
    this.exchangeSelected = new Set();
    this.isHost = false;
    this.playerInfo = { nickname: 'Phantom', avatar: '' };
    this.pendingExchange = null;

    // Wire game callbacks
    this.game.onStateChange = (state) => this.onGameStateChange(state);
    this.game.onActionLog = (msg) => UI.addLogEntry(msg);

    this.init();
  }

  init() {
    this.loadProfile();
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
    try { localStorage.setItem('tycoon_profile', JSON.stringify(this.playerInfo)); } catch(e) {}
  }

  populateAvatars() {
    // Try fetching avatars manifest first
    fetch('avatars/manifest.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(list => UI.populateAvatarSelect(list))
      .catch(() => {
        // Fall back to known list
        UI.populateAvatarSelect(KNOWN_AVATARS);
        // Try to detect files by probing
        this._probeAvatars();
      });
  }

  async _probeAvatars() {
    // Probe for common avatar filenames
    const sel = document.getElementById('select-avatar');
    if (!sel) return;
    // Already populated with KNOWN_AVATARS, nothing more to do unless manifest exists
  }

  // ---- Lobby UI ----

  setupLobbyUI() {
    document.getElementById('btn-host').addEventListener('click', () => this.hostGame());
    document.getElementById('btn-join').addEventListener('click', () => this.joinGame());
    document.getElementById('btn-copy-code').addEventListener('click', () => this.copyRoomCode());
    document.getElementById('btn-start-game').addEventListener('click', () => this.startGame());
    document.getElementById('btn-next-round').addEventListener('click', () => this.nextRound());
    document.getElementById('btn-play-again').addEventListener('click', () => location.reload());
    document.getElementById('btn-play').addEventListener('click', () => this.submitPlay());
    document.getElementById('btn-pass').addEventListener('click', () => this.submitPass());

    // Enter key for room code
    document.getElementById('input-room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinGame();
    });

    // Nickname update on blur
    document.getElementById('input-nickname').addEventListener('blur', () => this.saveProfile());
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

  async hostGame() {
    this.saveProfile();
    if (!this.playerInfo.nickname) { this.showError('Please enter a nickname.'); return; }

    const hostBtn = document.getElementById('btn-host');
    hostBtn.disabled = true;
    hostBtn.textContent = 'CONNECTING...';

    this.net = new TycoonNetwork();
    this.isHost = true;

    this.net.onRoomReady = (code) => {
      document.getElementById('display-room-code').textContent = code;
      document.getElementById('waiting-room').classList.remove('hidden');
      hostBtn.textContent = 'CREATE ROOM';
      hostBtn.disabled = false;
    };

    this.net.onPlayerJoined = (player) => {
      UI.showToast(`${player.nickname} joined!`);
      this.renderWaiting();
    };

    this.net.onPlayerLeft = (id) => {
      UI.showToast('A player disconnected.');
      this.renderWaiting();
    };

    this.net.onConnectionChange = () => this.renderWaiting();

    this.net.onGameAction = (action, fromId) => this.handleRemoteAction(action, fromId);

    this.net.onError = (msg) => {
      this.showError(msg);
      hostBtn.textContent = 'CREATE ROOM';
      hostBtn.disabled = false;
    };

    try {
      await this.net.host(this.playerInfo);
      this.localId = this.net.getLocalId();
      this.renderWaiting();
    } catch(e) {
      hostBtn.textContent = 'CREATE ROOM';
      hostBtn.disabled = false;
    }
  }

  async joinGame() {
    this.saveProfile();
    const code = document.getElementById('input-room-code').value.trim().toUpperCase();
    if (!code || code.length < 4) { this.showError('Enter a valid room code.'); return; }
    if (!this.playerInfo.nickname) { this.showError('Please enter a nickname.'); return; }

    const joinBtn = document.getElementById('btn-join');
    joinBtn.disabled = true;
    joinBtn.textContent = 'JOINING...';

    this.net = new TycoonNetwork();
    this.isHost = false;

    this.net.onJoinSuccess = () => {
      document.getElementById('display-room-code').textContent = code;
      document.getElementById('waiting-room').classList.remove('hidden');
      joinBtn.textContent = 'JOIN ROOM';
      joinBtn.disabled = false;
      this.renderWaiting();
    };

    this.net.onPlayerJoined = (player) => {
      UI.showToast(`${player.nickname} joined!`);
      this.renderWaiting();
    };

    this.net.onPlayerLeft = (id) => {
      UI.showToast('A player disconnected.');
      this.renderWaiting();
    };

    this.net.onConnectionChange = () => this.renderWaiting();

    this.net.onGameAction = (action, fromId) => this.handleRemoteAction(action, fromId);

    this.net.onError = (msg) => {
      this.showError(msg);
      joinBtn.textContent = 'JOIN ROOM';
      joinBtn.disabled = false;
    };

    try {
      await this.net.join(code, this.playerInfo);
      this.localId = this.net.getLocalId();
    } catch(e) {
      joinBtn.textContent = 'JOIN ROOM';
      joinBtn.disabled = false;
    }
  }

  renderWaiting() {
    const players = this.net.getPlayers();
    UI.renderWaitingRoom(players, this.isHost, this.localId);
  }

  copyRoomCode() {
    const code = document.getElementById('display-room-code').textContent;
    navigator.clipboard.writeText(code).then(() => {
      UI.showToast('Room code copied!');
    }).catch(() => {
      UI.showToast(`Room code: ${code}`);
    });
  }

  // ---- Game Start ----

  startGame() {
    if (!this.isHost) return;
    const players = this.net.getPlayers();
    if (players.length < 2) { this.showError('Need at least 2 players to start.'); return; }

    // Host sends start signal to all guests
    this.net.broadcastAction({ type: 'game_start', players }, null);

    // Host initializes game locally
    this._initGameLocally(players);
  }

  _initGameLocally(netPlayers) {
    this.game.reset();

    netPlayers.forEach(p => {
      this.game.addPlayer(p.id, p.nickname, p.avatar);
    });

    this.localPlayerIndex = this.game.players.findIndex(p => p.id === this.localId);
    this.game.localPlayerIndex = this.localPlayerIndex;
    this.game.hostIndex = 0;

    UI.showScreen('game');
    this.game.startRound();

    if (this.isHost) {
      // Broadcast full state including all hands to respective players
      this._broadcastFullState();
    }
  }

  _broadcastFullState() {
    if (!this.isHost) return;
    // Build per-player states
    this.net.connections.forEach(conn => {
      const guestId = conn.peer;
      const guestIdx = this.game.players.findIndex(p => p.id === guestId);
      if (guestIdx === -1) return;

      const state = {
        type: 'full_state',
        players: this.game.players.map((p, i) => ({
          id: p.id, nickname: p.nickname, avatar: p.avatar,
          rank: p.rank, score: p.score,
          hand: i === guestIdx ? p.hand : [], // only send that player's hand
          handCount: p.hand.length,
          finished: p.finished, finishPosition: p.finishPosition
        })),
        round: this.game.round,
        currentTurn: this.game.currentTurn,
        currentPlay: this.game.currentPlay,
        pile: this.game.pile,
        revolutionActive: this.game.revolutionActive,
        finishOrder: this.game.finishOrder,
        turnTimer: this.game.turnTimer,
        phase: this.game.phase,
        localPlayerIndex: guestIdx,
        exchangePending: this.game.exchangePending,
        exchangesDone: [...this.game.exchangesDone]
      };
      conn.send({ type: 'state_sync', state });
    });
  }

  // ---- Remote Action Handling ----

  handleRemoteAction(action, fromId) {
    if (!action) return;

    switch (action.type) {
      case 'game_start':
        // Guest receives start signal
        if (!this.isHost) {
          this._initGameLocally(action.players);
        }
        break;

      case 'state_sync':
      case 'full_state':
        // Guest receives state from host
        if (!this.isHost) {
          this._applyRemoteState(action.state || action);
        }
        break;

      case 'play_cards':
        if (this.isHost) {
          const result = this.game.playCards(fromId, action.cards);
          if (!result.ok) {
            // Send error back
            const conn = this.net.connections.find(c => c.peer === fromId);
            if (conn) conn.send({ type: 'action', action: { type: 'play_error', reason: result.reason } });
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
          this.game.submitExchange(fromId, action.cards);
          this._broadcastFullState();
        }
        break;

      case 'play_error':
        UI.showToast(`Invalid play: ${action.reason}`, 3000);
        break;

      case 'next_round':
        if (this.isHost) {
          this.game.setupExchange();
          this._broadcastFullState();
        }
        break;
    }
  }

  _applyRemoteState(state) {
    if (!state) return;

    // Update local game state from host
    const g = this.game;
    g.round = state.round;
    g.currentTurn = state.currentTurn;
    g.currentPlay = state.currentPlay;
    g.pile = state.pile || [];
    g.revolutionActive = state.revolutionActive;
    g.finishOrder = state.finishOrder || [];
    g.turnTimer = state.turnTimer;
    g.phase = state.phase;
    g.exchangePending = state.exchangePending || [];
    g.exchangesDone = new Set(state.exchangesDone || []);

    if (state.localPlayerIndex !== undefined) {
      this.localPlayerIndex = state.localPlayerIndex;
      g.localPlayerIndex = state.localPlayerIndex;
    }

    // Update players
    if (state.players) {
      state.players.forEach((sp, i) => {
        if (!g.players[i]) g.players[i] = {};
        const lp = g.players[i];
        lp.id = sp.id;
        lp.nickname = sp.nickname;
        lp.avatar = sp.avatar;
        lp.rank = sp.rank;
        lp.score = sp.score;
        lp.finished = sp.finished;
        lp.finishPosition = sp.finishPosition;
        lp.handCount = sp.handCount !== undefined ? sp.handCount : (sp.hand ? sp.hand.length : lp.handCount);
        if (sp.hand && sp.hand.length > 0) {
          lp.hand = sp.hand;
        } else if (sp.handCount !== undefined && lp.hand) {
          // Keep local hand if counts match
          if (lp.hand.length !== sp.handCount) lp.hand = [];
        }
      });
      while (g.players.length > state.players.length) g.players.pop();
    }

    // Trigger UI update
    this.renderGameState();

    // Handle screen transitions
    if (state.phase === 'exchange') {
      UI.showScreen('exchange');
      this.renderExchangeScreen();
    } else if (state.phase === 'playing') {
      UI.showScreen('game');
    } else if (state.phase === 'round_end') {
      UI.showScreen('round-end');
      UI.renderRoundEnd(g.players, g.round, g.finishOrder);
    } else if (state.phase === 'game_over') {
      UI.showScreen('gameover');
      UI.renderGameOver(g.players);
    }
  }

  // ---- Game State Changes ----

  onGameStateChange(state) {
    this.renderGameState();

    const phase = state.phase;

    if (phase === 'exchange') {
      UI.showScreen('exchange');
      this.renderExchangeScreen();
      if (this.isHost) this._broadcastFullState();
    } else if (phase === 'playing') {
      UI.showScreen('game');
      if (this.isHost) this._broadcastFullState();
    } else if (phase === 'round_end') {
      UI.showScreen('round-end');
      UI.renderRoundEnd(state.players, state.round, state.finishOrder);
      if (this.isHost) this._broadcastFullState();
    } else if (phase === 'game_over') {
      UI.showScreen('gameover');
      UI.renderGameOver(state.players);
      if (this.isHost) this._broadcastFullState();
    }
  }

  renderGameState() {
    const g = this.game;
    const state = g.getState();
    const localPlayer = g.players[this.localPlayerIndex];
    const hand = g.getLocalHand();

    // Update round display
    const rdEl = document.getElementById('display-round');
    if (rdEl) rdEl.textContent = g.round;

    // Scores
    UI.renderScoresMini(state.players);

    // Local player info
    UI.renderLocalPlayer(localPlayer, g.revolutionActive);

    // Opponents
    UI.renderOpponents(state.players, this.localPlayerIndex, g.currentTurn, g.revolutionActive);

    // Pile
    UI.renderPile(g.pile, g.currentPlay);

    // Revolution
    UI.renderRevolution(g.revolutionActive);

    // Timer
    UI.renderTimer(g.turnTimer);

    // Determine playable cards
    const isMyTurn = g.isPlayerTurn(this.localId);
    let playableIds = null;
    if (isMyTurn) {
      playableIds = Cards.getPlayableCards(hand, g.currentPlay, g.revolutionActive);
    }

    // Render hand
    UI.renderHand(hand, this.selectedCards, playableIds, (card) => this.toggleCard(card), g.revolutionActive);

    // Action buttons
    const playBtn = document.getElementById('btn-play');
    const passBtn = document.getElementById('btn-pass');
    const selInfo = document.getElementById('selected-info');

    if (playBtn) playBtn.disabled = !isMyTurn || this.selectedCards.size === 0;
    if (passBtn) passBtn.disabled = !isMyTurn || !g.currentPlay; // can't pass on empty pile (must play)

    // Actually: you CAN pass even on your own open -- only restriction is no passing to start
    if (passBtn && isMyTurn) passBtn.disabled = false;
    if (passBtn && !isMyTurn) passBtn.disabled = true;

    if (selInfo) {
      if (!isMyTurn) {
        const curr = g.players[g.currentTurn];
        selInfo.textContent = curr ? `Waiting for ${curr.nickname}...` : 'Waiting...';
      } else if (this.selectedCards.size > 0) {
        selInfo.textContent = `${this.selectedCards.size} card(s) selected`;
      } else {
        selInfo.textContent = 'Your turn — select cards to play';
      }
    }

    // Highlight current turn player name
    document.querySelectorAll('.opponent-panel').forEach(el => el.classList.remove('active-turn'));
  }

  // ---- Card Selection ----

  toggleCard(card) {
    const g = this.game;
    if (!g.isPlayerTurn(this.localId)) return;

    const playableIds = Cards.getPlayableCards(g.getLocalHand(), g.currentPlay, g.revolutionActive);
    if (!playableIds.has(card.id)) return;

    if (this.selectedCards.has(card.id)) {
      this.selectedCards.delete(card.id);
    } else {
      this.selectedCards.add(card.id);
    }

    this.renderGameState();
  }

  // ---- Actions ----

  submitPlay() {
    if (this.selectedCards.size === 0) return;
    const hand = this.game.getLocalHand();
    const cards = [...this.selectedCards].map(id => hand.find(c => c.id === id)).filter(Boolean);

    if (this.isHost) {
      const result = this.game.playCards(this.localId, cards);
      if (!result.ok) {
        UI.showToast(result.reason, 3000);
        return;
      }
    } else {
      this.net.sendAction({ type: 'play_cards', cards });
      // Optimistic: remove from local display (will be confirmed by host state)
    }

    this.selectedCards.clear();
    this.renderGameState();
  }

  submitPass() {
    if (this.isHost) {
      this.game.pass(this.localId);
    } else {
      this.net.sendAction({ type: 'pass_turn' });
    }
  }

  nextRound() {
    if (this.isHost) {
      this.game.setupExchange();
    } else {
      this.net.sendAction({ type: 'next_round' });
    }
  }

  // ---- Exchange ----

  renderExchangeScreen() {
    const g = this.game;
    const exchangeInfo = g.getExchangeInfo();

    if (!exchangeInfo) {
      // No exchange needed for this player, wait
      document.getElementById('exchange-title').textContent = 'WAITING...';
      document.getElementById('exchange-desc').textContent = 'Waiting for other players to exchange cards...';
      document.getElementById('exchange-hand').innerHTML = '';
      document.getElementById('btn-confirm-exchange').disabled = true;
      return;
    }

    this.pendingExchange = exchangeInfo;

    UI.renderExchange(
      exchangeInfo,
      g.getLocalHand(),
      this.exchangeSelected,
      (card) => this.toggleExchangeCard(card),
      (cards) => this.submitExchange(cards),
      g.revolutionActive
    );
  }

  toggleExchangeCard(card) {
    if (this.exchangeSelected.has(card.id)) {
      this.exchangeSelected.delete(card.id);
    } else {
      this.exchangeSelected.add(card.id);
    }
    this.renderExchangeScreen();
  }

  submitExchange(cards) {
    this.exchangeSelected.clear();
    if (this.isHost) {
      this.game.submitExchange(this.localId, cards);
    } else {
      this.net.sendAction({ type: 'exchange_submit', cards });
    }
  }
}

// ---- Boot ----
window.addEventListener('DOMContentLoaded', () => {
  // Load PeerJS from CDN (needed for WebRTC)
  const script = document.createElement('script');
  script.src = 'https://unpkg.com/peerjs@1.5.2/dist/peerjs.min.js';
  script.onload = () => {
    window.app = new TycoonApp();
  };
  script.onerror = () => {
    // Fallback CDN
    const s2 = document.createElement('script');
    s2.src = 'https://cdn.jsdelivr.net/npm/peerjs@1.5.2/dist/peerjs.min.js';
    s2.onload = () => { window.app = new TycoonApp(); };
    document.head.appendChild(s2);
  };
  document.head.appendChild(script);
});

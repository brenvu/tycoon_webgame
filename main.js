// ============================================================
// TYCOON — Main Application Controller
// ============================================================

const KNOWN_AVATARS = [
  'Ren Amamiya.png'
];

class TycoonApp {
  constructor() {
    this.net = new TycoonNetwork();
    this.game = new TycoonGame();
    this.localId = null;
    this.localPlayerIndex = -1;
    this.selectedCards = new Set();
    this.exchangeSelected = new Set();
    this.isHost = false;
    this.playerInfo = { nickname: 'Phantom', avatar: '' };
    this.pendingExchange = null;

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
    fetch('avatars/manifest.json')
      .then(r => r.ok ? r.json() : Promise.reject())
      .then(list => UI.populateAvatarSelect(list))
      .catch(() => UI.populateAvatarSelect(KNOWN_AVATARS));
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

    document.getElementById('input-room-code').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') this.joinGame();
    });

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

  _wireNet() {
    this.net.onPlayerJoined = (player) => {
      UI.showToast(player.nickname + ' joined!');
      this.renderWaiting();
    };
    this.net.onPlayerLeft = () => {
      UI.showToast('A player disconnected.');
      this.renderWaiting();
    };
    this.net.onConnectionChange = () => this.renderWaiting();
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
      document.getElementById('display-room-code').textContent = code;
      document.getElementById('waiting-room').classList.remove('hidden');
      hostBtn.textContent = 'CREATE ROOM';
      hostBtn.disabled = false;
    };
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
    const raw = document.getElementById('input-room-code').value.trim().toUpperCase().replace(/\s/g, '');
    if (!raw || raw.length < 4 || raw.length > 8) {
      this.showError('Enter the 6-character room code shown on the host\'s screen.');
      return;
    }
    if (!this.playerInfo.nickname) { this.showError('Please enter a nickname.'); return; }

    const joinBtn = document.getElementById('btn-join');
    joinBtn.disabled = true;
    joinBtn.textContent = 'JOINING...';

    this.net = new TycoonNetwork();
    this.isHost = false;
    this._wireNet();

    this.net.onJoinSuccess = () => {
      document.getElementById('display-room-code').textContent = raw;
      document.getElementById('waiting-room').classList.remove('hidden');
      joinBtn.textContent = 'JOIN ROOM';
      joinBtn.disabled = false;
      this.renderWaiting();
    };
    this.net.onError = (msg) => {
      this.showError(msg);
      joinBtn.textContent = 'JOIN ROOM';
      joinBtn.disabled = false;
    };

    try {
      await this.net.join(raw, this.playerInfo);
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
    const code = document.getElementById('display-room-code').textContent.trim();
    navigator.clipboard.writeText(code).then(() => {
      UI.showToast('Room code copied!');
      const btn = document.getElementById('btn-copy-code');
      btn.textContent = '✓ Copied';
      setTimeout(() => { btn.textContent = '⧉ Copy'; }, 2000);
    }).catch(() => UI.showToast('Room code: ' + code));
  }

  // ---- Game Start ----

  startGame() {
    if (!this.isHost) return;
    const players = this.net.getPlayers();
    if (players.length < 2) { this.showError('Need at least 2 players to start.'); return; }

    // Tell guests to start
    this.net.broadcastGameMessage({ type: 'game_start', players });

    // Host initializes locally
    this._initGameLocally(players);
  }

  _initGameLocally(netPlayers) {
    this.game.reset();
    netPlayers.forEach(p => this.game.addPlayer(p.id, p.nickname, p.avatar));

    this.localPlayerIndex = this.game.players.findIndex(p => p.id === this.localId);
    this.game.localPlayerIndex = this.localPlayerIndex;
    this.game.hostIndex = 0;

    UI.showScreen('game');
    this.game.startRound();

    if (this.isHost) {
      this._broadcastFullState();
    }
  }

  _broadcastFullState() {
    if (!this.isHost) return;
    this.net.broadcastPerPlayerState((guestPeerId) => {
      const guestIdx = this.game.players.findIndex(p => p.id === guestPeerId);
      if (guestIdx === -1) return null;

      return {
        type: 'state_sync',
        state: {
          players: this.game.players.map((p, i) => ({
            id: p.id, nickname: p.nickname, avatar: p.avatar,
            rank: p.rank, score: p.score,
            hand: i === guestIdx ? p.hand : [],
            handCount: p.hand.length,
            finished: p.finished, finishPosition: p.finishPosition
          })),
          round:           this.game.round,
          currentTurn:     this.game.currentTurn,
          currentPlay:     this.game.currentPlay,
          pile:            this.game.pile,
          revolutionActive: this.game.revolutionActive,
          finishOrder:     this.game.finishOrder,
          turnTimer:       this.game.turnTimer,
          phase:           this.game.phase,
          localPlayerIndex: guestIdx,
          exchangePending: this.game.exchangePending,
          exchangesDone:   [...this.game.exchangesDone]
        }
      };
    });
  }

  // ---- Game Message Handling ----

  handleGameMessage(msg, fromId) {
    if (!msg || !msg.type) return;

    switch (msg.type) {

      case 'game_start':
        if (!this.isHost) {
          this._initGameLocally(msg.players);
        }
        break;

      case 'state_sync':
        if (!this.isHost) {
          this._applyRemoteState(msg.state);
        }
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

      case 'play_error':
        UI.showToast('Invalid play: ' + msg.reason, 3000);
        break;
    }
  }

  _applyRemoteState(state) {
    if (!state) return;

    const g = this.game;
    g.round            = state.round;
    g.currentTurn      = state.currentTurn;
    g.currentPlay      = state.currentPlay;
    g.pile             = state.pile || [];
    g.revolutionActive = state.revolutionActive;
    g.finishOrder      = state.finishOrder || [];
    g.turnTimer        = state.turnTimer;
    g.phase            = state.phase;
    g.exchangePending  = state.exchangePending || [];
    g.exchangesDone    = new Set(state.exchangesDone || []);

    if (state.localPlayerIndex !== undefined) {
      this.localPlayerIndex = state.localPlayerIndex;
      g.localPlayerIndex    = state.localPlayerIndex;
    }

    if (state.players) {
      state.players.forEach((sp, i) => {
        if (!g.players[i]) g.players[i] = {};
        const lp      = g.players[i];
        lp.id         = sp.id;
        lp.nickname   = sp.nickname;
        lp.avatar     = sp.avatar;
        lp.rank       = sp.rank;
        lp.score      = sp.score;
        lp.finished   = sp.finished;
        lp.finishPosition = sp.finishPosition;
        lp.handCount  = sp.handCount !== undefined ? sp.handCount : (sp.hand ? sp.hand.length : lp.handCount);
        if (sp.hand && sp.hand.length > 0) {
          lp.hand = sp.hand;
        } else if (sp.handCount !== undefined && lp.hand) {
          if (lp.hand.length !== sp.handCount) lp.hand = [];
        }
      });
      while (g.players.length > state.players.length) g.players.pop();
    }

    this.renderGameState();

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

  // ---- Game State Changes (host-local) ----

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

    const rdEl = document.getElementById('display-round');
    if (rdEl) rdEl.textContent = g.round;

    UI.renderScoresMini(state.players);
    UI.renderLocalPlayer(localPlayer, g.revolutionActive);
    UI.renderOpponents(state.players, this.localPlayerIndex, g.currentTurn, g.revolutionActive);
    UI.renderPile(g.pile, g.currentPlay);
    UI.renderRevolution(g.revolutionActive);
    UI.renderTimer(g.turnTimer);

    const isMyTurn = g.isPlayerTurn(this.localId);
    const playableIds = isMyTurn
      ? Cards.getPlayableCards(hand, g.currentPlay, g.revolutionActive)
      : null;

    UI.renderHand(hand, this.selectedCards, playableIds, (card) => this.toggleCard(card), g.revolutionActive);

    const playBtn = document.getElementById('btn-play');
    const passBtn = document.getElementById('btn-pass');
    const selInfo = document.getElementById('selected-info');

    if (playBtn) playBtn.disabled = !isMyTurn || this.selectedCards.size === 0;
    if (passBtn) passBtn.disabled = !isMyTurn;

    if (selInfo) {
      if (!isMyTurn) {
        const curr = g.players[g.currentTurn];
        selInfo.textContent = curr ? 'Waiting for ' + curr.nickname + '...' : 'Waiting...';
      } else if (this.selectedCards.size > 0) {
        selInfo.textContent = this.selectedCards.size + ' card(s) selected';
      } else {
        selInfo.textContent = 'Your turn — select cards to play';
      }
    }

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
    const hand  = this.game.getLocalHand();
    const cards = [...this.selectedCards].map(id => hand.find(c => c.id === id)).filter(Boolean);

    this.net.sendToHost({ type: 'play_cards', cards });
    this.selectedCards.clear();
    this.renderGameState();
  }

  submitPass() {
    this.net.sendToHost({ type: 'pass_turn' });
  }

  nextRound() {
    this.net.sendToHost({ type: 'next_round' });
  }

  // ---- Exchange ----

  renderExchangeScreen() {
    const g = this.game;
    const exchangeInfo = g.getExchangeInfo();

    if (!exchangeInfo) {
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
    this.net.sendToHost({ type: 'exchange_submit', cards });
  }
}

// ---- Boot ----
window.addEventListener('DOMContentLoaded', () => {
  if (typeof Peer === 'undefined') {
    document.body.innerHTML = '<div style="color:red;font-size:2em;padding:2em">ERROR: PeerJS failed to load. Check your internet connection and reload.</div>';
    return;
  }
  window.app = new TycoonApp();
});

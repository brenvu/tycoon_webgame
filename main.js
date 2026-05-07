// ============================================================
// TYCOON — Main Application Controller
// ============================================================

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

    this.game.onStateChange = (state) => this.onGameStateChange(state);
    this.game.onActionLog = (msg) => UI.addLogEntry(msg);
    this.init();
  }

  init() {
    this.loadProfile();
    this.setupLobbyUI();
    UI.showScreen('lobby');
  }

  loadProfile() {
    try {
      const saved = localStorage.getItem('tycoon_profile');
      if (saved) {
        this.playerInfo = { ...this.playerInfo, ...JSON.parse(saved) };
      }
    } catch(e) {}
    document.getElementById('input-nickname').value = this.playerInfo.nickname;
  }

  setupLobbyUI() {
    document.getElementById('btn-host').addEventListener('click', () => this.hostGame());
    document.getElementById('btn-join').addEventListener('click', () => this.joinGame());
    document.getElementById('btn-start-game').addEventListener('click', () => this.startGame());
    document.getElementById('btn-play').addEventListener('click', () => this.submitPlay());
    document.getElementById('btn-pass').addEventListener('click', () => this.submitPass());
    document.getElementById('btn-next-round').addEventListener('click', () => this.nextRound());
  }

  hostGame() {
    this.isHost = true;
    this.net.host(this.playerInfo).then(code => {
      this.localId = this.net.getLocalId();
      document.getElementById('display-room-code').textContent = code;
      document.getElementById('waiting-room').classList.remove('hidden');
    });
  }

  joinGame() {
    const code = document.getElementById('input-room-code').value.trim();
    this.net.join(code, this.playerInfo).then(() => {
      this.localId = this.net.getLocalId();
      document.getElementById('display-room-code').textContent = code;
      document.getElementById('waiting-room').classList.remove('hidden');
    });
  }

  startGame() {
    if (!this.isHost) return;
    const players = this.net.getPlayers();
    this.net.broadcastGameMessage({ type: 'game_start', players });
    this._initGameLocally(players);
  }

  _initGameLocally(netPlayers) {
    this.game.reset();
    netPlayers.forEach(p => this.game.addPlayer(p.id, p.nickname, p.avatar));
    this.localPlayerIndex = this.game.players.findIndex(p => p.id === this.localId);
    this.game.localPlayerIndex = this.localPlayerIndex;
    
    UI.showScreen('game');
    if (this.isHost) this.game.startRound();
  }

  onGameStateChange(state) {
    this.renderGameState();
    if (this.isHost) this._broadcastFullState();
    
    if (state.phase === 'exchange') {
      UI.showScreen('exchange');
      this.renderExchangeScreen(); //
    } else if (state.phase === 'playing') {
      UI.showScreen('game');
    } else if (state.phase === 'round_end') {
      UI.showScreen('round-end');
      UI.renderRoundEnd(this.game.players, this.game.round, this.game.finishOrder);
    }
  }

  renderExchangeScreen() {
    const g = this.game;
    const exchangeInfo = g.getExchangeInfo();
    
    const title = document.getElementById('exchange-title');
    const desc = document.getElementById('exchange-desc');
    const handEl = document.getElementById('exchange-hand');
    const selInfo = document.getElementById('exchange-selected-info');
    const confirmBtn = document.getElementById('btn-confirm-exchange');

    // FIX: If no exchange is pending for this player, show waiting state
    if (!exchangeInfo) {
      if (title) title.textContent = 'CARD EXCHANGE';
      if (desc) desc.textContent = 'Waiting for other players to choose cards...';
      if (handEl) handEl.innerHTML = '<div class="waiting-spinner"></div>';
      if (selInfo) selInfo.textContent = '';
      if (confirmBtn) confirmBtn.style.display = 'none';
      return;
    }

    if (confirmBtn) confirmBtn.style.display = 'block';
    UI.renderExchange(
      exchangeInfo, 
      g.getLocalHand() || [], 
      this.exchangeSelected, 
      (card) => this.toggleExchangeCard(card), 
      (cards) => this.submitExchange(cards), 
      false
    );
  }

  toggleExchangeCard(card) {
    if (this.exchangeSelected.has(card.id)) this.exchangeSelected.delete(card.id);
    else this.exchangeSelected.add(card.id);
    this.renderExchangeScreen();
  }

  submitExchange(cards) {
    this.exchangeSelected.clear();
    this.net.sendToHost({ type: 'exchange_submit', cards });
  }

  submitPlay() {
    const hand = this.game.getLocalHand();
    const cards = [...this.selectedCards].map(id => hand.find(c => c.id === id));
    this.net.sendToHost({ type: 'play_cards', cards });
    this.selectedCards.clear();
  }

  submitPass() {
    this.net.sendToHost({ type: 'pass_turn' });
  }

  nextRound() {
    if (this.isHost) this.game.setupExchange();
  }

  _broadcastFullState() {
    this.net.broadcastPerPlayerState((peerId) => {
        const pIdx = this.game.players.findIndex(p => p.id === peerId);
        return { type: 'state_sync', state: { ...this.game.getState(), localPlayerIndex: pIdx } };
    });
  }
}

window.app = new TycoonApp();
// ============================================================
// TYCOON — P2P Network Bridge (PeerJS)
// Room code = base-58 encoded PeerJS UUID — no KV store needed.
// Works on GitHub Pages and itch.io with zero server config.
// ============================================================

const BASE58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function uuidToRoomCode(uuid) {
  const hex = uuid.replace(/-/g, '');
  let n = BigInt('0x' + hex);
  const base = BigInt(58);
  let encoded = '';
  while (n > 0n) {
    encoded = BASE58_ALPHABET[Number(n % base)] + encoded;
    n = n / base;
  }
  while (encoded.length < 22) encoded = '1' + encoded;
  return encoded;
}

function roomCodeToUUID(code) {
  let n = 0n;
  const base = BigInt(58);
  for (const ch of code) {
    const val = BASE58_ALPHABET.indexOf(ch);
    if (val === -1) return null;
    n = n * base + BigInt(val);
  }
  const hex = n.toString(16).padStart(32, '0');
  return `${hex.slice(0,8)}-${hex.slice(8,12)}-${hex.slice(12,16)}-${hex.slice(16,20)}-${hex.slice(20,32)}`;
}

function isValidUUID(str) {
  return str && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// Format 22-char code as groups for display/copy
function formatCode(code) {
  // Split as: XXXX-XXXX-XXXX-XXXX-XXXXXX  (4-4-4-4-6)
  return code.slice(0,4) + '-' + code.slice(4,8) + '-' + code.slice(8,12) + '-' + code.slice(12,16) + '-' + code.slice(16,22);
}

function parseEnteredCode(entered) {
  return entered.replace(/[-\s]/g, '').trim();
}

// ============================================================

class TycoonNetwork {
  constructor() {
    this.peer = null;
    this.connections = [];
    this.fullCode = null;
    this.displayCode = null;
    this.isHost = false;
    this.localId = null;
    this.playerInfo = null;

    this.onPlayerJoined     = null;
    this.onPlayerLeft       = null;
    this.onGameAction       = null;
    this.onRoomReady        = null;
    this.onJoinSuccess      = null;
    this.onError            = null;
    this.onConnectionChange = null;

    this.allPlayers = [];
    this.MAX_PLAYERS = 4;
  }

  _initPeer() {
    return new Promise((resolve, reject) => {
      const opts = {
        debug: 0,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:global.stun.twilio.com:3478' }
          ]
        }
      };

      try {
        this.peer = new Peer(opts);
      } catch(e) {
        reject(new Error('PeerJS not loaded. Check your internet connection.'));
        return;
      }

      const timer = setTimeout(() => {
        reject(new Error('Signaling server timeout. Check your connection.'));
      }, 15000);

      this.peer.on('open', id => {
        clearTimeout(timer);
        this.localId = id;
        console.log('[Net] Peer open:', id);
        resolve(id);
      });

      this.peer.on('error', err => {
        clearTimeout(timer);
        console.error('[Net] Error:', err.type, err.message);
        if (this.onError) this.onError(this._friendlyError(err));
        reject(err);
      });

      this.peer.on('connection', conn => {
        if (this.isHost) this._handleIncoming(conn);
      });

      this.peer.on('disconnected', () => {
        console.warn('[Net] Disconnected from broker, reconnecting...');
        setTimeout(() => { try { this.peer.reconnect(); } catch(e) {} }, 3000);
      });
    });
  }

  async host(playerInfo) {
    this.playerInfo = playerInfo;
    this.isHost = true;

    const peerId = await this._initPeer();
    this.fullCode = uuidToRoomCode(peerId);
    this.displayCode = formatCode(this.fullCode);

    this.allPlayers = [{ id: peerId, nickname: playerInfo.nickname, avatar: playerInfo.avatar, isHost: true }];

    console.log('[Net] Room code:', this.displayCode);

    if (this.onRoomReady) this.onRoomReady(this.displayCode);
    if (this.onConnectionChange) this.onConnectionChange();
    return this.displayCode;
  }

  async join(enteredCode, playerInfo) {
    this.playerInfo = playerInfo;
    this.isHost = false;

    const raw = parseEnteredCode(enteredCode);
    if (raw.length !== 22) {
      if (this.onError) this.onError('Room code must be 22 characters (use the full code from the host).');
      throw new Error('bad code length');
    }

    const hostPeerId = roomCodeToUUID(raw);
    if (!isValidUUID(hostPeerId)) {
      if (this.onError) this.onError('Invalid room code. Copy the full code from the host.');
      throw new Error('bad uuid');
    }

    console.log('[Net] Joining peer:', hostPeerId);
    await this._initPeer();

    return new Promise((resolve, reject) => {
      const conn = this.peer.connect(hostPeerId, { reliable: true, serialization: 'json' });

      const timer = setTimeout(() => {
        if (this.onError) this.onError('Could not reach host. Room may be closed or invalid.');
        try { conn.close(); } catch(e) {}
        reject(new Error('timeout'));
      }, 15000);

      conn.on('open', () => {
        clearTimeout(timer);
        console.log('[Net] Connected to host');
        this.connections.push(conn);
        this._setupConn(conn);
        this._send(conn, {
          type: 'join',
          player: { id: this.localId, nickname: playerInfo.nickname, avatar: playerInfo.avatar, isHost: false }
        });
        resolve();
      });

      conn.on('error', err => {
        clearTimeout(timer);
        if (this.onError) this.onError(`Connection failed: ${err.message || err.type}`);
        reject(err);
      });
    });
  }

  _handleIncoming(conn) {
    if (this.allPlayers.length >= this.MAX_PLAYERS) {
      conn.on('open', () => {
        this._send(conn, { type: 'rejected', reason: 'Room is full (4/4 players).' });
        setTimeout(() => conn.close(), 800);
      });
      return;
    }
    conn.on('open', () => {
      console.log('[Net] Incoming:', conn.peer);
      this.connections.push(conn);
      this._setupConn(conn);
    });
    conn.on('error', err => console.error('[Net] Incoming error:', err));
  }

  _setupConn(conn) {
    conn.on('data', data => this._handleMsg(conn, data));
    conn.on('close', () => {
      this.connections = this.connections.filter(c => c !== conn);
      const player = this.allPlayers.find(p => p.id === conn.peer);
      if (player) {
        this.allPlayers = this.allPlayers.filter(p => p.id !== conn.peer);
        if (this.isHost) {
          this.connections.forEach(c => {
            if (c.open) this._send(c, { type: 'player_left', playerId: conn.peer });
          });
        }
        if (this.onPlayerLeft) this.onPlayerLeft(conn.peer);
        if (this.onConnectionChange) this.onConnectionChange();
      }
    });
  }

  _handleMsg(conn, data) {
    if (!data || !data.type) return;
    console.log('[Net] Msg:', data.type, '| host:', this.isHost);

    if (this.isHost) {
      if (data.type === 'join') this._onGuestJoined(conn, data.player);
      else if (data.type === 'action') {
        if (this.onGameAction) this.onGameAction(data.action, conn.peer);
      }
    } else {
      switch (data.type) {
        case 'welcome':
          this.allPlayers = data.players;
          if (this.onJoinSuccess) this.onJoinSuccess();
          if (this.onConnectionChange) this.onConnectionChange();
          break;
        case 'rejected':
          if (this.onError) this.onError(data.reason || 'Rejected by host.');
          conn.close();
          break;
        case 'player_joined':
          if (!this.allPlayers.find(p => p.id === data.player.id)) this.allPlayers.push(data.player);
          if (this.onPlayerJoined) this.onPlayerJoined(data.player);
          if (this.onConnectionChange) this.onConnectionChange();
          break;
        case 'player_left':
          this.allPlayers = this.allPlayers.filter(p => p.id !== data.playerId);
          if (this.onPlayerLeft) this.onPlayerLeft(data.playerId);
          if (this.onConnectionChange) this.onConnectionChange();
          break;
        case 'state_sync':
          if (this.onGameAction) this.onGameAction({ type: 'state_sync', state: data.state }, 'host');
          break;
        case 'action':
          if (this.onGameAction) this.onGameAction(data.action, data.playerId || 'host');
          break;
      }
    }
  }

  _onGuestJoined(conn, player) {
    if (this.allPlayers.find(p => p.id === player.id)) return;
    this.allPlayers.push(player);
    if (this.onPlayerJoined) this.onPlayerJoined(player);
    if (this.onConnectionChange) this.onConnectionChange();

    this._send(conn, { type: 'welcome', players: this.allPlayers });

    this.connections.forEach(c => {
      if (c !== conn && c.open) this._send(c, { type: 'player_joined', player });
    });
  }

  _send(conn, data) {
    if (conn && conn.open) {
      try { conn.send(data); } catch(e) { console.error('[Net] Send error:', e); }
    }
  }

  broadcastState(state) {
    if (!this.isHost) return;
    this.connections.forEach(conn => {
      const filtered = this._filterState(state, conn.peer);
      this._send(conn, { type: 'state_sync', state: filtered });
    });
  }

  broadcastAction(action, sourceId) {
    this.connections.forEach(conn => this._send(conn, { type: 'action', action, playerId: sourceId }));
  }

  sendAction(action) {
    if (this.isHost) {
      if (this.onGameAction) this.onGameAction(action, this.localId);
      return;
    }
    const host = this.connections[0];
    if (host) this._send(host, { type: 'action', action, player: { id: this.localId } });
  }

  _filterState(state, playerId) {
    const s = JSON.parse(JSON.stringify(state));
    s.players = s.players.map(p => {
      if (p.id === playerId) return p;
      const { hand, ...rest } = p;
      return rest;
    });
    return s;
  }

  disconnect() {
    this.connections.forEach(c => { try { c.close(); } catch(e) {} });
    if (this.peer) { try { this.peer.destroy(); } catch(e) {} }
    this.peer = null;
    this.connections = [];
    this.allPlayers = [];
  }

  _friendlyError(err) {
    const t = (err && err.type) || '';
    if (t === 'peer-unavailable') return 'Cannot reach host. The room may be closed or the code is wrong.';
    if (t === 'network') return 'Network error. Check your internet connection.';
    if (t === 'server-error') return 'Signaling server error. Please try again.';
    if (t === 'socket-error' || t === 'socket-closed') return 'Socket error. Please try again.';
    if (t === 'unavailable-id') return 'Could not connect. Please try again.';
    if (t === 'browser-incompatible') return 'Your browser does not support WebRTC. Use Chrome or Firefox.';
    return `Connection error: ${(err && err.message) || t || 'unknown'}`;
  }

  getPlayerCount() { return this.allPlayers.length; }
  getPlayers()     { return this.allPlayers; }
  getLocalId()     { return this.localId; }
}

window.TycoonNetwork = TycoonNetwork;

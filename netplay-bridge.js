// ============================================================
// TYCOON — P2P Network Bridge (PeerJS)
// ============================================================
// Strategy: Host registers with PeerJS using a custom peer ID
// that IS the room code (prefixed to avoid collisions).
// Guest connects using the room code directly — no encoding,
// no KV store, no external services. Works on GitHub Pages
// and itch.io as long as PeerJS broker is reachable.
//
// Room code format: 6 uppercase alphanumeric chars (e.g. "K7X2MP")
// PeerJS peer ID used: "tycoon-" + roomCode (e.g. "tycoon-K7X2MP")
// ============================================================

const PEER_ID_PREFIX = 'tycoon-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';

function generateRoomCode() {
  let code = '';
  for (let i = 0; i < 6; i++) {
    code += CODE_CHARS[Math.floor(Math.random() * CODE_CHARS.length)];
  }
  return code;
}

function codeToPeerId(code) {
  return PEER_ID_PREFIX + code.toUpperCase();
}

function peerIdToCode(peerId) {
  return peerId.replace(PEER_ID_PREFIX, '').toUpperCase();
}

// PeerJS broker options — try multiple in order
const BROKER_CONFIGS = [
  // Official PeerJS cloud (most reliable)
  {
    host: '0.peerjs.com',
    port: 443,
    path: '/',
    secure: true,
    pingInterval: 5000,
    config: {
      iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:global.stun.twilio.com:3478' },
        // Free TURN server for users behind strict NAT
        {
          urls: 'turn:openrelay.metered.ca:80',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        },
        {
          urls: 'turn:openrelay.metered.ca:443',
          username: 'openrelayproject',
          credential: 'openrelayproject'
        }
      ]
    }
  }
];

class TycoonNetwork {
  constructor() {
    this.peer = null;
    this.connections = [];
    this.roomCode = null;       // 6-char display code e.g. "K7X2MP"
    this.isHost = false;
    this.localId = null;
    this.playerInfo = null;
    this._brokerIdx = 0;

    this.onPlayerJoined     = null;
    this.onPlayerLeft       = null;
    this.onGameAction       = null;
    this.onRoomReady        = null; // (roomCode: string)
    this.onJoinSuccess      = null;
    this.onError            = null;
    this.onConnectionChange = null;

    this.allPlayers = [];
    this.MAX_PLAYERS = 4;
  }

  // ---- Internal: create a Peer with a specific ID ----

  _createPeer(customId) {
    return new Promise((resolve, reject) => {
      const brokerOpts = BROKER_CONFIGS[this._brokerIdx % BROKER_CONFIGS.length];
      const opts = { ...brokerOpts };

      let peer;
      try {
        peer = customId ? new Peer(customId, opts) : new Peer(opts);
      } catch(e) {
        reject(new Error('PeerJS failed to initialize: ' + e.message));
        return;
      }

      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error('timeout'));
      }, 12000);

      peer.on('open', id => {
        clearTimeout(timer);
        this.peer = peer;
        this.localId = id;
        console.log('[Net] Peer open, ID:', id);
        resolve(id);
      });

      peer.on('error', err => {
        clearTimeout(timer);
        console.error('[Net] Peer error:', err.type, err.message || '');

        // If the custom ID is already taken, try a new room code
        if (customId && (err.type === 'unavailable-id' || err.type === 'invalid-id')) {
          peer.destroy();
          reject({ type: 'id-taken', err });
        } else {
          peer.destroy();
          reject(err);
        }
      });

      peer.on('connection', conn => {
        if (this.isHost) this._handleIncoming(conn);
      });

      peer.on('disconnected', () => {
        console.warn('[Net] Peer disconnected from broker, reconnecting...');
        setTimeout(() => {
          if (this.peer && !this.peer.destroyed) {
            try { this.peer.reconnect(); } catch(e) {}
          }
        }, 3000);
      });
    });
  }

  // ---- HOST ----

  async host(playerInfo) {
    this.playerInfo = playerInfo;
    this.isHost = true;

    // Try up to 5 different room codes in case of ID collision
    let attempts = 0;
    while (attempts < 5) {
      const code = generateRoomCode();
      const peerId = codeToPeerId(code);
      console.log('[Net] Trying room code:', code, '-> peer ID:', peerId);

      try {
        await this._createPeer(peerId);
        this.roomCode = code;

        this.allPlayers = [{
          id: this.localId,
          nickname: playerInfo.nickname,
          avatar: playerInfo.avatar,
          isHost: true
        }];

        console.log('[Net] Hosting room:', this.roomCode);
        if (this.onRoomReady) this.onRoomReady(this.roomCode);
        if (this.onConnectionChange) this.onConnectionChange();
        return this.roomCode;

      } catch(e) {
        if (e && e.type === 'id-taken') {
          console.warn('[Net] Room code taken, trying another...');
          attempts++;
          continue;
        }
        // Real error
        const msg = this._friendlyError(e.err || e);
        if (this.onError) this.onError(msg);
        throw e;
      }
    }

    const msg = 'Could not create a room after several attempts. Please try again.';
    if (this.onError) this.onError(msg);
    throw new Error(msg);
  }

  // ---- JOIN ----

  async join(enteredCode, playerInfo) {
    this.playerInfo = playerInfo;
    this.isHost = false;

    // Clean and validate the code
    const code = enteredCode.replace(/\s/g, '').toUpperCase();
    if (code.length < 4 || code.length > 8) {
      const msg = 'Invalid room code. Codes are 6 characters (e.g. "K7X2MP").';
      if (this.onError) this.onError(msg);
      throw new Error(msg);
    }

    const hostPeerId = codeToPeerId(code);
    console.log('[Net] Joining host peer ID:', hostPeerId);

    // Initialize our own peer (with random ID)
    try {
      await this._createPeer(null);
    } catch(e) {
      const msg = this._friendlyError(e);
      if (this.onError) this.onError(msg);
      throw e;
    }

    // Connect to host
    return new Promise((resolve, reject) => {
      let conn;
      try {
        conn = this.peer.connect(hostPeerId, {
          reliable: true,
          serialization: 'json',
          metadata: { version: 1 }
        });
      } catch(e) {
        const msg = 'Failed to initiate connection: ' + (e.message || e);
        if (this.onError) this.onError(msg);
        reject(e);
        return;
      }

      const timer = setTimeout(() => {
        const msg = `Room "${code}" not found. Check the code or ask the host to share it again.`;
        if (this.onError) this.onError(msg);
        try { conn.close(); } catch(e2) {}
        reject(new Error('timeout'));
      }, 12000);

      conn.on('open', () => {
        clearTimeout(timer);
        console.log('[Net] Connected to host');
        this.connections.push(conn);
        this._setupConn(conn);
        this._send(conn, {
          type: 'join',
          player: {
            id: this.localId,
            nickname: playerInfo.nickname,
            avatar: playerInfo.avatar,
            isHost: false
          }
        });
        resolve();
      });

      conn.on('error', err => {
        clearTimeout(timer);
        console.error('[Net] Connect error:', err.type, err.message || '');
        const msg = err.type === 'peer-unavailable'
          ? `Room "${code}" not found. Make sure the host has created the room and you have the right code.`
          : this._friendlyError(err);
        if (this.onError) this.onError(msg);
        reject(err);
      });
    });
  }

  // ---- Incoming Connection (host side) ----

  _handleIncoming(conn) {
    if (this.allPlayers.length >= this.MAX_PLAYERS) {
      conn.on('open', () => {
        this._send(conn, { type: 'rejected', reason: 'Room is full (4/4 players).' });
        setTimeout(() => conn.close(), 800);
      });
      return;
    }

    conn.on('open', () => {
      console.log('[Net] Incoming connection:', conn.peer);
      this.connections.push(conn);
      this._setupConn(conn);
    });

    conn.on('error', err => {
      console.error('[Net] Incoming conn error:', err);
    });
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

  // ---- Message Handling ----

  _handleMsg(conn, data) {
    if (!data || !data.type) return;
    console.log('[Net] Msg:', data.type, '| isHost:', this.isHost);

    if (this.isHost) {
      if (data.type === 'join') {
        this._onGuestJoined(conn, data.player);
      } else if (data.type === 'action') {
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
          if (!this.allPlayers.find(p => p.id === data.player.id)) {
            this.allPlayers.push(data.player);
          }
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
    if (this.allPlayers.find(p => p.id === player.id)) return; // dedupe
    this.allPlayers.push(player);

    if (this.onPlayerJoined) this.onPlayerJoined(player);
    if (this.onConnectionChange) this.onConnectionChange();

    // Tell the joiner: welcome + full player list
    this._send(conn, { type: 'welcome', players: this.allPlayers });

    // Tell all other guests about the new player
    this.connections.forEach(c => {
      if (c !== conn && c.open) {
        this._send(c, { type: 'player_joined', player });
      }
    });
  }

  // ---- Sending ----

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
    this.connections.forEach(conn => {
      this._send(conn, { type: 'action', action, playerId: sourceId });
    });
  }

  sendAction(action) {
    if (this.isHost) {
      if (this.onGameAction) this.onGameAction(action, this.localId);
      return;
    }
    const hostConn = this.connections[0];
    if (hostConn) {
      this._send(hostConn, { type: 'action', action, player: { id: this.localId } });
    }
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
    this.roomCode = null;
  }

  _friendlyError(err) {
    if (!err) return 'Unknown connection error.';
    const t = err.type || '';
    if (t === 'peer-unavailable')    return 'Room not found. Check the code and make sure the host has created the room.';
    if (t === 'network')             return 'Network error. Check your internet connection.';
    if (t === 'server-error')        return 'Signaling server error. Please try again in a moment.';
    if (t === 'socket-error' || t === 'socket-closed') return 'Connection lost. Please try again.';
    if (t === 'unavailable-id')      return 'Room ID conflict. Please try again.';
    if (t === 'browser-incompatible') return 'Your browser does not support WebRTC. Please use Chrome or Firefox.';
    if (err instanceof Error)        return err.message;
    return `Connection error: ${err.message || t || 'unknown'}`;
  }

  getPlayerCount() { return this.allPlayers.length; }
  getPlayers()     { return this.allPlayers; }
  getLocalId()     { return this.localId; }
  getRoomCode()    { return this.roomCode; }
}

window.TycoonNetwork = TycoonNetwork;

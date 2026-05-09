// ============================================================
// TYCOON — P2P Network Bridge (PeerJS)
// ============================================================
// Architecture: host-authoritative star topology.
//   Host registers on the PeerJS signaling server with a
//   deterministic peer ID derived from the room code.
//   Guests connect directly to that peer ID.
// ============================================================

const PEER_ID_PREFIX = 'tycoon-room-';
const CODE_CHARS = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // no I/O/1/0

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

// ---- PeerJS configuration ----
// TURN server note: free public TURN servers (openrelay, freeturn) are unreliable.
// For production, get a free Metered.ca API key at https://dashboard.metered.ca
// and replace the TURN URLs below with your credentials.
// Free tier: 200GB/month, enough for many games.
const PEER_CONFIG = {
  debug: 1,
  config: {
    iceServers: [
      // Keep just ONE STUN — multiple STUNs slow discovery without benefit
      { urls: 'stun:stun.l.google.com:19302' },
      // Metered.ca free TURN — reliable, 200GB/month free
      // ⚠️  Replace these with your own credentials from dashboard.metered.ca
      // until you do, we use the public demo credentials (limited bandwidth)
      {
        urls: [
          'turn:a.relay.metered.ca:80',
          'turn:a.relay.metered.ca:80?transport=tcp',
          'turn:a.relay.metered.ca:443',
          'turns:a.relay.metered.ca:443'
        ],
        username:   'e499486a98a6dd4d5b09ee8e',
        credential: 'f7SiN4A8vvFhKGsI'
      }
    ],
    iceTransportPolicy: 'all',
    iceCandidatePoolSize: 2,
    bundlePolicy: 'max-bundle',
    rtcpMuxPolicy: 'require'
  }
};

const OPEN_TIMEOUT_MS = 15000;
const JOIN_TIMEOUT_MS = 15000;

// ============================================================

class TycoonNetwork {
  constructor() {
    this.peer            = null;
    this.connections     = [];
    this.roomCode        = null;
    this.isHost          = false;
    this.localId         = null;
    this.playerInfo      = null;
    this.allPlayers      = [];
    this.MAX_PLAYERS     = 4;

    // Callbacks
    this.onRoomReady        = null;
    this.onJoinSuccess      = null;
    this.onHostLeft         = null;
    this.onPlayerJoined     = null;
    this.onPlayerLeft       = null;
    this.onGameMessage      = null;
    this.onError            = null;
    this.onConnectionChange = null;
  }

  // ----------------------------------------------------------
  // Internal: open a Peer, resolve when broker confirms
  // ----------------------------------------------------------
  _openPeer(customId) {
    return new Promise((resolve, reject) => {
      let peer;
      try {
        peer = customId ? new Peer(customId, PEER_CONFIG) : new Peer(PEER_CONFIG);
      } catch (e) {
        reject(new Error('PeerJS init failed: ' + e.message));
        return;
      }

      const timer = setTimeout(() => {
        peer.destroy();
        reject(new Error('timeout'));
      }, OPEN_TIMEOUT_MS);

      peer.on('open', id => {
        clearTimeout(timer);
        this.peer    = peer;
        this.localId = id;
        console.log('[Net] Peer open ->', id);
        resolve(id);
      });

      peer.on('error', err => {
        clearTimeout(timer);
        console.error('[Net] Peer error:', err.type, err.message || '');
        
        if (customId && (err.type === 'unavailable-id' || err.type === 'invalid-id')) {
          peer.destroy();
          reject({ isIdTaken: true, err });
        } else {
          // Only destroy if it's a fatal setup error, otherwise let it try to recover
          if (err.type === 'browser-incompatible' || err.type === 'server-error') {
            peer.destroy();
          }
          reject(err);
        }
      });

      peer.on('connection', conn => {
        if (this.isHost) this._acceptIncoming(conn);
      });

      peer.on('disconnected', () => {
        console.warn('[Net] Broker disconnected, reconnecting...');
        setTimeout(() => {
          if (this.peer && !this.peer.destroyed) {
            try { this.peer.reconnect(); } catch (_) {}
          }
        }, 3000);
      });
    });
  }

  // ----------------------------------------------------------
  // HOST
  // ----------------------------------------------------------
  async host(playerInfo) {
    this.playerInfo = playerInfo;
    this.isHost     = true;

    for (let attempt = 0; attempt < 5; attempt++) {
      const code   = generateRoomCode();
      const peerId = codeToPeerId(code);
      console.log('[Net] Trying room', code, '->', peerId);

      try {
        await this._openPeer(peerId);
      } catch (e) {
        if (e && e.isIdTaken) {
          console.warn('[Net] ID taken, retrying...');
          continue;
        }
        const msg = this._friendlyError(e.err || e);
        if (this.onError) this.onError(msg);
        throw e;
      }

      this.roomCode   = code;
      this.allPlayers = [{
        id:          this.localId,
        nickname:    playerInfo.nickname,
        avatar:      playerInfo.avatar,
        avatarColor: playerInfo.avatarColor || '#ffffff',
        isHost:      true
      }];

      console.log('[Net] Room ready:', code);
      if (this.onRoomReady)        this.onRoomReady(code);
      if (this.onConnectionChange) this.onConnectionChange();
      return code;
    }

    const msg = 'Could not create a room after several attempts. Please try again.';
    if (this.onError) this.onError(msg);
    throw new Error(msg);
  }

  // ----------------------------------------------------------
  // JOIN
  // ----------------------------------------------------------
  async join(enteredCode, playerInfo) {
    this.playerInfo = playerInfo;
    this.isHost     = false;

    const code = enteredCode.replace(/\s/g, '').toUpperCase();
    if (code.length < 4 || code.length > 8) {
      const msg = 'Invalid room code. Codes are 6 characters.';
      if (this.onError) this.onError(msg);
      throw new Error(msg);
    }

    const hostPeerId = codeToPeerId(code);
    console.log('[Net] Joining ->', hostPeerId);

    try {
      await this._openPeer(null);
    } catch (e) {
      const msg = this._friendlyError(e);
      if (this.onError) this.onError(msg);
      throw e;
    }

    return new Promise((resolve, reject) => {
      let conn;
      try {
        conn = this.peer.connect(hostPeerId, { reliable: true, serialization: 'json' });
      } catch (e) {
        const msg = 'Failed to initiate connection: ' + (e.message || e);
        if (this.onError) this.onError(msg);
        reject(e);
        return;
      }

      const timer = setTimeout(() => {
        try { conn.close(); } catch (_) {}
        const msg = 'Connection timed out. Check the code or your network.';
        if (this.onError) this.onError(msg);
        reject(new Error('join-timeout'));
      }, JOIN_TIMEOUT_MS);

      conn.on('open', () => {
        clearTimeout(timer);
        console.log('[Net] Connected to host');
        this._registerConn(conn);
        this._send(conn, {
          type:   'join',
          player: {
            id:          this.localId,
            nickname:    playerInfo.nickname,
            avatar:      playerInfo.avatar,
            avatarColor: playerInfo.avatarColor || '#ffffff',
            isHost:      false
          }
        });
        resolve();
      });

      conn.on('error', err => {
        clearTimeout(timer);
        console.error('[Net] Connect error:', err);
        const msg = (err.type === 'peer-unavailable')
          ? 'Room "' + code + '" not found.'
          : 'Negotiation failed. This usually happens due to firewall or NAT restrictions.';
        if (this.onError) this.onError(msg);
        reject(err);
      });
    });
  }

  // ----------------------------------------------------------
  // Incoming connection (host side)
  // ----------------------------------------------------------
  _acceptIncoming(conn) {
    if (this.allPlayers.length >= this.MAX_PLAYERS) {
      conn.on('open', () => {
        this._send(conn, { type: 'rejected', reason: 'Room is full (4/4 players).' });
        setTimeout(() => conn.close(), 800);
      });
      return;
    }
    conn.on('open', () => {
      console.log('[Net] Incoming from', conn.peer);
      this._registerConn(conn);
    });
    conn.on('error', err => console.error('[Net] Incoming conn error:', err));
  }

  // ----------------------------------------------------------
  // Register + wire a DataConnection
  // ----------------------------------------------------------
  _registerConn(conn) {
    this.connections.push(conn);

    conn.on('data', data => this._handleMsg(conn, data));

    conn.on('close', () => {
      this.connections = this.connections.filter(c => c !== conn);
      const player = this.allPlayers.find(p => p.id === conn.peer);
      if (!player) return;

      this.allPlayers = this.allPlayers.filter(p => p.id !== conn.peer);

      if (this.isHost) {
        this._broadcast({ type: 'player_left', playerId: conn.peer });
      }

      if (this.onPlayerLeft)       this.onPlayerLeft(conn.peer);
      if (this.onConnectionChange) this.onConnectionChange();
    });
  }

  // ----------------------------------------------------------
  // Message routing
  // ----------------------------------------------------------
  _handleMsg(conn, data) {
    if (!data || !data.type) return;

    if (this.isHost) {
      if (data.type === 'join') {
        this._onGuestJoined(conn, data.player);
      } else {
        if (this.onGameMessage) this.onGameMessage(data, conn.peer);
      }
      return;
    }

    switch (data.type) {
      case 'welcome':
        this.allPlayers = data.players;
        if (this.onJoinSuccess)      this.onJoinSuccess();
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
        if (this.onPlayerJoined)     this.onPlayerJoined(data.player);
        if (this.onConnectionChange) this.onConnectionChange();
        break;
      case 'player_left':
        this.allPlayers = this.allPlayers.filter(p => p.id !== data.playerId);
        if (this.onPlayerLeft)       this.onPlayerLeft(data.playerId);
        if (this.onConnectionChange) this.onConnectionChange();
        break;
      default:
        if (this.onGameMessage) this.onGameMessage(data, 'host');
        break;
    }
  }

  _onGuestJoined(conn, player) {
    if (this.allPlayers.find(p => p.id === player.id)) return;
    // Deduplicate nickname
    player.nickname = this._uniqueNickname(player.nickname);
    this.allPlayers.push(player);

    if (this.onPlayerJoined)     this.onPlayerJoined(player);
    if (this.onConnectionChange) this.onConnectionChange();

    this._send(conn, { type: 'welcome', players: this.allPlayers });

    this.connections.forEach(c => {
      if (c !== conn && c.open) this._send(c, { type: 'player_joined', player });
    });
  }

  // ----------------------------------------------------------
  // Sending
  // ----------------------------------------------------------
  _send(conn, data) {
    if (conn && conn.open) {
      try { conn.send(data); }
      catch (e) { console.error('[Net] Send error:', e); }
    }
  }

  _broadcast(data, excludeConn) {
    this.connections.forEach(c => {
      if (c !== excludeConn) this._send(c, data);
    });
  }

  // ----------------------------------------------------------
  // Public game API
  // ----------------------------------------------------------

  broadcastGameMessage(msg) {
    if (!this.isHost) return;
    this._broadcast(msg);
  }

  broadcastPerPlayerState(buildStateFn) {
    if (!this.isHost) return;
    this.connections.forEach(conn => {
      const msg = buildStateFn(conn.peer);
      if (msg != null) this._send(conn, msg);
    });
  }

  sendToPlayer(peerId, msg) {
    // Send a message to a specific peer (host to guest)
    if (!this.isHost) return;
    const conn = this.connections.find(c => c.peer === peerId);
    if (conn) this._send(conn, msg);
  }

  sendToHost(msg) {
    if (this.isHost) {
      if (this.onGameMessage) this.onGameMessage(msg, this.localId);
      return;
    }
    const hostConn = this.connections[0];
    if (hostConn) this._send(hostConn, msg);
  }

  disconnect() {
    this.connections.forEach(c => { try { c.close(); } catch (_) {} });
    if (this.peer) { try { this.peer.destroy(); } catch (_) {} }
    this.peer         = null;
    this.connections = [];
    this.allPlayers  = [];
    this.roomCode    = null;
  }

  _friendlyError(err) {
    if (!err) return 'Unknown connection error.';
    const t = err.type || '';
    if (t === 'peer-unavailable') return 'Room not found. Check the code and make sure the host has created the room.';
    if (t === 'network')          return 'Network error. Check your internet connection.';
    if (t === 'server-error')     return 'Signaling server error. Please try again.';
    if (t === 'socket-error' || t === 'socket-closed') return 'Connection lost.';
    if (t === 'unavailable-id')    return 'Room ID conflict. Please try again.';
    if (t === 'browser-incompatible') return 'Browser does not support WebRTC.';
    return 'Connection error: ' + (err.message || t || 'unknown');
  }

  _uniqueNickname(base) {
    const existing = this.allPlayers.map(p => p.nickname);
    if (!existing.includes(base)) return base;
    for (let n = 2; n <= 4; n++) {
      const candidate = `${base} ${n}`;
      if (!existing.includes(candidate)) return candidate;
    }
    return base + ' ' + Date.now().toString().slice(-3);
  }

  getPlayerCount() { return this.allPlayers.length; }
  getPlayers()     { return this.allPlayers; }
  getLocalId()     { return this.localId; }
  getRoomCode()    { return this.roomCode; }
}

window.TycoonNetwork = TycoonNetwork;
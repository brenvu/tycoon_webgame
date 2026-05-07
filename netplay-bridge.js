// ============================================================
// TYCOON — P2P Network Bridge (PeerJS)
// ============================================================
// Architecture: host-authoritative star topology.
//   Host registers on the PeerJS signaling server with a
//   deterministic peer ID derived from the room code.
//   Guests connect directly to that peer ID — no KV store,
//   no external lookup. Works on GitHub Pages / itch.io.
//
// Room code: 6 uppercase alphanumeric chars  e.g. "K7X2MP"
// Host peer ID: "tycoon-" + code            e.g. "tycoon-K7X2MP"
// ============================================================

const PEER_ID_PREFIX = 'tycoon-';
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
// Omitting host/port/path uses cloud.peerjs.com — the live public broker.
// The old "0.peerjs.com" host was shut down; omitting it entirely is correct.
const PEER_CONFIG = {
  debug: 0,
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:stun1.l.google.com:19302' },
      {
        urls: [
          'turn:a.relay.metered.ca:80',
          'turn:a.relay.metered.ca:443',
          'turns:a.relay.metered.ca:443'
        ],
        username:   'openrelayproject',
        credential: 'openrelayproject'
      }
    ],
    iceTransportPolicy: 'all'
  }
};

const OPEN_TIMEOUT_MS = 15000;
const JOIN_TIMEOUT_MS = 15000;

// ============================================================

class TycoonNetwork {
  constructor() {
    this.peer        = null;
    this.connections = [];
    this.roomCode    = null;
    this.isHost      = false;
    this.localId     = null;
    this.playerInfo  = null;
    this.allPlayers  = [];
    this.MAX_PLAYERS = 4;

    // Callbacks — set before calling host() / join()
    this.onRoomReady        = null;  // (roomCode: string)
    this.onJoinSuccess      = null;  // ()
    this.onPlayerJoined     = null;  // (player)
    this.onPlayerLeft       = null;  // (playerId)
    this.onGameMessage      = null;  // (msg: object, fromId: string)
    this.onError            = null;  // (msg: string)
    this.onConnectionChange = null;  // ()
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
        peer.destroy();
        if (customId && (err.type === 'unavailable-id' || err.type === 'invalid-id')) {
          reject({ isIdTaken: true, err });
        } else {
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
        id:       this.localId,
        nickname: playerInfo.nickname,
        avatar:   playerInfo.avatar,
        isHost:   true
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
      const msg = 'Invalid room code. Codes are 6 characters (e.g. "K7X2MP").';
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
        const msg = 'Room "' + code + '" not found. Check the code or ask the host to re-share it.';
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
            id:       this.localId,
            nickname: playerInfo.nickname,
            avatar:   playerInfo.avatar,
            isHost:   false
          }
        });
        resolve();
      });

      conn.on('error', err => {
        clearTimeout(timer);
        console.error('[Net] Connect error:', err.type, err.message || '');
        const msg = err.type === 'peer-unavailable'
          ? 'Room "' + code + '" not found. Make sure the host has created the room.'
          : this._friendlyError(err);
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
    console.log('[Net] <-', data.type, '| isHost:', this.isHost);

    if (this.isHost) {
      if (data.type === 'join') {
        this._onGuestJoined(conn, data.player);
      } else {
        // All other messages are game messages from a guest
        if (this.onGameMessage) this.onGameMessage(data, conn.peer);
      }
      return;
    }

    // Guest receives
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
        // game_start, state_sync, action, etc.
        if (this.onGameMessage) this.onGameMessage(data, 'host');
        break;
    }
  }

  _onGuestJoined(conn, player) {
    if (this.allPlayers.find(p => p.id === player.id)) return;
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

  /** Host broadcasts a single message to all guests */
  broadcastGameMessage(msg) {
    if (!this.isHost) return;
    this._broadcast(msg);
  }

  /**
   * Host broadcasts per-player state.
   * buildStateFn(guestPeerId) -> message object (or null to skip)
   */
  broadcastPerPlayerState(buildStateFn) {
    if (!this.isHost) return;
    this.connections.forEach(conn => {
      const msg = buildStateFn(conn.peer);
      if (msg != null) this._send(conn, msg);
    });
  }

  /** Guest (or host acting on itself) sends a game message */
  sendToHost(msg) {
    if (this.isHost) {
      // Route locally so the host handler code doesn't need a special case
      if (this.onGameMessage) this.onGameMessage(msg, this.localId);
      return;
    }
    const hostConn = this.connections[0];
    if (hostConn) this._send(hostConn, msg);
  }

  disconnect() {
    this.connections.forEach(c => { try { c.close(); } catch (_) {} });
    if (this.peer) { try { this.peer.destroy(); } catch (_) {} }
    this.peer        = null;
    this.connections = [];
    this.allPlayers  = [];
    this.roomCode    = null;
  }

  // ----------------------------------------------------------
  _friendlyError(err) {
    if (!err) return 'Unknown connection error.';
    const t = err.type || '';
    if (t === 'peer-unavailable')      return 'Room not found. Check the code and make sure the host has created the room.';
    if (t === 'network')               return 'Network error. Check your internet connection.';
    if (t === 'server-error')          return 'Signaling server error. Please try again in a moment.';
    if (t === 'socket-error' || t === 'socket-closed') return 'Connection lost. Please try again.';
    if (t === 'unavailable-id')        return 'Room ID conflict. Please try again.';
    if (t === 'browser-incompatible')  return 'Your browser does not support WebRTC. Please use Chrome or Firefox.';
    if (err instanceof Error)          return err.message;
    return 'Connection error: ' + (err.message || t || 'unknown');
  }

  getPlayerCount() { return this.allPlayers.length; }
  getPlayers()     { return this.allPlayers; }
  getLocalId()     { return this.localId; }
  getRoomCode()    { return this.roomCode; }
}

window.TycoonNetwork = TycoonNetwork;

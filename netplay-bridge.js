// ============================================================
// TYCOON — NetplayJS P2P Bridge
// Handles room creation, joining, and state sync via WebRTC
// ============================================================

// Since NetplayJS is primarily designed for deterministic rollback netcode,
// we'll use a simpler PeerJS-style WebRTC signaling approach that works on
// GitHub Pages / itch.io with no server required.
// We use a public STUN server + a free signaling server.

class TycoonNetwork {
  constructor() {
    this.peer = null;
    this.connections = []; // DataConnection[]
    this.roomCode = null;
    this.isHost = false;
    this.localId = null;
    this.playerInfo = null; // {nickname, avatar}

    // Callbacks
    this.onPlayerJoined = null;    // (playerInfo, connIdx)
    this.onPlayerLeft = null;      // (playerId)
    this.onGameAction = null;      // (action)
    this.onRoomReady = null;       // (roomCode)
    this.onJoinSuccess = null;     // ()
    this.onError = null;           // (msg)
    this.onConnectionChange = null;// ()

    this.allPlayers = []; // [{id, nickname, avatar, isHost}]
    this.MAX_PLAYERS = 4;
  }

  // ---- Peer Setup ----

  init(playerInfo) {
    this.playerInfo = playerInfo;
    return new Promise((resolve, reject) => {
      // Use PeerJS CDN-hosted server (free, public broker)
      this.peer = new Peer(undefined, {
        host: '0.peerjs.com',
        port: 443,
        path: '/',
        secure: true,
        config: {
          iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' }
          ]
        },
        debug: 0
      });

      this.peer.on('open', (id) => {
        this.localId = id;
        console.log('[Net] Peer ID:', id);
        resolve(id);
      });

      this.peer.on('error', (err) => {
        console.error('[Net] Peer error:', err);
        const msg = this._friendlyError(err);
        if (this.onError) this.onError(msg);
        reject(err);
      });

      this.peer.on('connection', (conn) => {
        if (!this.isHost) return;
        this._handleIncomingConnection(conn);
      });

      this.peer.on('disconnected', () => {
        console.warn('[Net] Peer disconnected from server, attempting reconnect...');
        setTimeout(() => { try { this.peer.reconnect(); } catch(e) {} }, 2000);
      });
    });
  }

  // ---- HOST ----

  async host(playerInfo) {
    await this.init(playerInfo);
    this.isHost = true;
    this.roomCode = this._generateRoomCode();

    // Register room code via peer ID stored in a shared "room registry"
    // We use a lightweight approach: the room code IS a shortened version of
    // the host's peer ID stored in a free keyvalue store (jsonbin or kvdb)
    // For maximum compatibility (GitHub Pages / itch.io), we use a free
    // CORS-enabled key-value API.

    await this._registerRoom(this.roomCode, this.localId);

    // Add host to player list
    this.allPlayers = [{
      id: this.localId,
      nickname: playerInfo.nickname,
      avatar: playerInfo.avatar,
      isHost: true
    }];

    if (this.onRoomReady) this.onRoomReady(this.roomCode);
    if (this.onConnectionChange) this.onConnectionChange();

    return this.roomCode;
  }

  // ---- JOIN ----

  async join(roomCode, playerInfo) {
    await this.init(playerInfo);
    this.isHost = false;
    this.roomCode = roomCode.toUpperCase();

    // Look up host peer ID from room code
    const hostPeerId = await this._lookupRoom(this.roomCode);
    if (!hostPeerId) {
      if (this.onError) this.onError(`Room "${roomCode}" not found. Check the code and try again.`);
      return;
    }

    const conn = this.peer.connect(hostPeerId, {
      reliable: true,
      serialization: 'json'
    });

    conn.on('open', () => {
      console.log('[Net] Connected to host');
      this.connections.push(conn);
      this._setupConn(conn);
      // Send join info
      this._send(conn, {
        type: 'join',
        player: {
          id: this.localId,
          nickname: playerInfo.nickname,
          avatar: playerInfo.avatar,
          isHost: false
        }
      });
    });

    conn.on('error', (err) => {
      if (this.onError) this.onError(`Connection error: ${err.message}`);
    });
  }

  // ---- Incoming connection (host side) ----

  _handleIncomingConnection(conn) {
    if (this.allPlayers.length >= this.MAX_PLAYERS) {
      // Reject
      conn.on('open', () => {
        this._send(conn, { type: 'rejected', reason: 'Room is full.' });
        setTimeout(() => conn.close(), 500);
      });
      return;
    }

    conn.on('open', () => {
      console.log('[Net] New connection:', conn.peer);
      this.connections.push(conn);
      this._setupConn(conn);
    });

    conn.on('error', (err) => {
      console.error('[Net] Connection error:', err);
    });
  }

  _setupConn(conn) {
    conn.on('data', (data) => {
      this._handleMessage(conn, data);
    });

    conn.on('close', () => {
      const idx = this.connections.indexOf(conn);
      if (idx !== -1) this.connections.splice(idx, 1);
      const player = this.allPlayers.find(p => p.id === conn.peer);
      if (player) {
        this.allPlayers = this.allPlayers.filter(p => p.id !== conn.peer);
        if (this.onPlayerLeft) this.onPlayerLeft(conn.peer);
        if (this.onConnectionChange) this.onConnectionChange();
      }
    });
  }

  // ---- Message Handling ----

  _handleMessage(conn, data) {
    console.log('[Net] Message:', data.type);

    if (this.isHost) {
      switch (data.type) {
        case 'join':
          this._onGuestJoined(conn, data.player);
          break;
        case 'action':
          // Host receives action from guest, validates + broadcasts
          if (this.onGameAction) this.onGameAction(data.action, data.player?.id);
          break;
      }
    } else {
      switch (data.type) {
        case 'welcome':
          // Host confirms join, sends full player list
          this.allPlayers = data.players;
          if (this.onJoinSuccess) this.onJoinSuccess();
          if (this.onConnectionChange) this.onConnectionChange();
          break;
        case 'rejected':
          if (this.onError) this.onError(data.reason || 'Rejected by host.');
          conn.close();
          break;
        case 'player_joined':
          this.allPlayers.push(data.player);
          if (this.onPlayerJoined) this.onPlayerJoined(data.player);
          if (this.onConnectionChange) this.onConnectionChange();
          break;
        case 'player_left':
          this.allPlayers = this.allPlayers.filter(p => p.id !== data.playerId);
          if (this.onPlayerLeft) this.onPlayerLeft(data.playerId);
          if (this.onConnectionChange) this.onConnectionChange();
          break;
        case 'state_sync':
          // Full game state from host
          if (this.onGameAction) this.onGameAction({ type: 'state_sync', state: data.state }, 'host');
          break;
        case 'action':
          // Broadcast action from host
          if (this.onGameAction) this.onGameAction(data.action, data.playerId);
          break;
      }
    }
  }

  _onGuestJoined(conn, player) {
    this.allPlayers.push(player);
    if (this.onPlayerJoined) this.onPlayerJoined(player);
    if (this.onConnectionChange) this.onConnectionChange();

    // Tell the joiner they're welcome + full player list
    this._send(conn, { type: 'welcome', players: this.allPlayers });

    // Tell all other guests about new player
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

  // Host broadcasts state to all guests
  broadcastState(state) {
    if (!this.isHost) return;
    // Strip hand data — each player only gets their own hand
    this.connections.forEach(conn => {
      const guestId = conn.peer;
      const filteredState = this._filterStateForPlayer(state, guestId);
      this._send(conn, { type: 'state_sync', state: filteredState });
    });
  }

  // Host broadcasts an action result to all
  broadcastAction(action, sourcePlayerId) {
    this.connections.forEach(conn => {
      this._send(conn, { type: 'action', action, playerId: sourcePlayerId });
    });
  }

  // Guest sends action to host
  sendAction(action) {
    if (this.isHost) {
      // Local, handle directly
      if (this.onGameAction) this.onGameAction(action, this.localId);
      return;
    }
    const hostConn = this.connections[0];
    if (hostConn) {
      this._send(hostConn, {
        type: 'action',
        action,
        player: { id: this.localId }
      });
    }
  }

  _filterStateForPlayer(state, playerId) {
    // Clone state, but replace other players' hands with just counts
    const s = JSON.parse(JSON.stringify(state));
    s.players = s.players.map(p => {
      if (p.id === playerId) return p; // keep full hand
      // Remove hand, just keep count
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

  // ---- Room Registry (free KV store) ----
  // Uses kvdb.io — free, no auth, works from browser

  _roomKey(code) {
    return `tycoon_p5_room_${code}`;
  }

  async _registerRoom(code, peerId) {
    try {
      // Use a combination: store in localStorage + broadcast peer ID encoded in URL hash
      // For real P2P across devices we need an actual relay. Use kvdb.io (free, public)
      const url = `https://kvdb.io/9vbLMwXpQmPJZBPjLMmAWS/${this._roomKey(code)}`;
      await fetch(url, {
        method: 'PUT',
        body: peerId,
        headers: { 'Content-Type': 'text/plain' }
      });
      console.log('[Net] Room registered:', code, '->', peerId);
    } catch (e) {
      console.warn('[Net] Could not register room in KV store:', e);
      // Fallback: encode peer ID in the URL so users can share the link
      window.location.hash = `room=${code}&host=${btoa(peerId)}`;
    }
  }

  async _lookupRoom(code) {
    // Try URL hash first (for same-device testing)
    const hash = window.location.hash;
    if (hash.includes('host=')) {
      const match = hash.match(/host=([^&]+)/);
      if (match) {
        try { return atob(match[1]); } catch(e) {}
      }
    }

    // Try KV store
    try {
      const url = `https://kvdb.io/9vbLMwXpQmPJZBPjLMmAWS/${this._roomKey(code)}`;
      const res = await fetch(url);
      if (res.ok) {
        const peerId = await res.text();
        if (peerId && peerId.length > 5) return peerId;
      }
    } catch(e) {
      console.warn('[Net] KV lookup failed:', e);
    }
    return null;
  }

  // ---- Utils ----

  _generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let code = '';
    for (let i = 0; i < 6; i++) {
      code += chars[Math.floor(Math.random() * chars.length)];
    }
    return code;
  }

  _friendlyError(err) {
    if (err.type === 'peer-unavailable') return 'Could not connect to host. Room may be full or closed.';
    if (err.type === 'network') return 'Network error. Check your connection.';
    if (err.type === 'server-error') return 'Signaling server error. Try again.';
    if (err.type === 'socket-error') return 'Socket error. Try again.';
    return `Connection error: ${err.message || err.type}`;
  }

  getPlayerCount() { return this.allPlayers.length; }
  getPlayers() { return this.allPlayers; }
  getLocalId() { return this.localId; }
}

window.TycoonNetwork = TycoonNetwork;

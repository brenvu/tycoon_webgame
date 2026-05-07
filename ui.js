// ============================================================
// TYCOON — UI Renderer
// ============================================================

const UI = {
  // ---- Card Rendering ----

  createCardEl(card, options = {}) {
    const { faceDown = false, selected = false, playable = true, small = false, pile = false } = options;
    const el = document.createElement('div');
    el.className = 'card-el';
    if (faceDown) el.classList.add('face-down');
    if (selected) el.classList.add('selected');
    if (!playable) el.classList.add('unplayable');
    if (small) el.classList.add('card-small');
    if (pile) el.classList.add('card-pile-el');

    if (!faceDown && card) {
      el.style.cssText = Cards.getCardSpriteStyle(card);
      el.dataset.cardId = card.id;

      // Tooltip
      el.title = Cards.cardDisplayName(card);

      // Special badge
      if (Cards.is8Stop(card)) {
        const badge = document.createElement('div');
        badge.className = 'card-badge stop-badge';
        badge.textContent = 'STOP';
        el.appendChild(badge);
      } else if (card.joker) {
        const badge = document.createElement('div');
        badge.className = 'card-badge joker-badge';
        badge.textContent = 'WILD';
        el.appendChild(badge);
      } else if (card.suit === 'spades' && card.rank === '3') {
        const badge = document.createElement('div');
        badge.className = 'card-badge spade-badge';
        badge.textContent = '3♠';
        el.appendChild(badge);
      }
    }

    return el;
  },

  // ---- Hand Rendering ----

  renderHand(hand, selectedIds, playableIds, onToggle, revolutionActive) {
    const container = document.getElementById('hand-cards');
    if (!container) return;
    container.innerHTML = '';

    const sortedHand = Cards.sortHand(hand, revolutionActive);

    sortedHand.forEach(card => {
      const isSelected = selectedIds.has(card.id);
      const isPlayable = playableIds ? playableIds.has(card.id) : true;

      const cardEl = this.createCardEl(card, { selected: isSelected, playable: isPlayable });

      // Stable JS hover — 150ms leave delay bridges the gap when card lifts into cursor
      let leaveTimer = null;
      cardEl.addEventListener('mouseenter', () => {
        if (leaveTimer) { clearTimeout(leaveTimer); leaveTimer = null; }
        cardEl.classList.add('card-hovered');
      });
      cardEl.addEventListener('mouseleave', (e) => {
        // Only remove hover if the mouse moved to something outside this card
        leaveTimer = setTimeout(() => {
          cardEl.classList.remove('card-hovered');
          leaveTimer = null;
        }, 150);
      });

      if (isPlayable) {
        cardEl.style.cursor = 'pointer';
        cardEl.addEventListener('click', () => onToggle(card));
        cardEl.addEventListener('touchend', (e) => { e.preventDefault(); onToggle(card); });
      }

      container.appendChild(cardEl);
    });

    const countEl = document.getElementById('local-cards-count');
    if (countEl) countEl.textContent = hand.length;
  },

  // ---- Pile Rendering ----

  renderPile(pile, currentPlay) {
    const pileEl = document.getElementById('card-pile');
    const emptyMsg = document.getElementById('pile-empty');
    const pileInfo = document.getElementById('pile-info');

    pileEl.innerHTML = '';
    if (emptyMsg) pileEl.appendChild(emptyMsg);

    if (!pile || pile.length === 0) {
      emptyMsg.style.display = 'block';
      if (pileInfo) pileInfo.textContent = '';
      return;
    }

    emptyMsg.style.display = 'none';

    const showCards = currentPlay ? currentPlay.cards : pile.slice(-1);
    const count = showCards.length;

    // Depth illusion: show up to 3 face-down cards behind the current play
    const priorCardsInPile = pile.length - showCards.length;
    if (priorCardsInPile > 0) {
      const depthCount = Math.min(3, Math.ceil(priorCardsInPile / 2));
      for (let d = depthCount - 1; d >= 0; d--) {
        const depthEl = this.createCardEl(null, { faceDown: true, pile: true });
        depthEl.style.position = 'absolute';
        depthEl.style.left = '50%';
        depthEl.style.top = '50%';
        const offsetX = (d + 1) * 9;
        const offsetY = (d + 1) * -7;
        const rot = (d % 2 === 0 ? 1 : -1) * (d + 1) * 5;
        depthEl.style.transform = `translate(calc(-50% + ${offsetX}px), calc(-50% + ${offsetY}px)) rotate(${rot}deg)`;
        depthEl.style.zIndex = d;
        depthEl.style.opacity = String(0.75 - d * 0.12);
        depthEl.style.borderColor = 'rgba(255,255,255,0.25)';
        pileEl.appendChild(depthEl);
      }
    }

    // Render current play cards fanned on top
    showCards.forEach((card, i) => {
      const el = this.createCardEl(card, { pile: true });
      el.classList.add('pile-top');

      if (count === 1) {
        el.style.position = 'absolute';
        el.style.left = '50%';
        el.style.top = '50%';
        el.style.transform = 'translate(-50%, -50%) rotate(-1deg) scale(1.05)';
        el.style.zIndex = 5;
      } else {
        // Fan: spread cards horizontally with rotation
        const spreadPx = count === 2 ? 36 : count === 3 ? 28 : 22;
        const totalSpread = spreadPx * (count - 1);
        const startX = -totalSpread / 2;
        const rotStep = count <= 2 ? 7 : 5;
        const startRot = -((count - 1) * rotStep) / 2;

        el.style.position = 'absolute';
        el.style.left = '50%';
        el.style.top = '50%';
        el.style.marginLeft = `${startX + i * spreadPx}px`;
        el.style.transform = `translate(-50%, -50%) rotate(${startRot + i * rotStep}deg) scale(1.05)`;
        el.style.zIndex = 5 + i;
      }

      pileEl.appendChild(el);
    });

    if (currentPlay) {
      const countLabel = count > 1 ? `${count}× ` : '';
      const rankName = currentPlay.cards[0]?.joker ? 'JOKER' : (currentPlay.cards[0]?.rank || '');
      if (pileInfo) {
        pileInfo.innerHTML = `<span class="pile-player">${currentPlay.playerName}</span> played <span class="pile-cards">${countLabel}${rankName}</span>`;
      }
    }
  },

  // ---- Opponents Rendering ----

  renderOpponents(players, localPlayerIndex, currentTurn, revolutionActive) {
    const area = document.getElementById('opponents-area');
    if (!area) return;
    area.innerHTML = '';

    const opponents = players
      .map((p, i) => ({ ...p, index: i }))
      .filter(p => p.index !== localPlayerIndex);

    opponents.forEach(player => {
      const isActive = player.index === currentTurn;
      const el = document.createElement('div');
      el.className = `opponent-panel ${isActive ? 'active-turn' : ''}`;

      const avatarEl = this._makeAvatarEl(player.avatar, player.nickname, 'opponent-avatar');

      const info = document.createElement('div');
      info.className = 'opponent-info';

      const nameEl = document.createElement('div');
      nameEl.className = 'opponent-name';
      nameEl.textContent = player.nickname || 'Player';

      const rankEl = document.createElement('div');
      rankEl.className = 'opponent-rank';
      rankEl.textContent = player.rank ? player.rank.toUpperCase() : 'COMMONER';
      rankEl.style.color = Cards.rankColor(player.rank || 'commoner');

      const cardsEl = document.createElement('div');
      cardsEl.className = 'opponent-cards-count';
      cardsEl.innerHTML = `Cards Left <span class="count-num">${player.handCount !== undefined ? player.handCount : '?'}</span>`;

      info.appendChild(nameEl);
      info.appendChild(rankEl);
      info.appendChild(cardsEl);

      // Mini face-down cards — tighter red-themed stack
      const miniCards = document.createElement('div');
      miniCards.className = 'opponent-mini-cards';
      const cardCount = player.handCount || 0;
      // Show up to 13 "pips", each representing 1+ cards
      const visCount = Math.min(cardCount, 13);
      for (let i = 0; i < visCount; i++) {
        const c = this.createCardEl(null, { faceDown: true, small: true });
        c.style.marginLeft = i > 0 ? '-14px' : '0';
        c.style.zIndex = String(i);
        miniCards.appendChild(c);
      }

      if (player.finished) {
        el.classList.add('player-finished');
        const doneEl = document.createElement('div');
        doneEl.className = 'finished-badge';
        doneEl.textContent = `#${player.finishPosition || '?'}`;
        el.appendChild(doneEl);
      }

      if (isActive) {
        const turnEl = document.createElement('div');
        turnEl.className = 'active-turn-indicator';
        turnEl.textContent = '▶ THEIR TURN';
        el.appendChild(turnEl);
      }

      // Pass label
      if (player.passedThisTrick && !player.finished) {
        const passLabel = document.createElement('div');
        passLabel.className = 'pass-label';
        passLabel.textContent = 'PASSED';
        el.appendChild(passLabel);
      }

      el.appendChild(avatarEl);
      el.appendChild(info);
      el.appendChild(miniCards);
      area.appendChild(el);
    });
  },

  // ---- Scoreboard ----

  renderScoresMini(players) {
    const el = document.getElementById('scores-mini');
    if (!el) return;
    el.innerHTML = '';
    [...players]
      .sort((a, b) => b.score - a.score)
      .forEach(p => {
        const row = document.createElement('div');
        row.className = 'score-row';
        row.innerHTML = `<span class="score-name">${p.nickname}</span><span class="score-pts">${p.score}pt</span>`;
        el.appendChild(row);
      });
  },

  // ---- Local Player ----

  renderLocalPlayer(player, revolutionActive) {
    if (!player) return;
    const nicknameEl = document.getElementById('local-nickname');
    const rankEl = document.getElementById('local-rank-badge');
    const avatarImg = document.getElementById('local-avatar-img');
    const avatarPh = document.getElementById('local-avatar-ph');

    if (nicknameEl) nicknameEl.textContent = player.nickname;
    if (rankEl) {
      rankEl.textContent = (player.rank || 'commoner').toUpperCase();
      rankEl.style.borderColor = Cards.rankColor(player.rank || 'commoner');
      rankEl.style.color = Cards.rankColor(player.rank || 'commoner');
    }

    if (player.avatar && avatarImg) {
      avatarImg.src = `avatars/${player.avatar}`;
      avatarImg.style.display = 'block';
      if (avatarPh) avatarPh.style.display = 'none';
    } else if (avatarPh) {
      avatarPh.style.display = 'flex';
      if (avatarImg) avatarImg.style.display = 'none';
    }
  },

  // ---- Timer ----

  renderTimer(seconds) {
    const bar = document.getElementById('timer-bar');
    const text = document.getElementById('timer-text');
    const centerNum = document.getElementById('timer-center-num');
    if (!bar) return;
    const pct = (seconds / 90) * 100;
    bar.style.width = `${pct}%`;
    if (text) text.textContent = seconds;

    bar.className = 'timer-bar';
    if (centerNum) {
      centerNum.textContent = seconds > 0 ? seconds : '—';
      centerNum.className = 'timer-center-num';
      if (seconds <= 10 && seconds > 0) centerNum.classList.add('timer-crit');
      else if (seconds <= 30) centerNum.classList.add('timer-warn');
    }
    if (seconds <= 10) bar.classList.add('timer-critical');
    else if (seconds <= 30) bar.classList.add('timer-warning');
  },

  // ---- Revolution Banner ----

  renderRevolution(active) {
    const banner = document.getElementById('revolution-banner');
    if (!banner) return;
    if (active) {
      banner.classList.remove('hidden');
      banner.classList.add('rev-active');
    } else {
      banner.classList.add('hidden');
      banner.classList.remove('rev-active');
    }
  },

  // ---- Action Log ----

  addLogEntry(msg) {
    const feed = document.getElementById('event-feed');
    if (!feed) return;

    // Classify message for styling
    let type = 'feed-play';
    let icon = '▶';

    if (/passed/i.test(msg))                        { type = 'feed-pass';       icon = '⏭'; }
    else if (/REVOLUTION/i.test(msg))               { type = 'feed-revolution'; icon = '⚡'; }
    else if (/COUNTER.REVOLUTION/i.test(msg))       { type = 'feed-revolution'; icon = '🔄'; }
    else if (/8 STOP/i.test(msg))                   { type = 'feed-special';    icon = '🛑'; }
    else if (/3.*SPADE|SPADE REVERSAL/i.test(msg))  { type = 'feed-special';    icon = '♠'; }
    else if (/finished|🏆/i.test(msg))              { type = 'feed-finish';     icon = '🏆'; }
    else if (/BANKRUPTCY|bankrupted/i.test(msg))    { type = 'feed-finish';     icon = '💀'; }
    else if (/All others passed|chain ends/i.test(msg)) { type = 'feed-special'; icon = '🔁'; }
    else if (/Round.*started|GAME OVER|→/i.test(msg)) { type = 'feed-system';  icon = '📋'; }
    else if (/exchange|gave|chose/i.test(msg))      { type = 'feed-system';    icon = '🔃'; }
    else if (/played:/i.test(msg))                  { type = 'feed-play';       icon = '▶'; }

    const entry = document.createElement('div');
    entry.className = 'feed-entry ' + type;

    // Format: bold the player name (text before first space-colon or first word if special)
    let html = msg;
    // Bold player name before 'played:' or 'passed.'
    html = html.replace(/^(.+?)\s+(played:|passed\.)/, (_, name, rest) =>
      `<strong>${name}</strong> ${rest}`);

    entry.innerHTML = `<span class="feed-icon">${icon}</span><span class="feed-text">${html}</span>`;
    feed.insertBefore(entry, feed.firstChild);

    // Cap at 4 visible entries — remove oldest
    while (feed.children.length > 4) feed.removeChild(feed.lastChild);
  },

  // ---- Waiting Room ----

  renderWaitingRoom(players, isHost, localId) {
    const list = document.getElementById('waiting-players-list');
    const status = document.getElementById('waiting-status');
    const startBtn = document.getElementById('btn-start-game');
    if (!list) return;

    list.innerHTML = '';
    players.forEach(p => {
      const row = document.createElement('div');
      row.className = `waiting-player-row ${p.id === localId ? 'local-player-row' : ''}`;

      const av = this._makeAvatarEl(p.avatar, p.nickname, 'waiting-avatar-sm');
      const nameEl = document.createElement('span');
      nameEl.className = 'waiting-player-name';
      nameEl.textContent = p.nickname + (p.id === localId ? ' (You)' : '') + (p.isHost ? ' 👑' : '');

      row.appendChild(av);
      row.appendChild(nameEl);
      list.appendChild(row);
    });

    const count = players.length;
    if (status) {
      if (count < 2) status.textContent = `Waiting for players... (need at least 2)`;
      else if (count < 4) status.textContent = `${count}/4 players connected. Ready to start, or wait for more.`;
      else status.textContent = `Room full! (4/4 players)`;
    }

    if (startBtn) {
      if (isHost && count >= 2) {
        startBtn.style.display = 'block';
      } else {
        startBtn.style.display = 'none';
      }
    }
  },

  // ---- Round End ----

  renderRoundEnd(players, round, finishOrder) {
    const panel = document.getElementById('round-end-rankings');
    const title = document.getElementById('round-end-title');
    const nextBtn = document.getElementById('btn-next-round');
    if (!panel) return;

    title.textContent = `ROUND ${round} COMPLETE`;

    const sorted = [...players].sort((a, b) => (a.finishPosition || 99) - (b.finishPosition || 99));

    panel.innerHTML = '';
    sorted.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = 'ranking-row';
      const pos = p.finishPosition || (i + 1);
      const rankName = p.rank || 'poor';
      const pts = { tycoon: 30, rich: 20, poor: 10, commoner: 10, beggar: 0 }[rankName] || 0;

      row.innerHTML = `
        <div class="rank-pos">#${pos}</div>
        <div class="rank-avatar-wrap">${p.avatar ? `<img src="avatars/${p.avatar}" class="rank-avatar">` : '<div class="rank-avatar-ph">?</div>'}</div>
        <div class="rank-name">${p.nickname}</div>
        <div class="rank-badge-re" style="color:${Cards.rankColor(rankName)}">${rankName.toUpperCase()}</div>
        <div class="rank-pts">+${pts} pts (Total: ${p.score})</div>
      `;
      panel.appendChild(row);
    });

    if (nextBtn) nextBtn.style.display = 'block';
  },

  // ---- Game Over ----

  renderGameOver(players) {
    const panel = document.getElementById('final-rankings');
    if (!panel) return;

    const sorted = [...players].sort((a, b) => b.score - a.score);
    panel.innerHTML = '';

    sorted.forEach((p, i) => {
      const row = document.createElement('div');
      row.className = `final-rank-row ${i === 0 ? 'winner-row' : ''}`;
      const medals = ['🥇', '🥈', '🥉', '4️⃣'];
      row.innerHTML = `
        <div class="final-medal">${medals[i] || ''}</div>
        <div class="final-avatar">${p.avatar ? `<img src="avatars/${p.avatar}" class="final-avatar-img">` : '<div class="final-avatar-ph">?</div>'}</div>
        <div class="final-info">
          <div class="final-name">${p.nickname}</div>
          <div class="final-rank" style="color:${Cards.rankColor(p.rank)}">${(p.rank || 'commoner').toUpperCase()}</div>
        </div>
        <div class="final-score">${p.score} pts</div>
      `;
      panel.appendChild(row);
    });
  },

  // ---- Exchange Screen ----

  renderExchange(exchangeInfo, playerHand, selectedIds, onToggle, onConfirm, revolutionActive) {
    const title = document.getElementById('exchange-title');
    const desc = document.getElementById('exchange-desc');
    const handEl = document.getElementById('exchange-hand');
    const selInfo = document.getElementById('exchange-selected-info');
    const confirmBtn = document.getElementById('btn-confirm-exchange');
    if (!handEl) return;

    const required = exchangeInfo.count;
    const mustGiveBest = !exchangeInfo.giversChoice;

    if (title) title.textContent = 'CARD EXCHANGE';
    if (desc) {
      if (mustGiveBest) {
        desc.textContent = `You must give your ${required} highest-value card${required > 1 ? 's' : ''} away (pre-selected).`;
      } else {
        desc.textContent = `Choose ${required} card${required > 1 ? 's' : ''} to give away.`;
      }
    }

    handEl.innerHTML = '';
    // Revolution is always reset before exchange, so always sort with false
    const sortedHand = Cards.sortHand(playerHand, false);

    // For mustGiveBest: top N are required (pre-selected, locked in)
    let autoSelected = null;
    if (mustGiveBest) {
      const topN = sortedHand.slice(-required);
      autoSelected = new Set(topN.map(c => c.id));
    }

    sortedHand.forEach(card => {
      let isSelected, isPlayable;

      if (mustGiveBest) {
        // Required cards are pre-selected and visually raised; others are shown normally (dimmed slightly)
        isSelected = autoSelected.has(card.id);
        isPlayable = true; // Show all cards — don't hide non-selected ones
      } else {
        // Tycoon/Rich: all cards are clickable/available
        isSelected = selectedIds.has(card.id);
        isPlayable = true;
      }

      const el = this.createCardEl(card, { selected: isSelected, playable: isPlayable });

      if (mustGiveBest && !isSelected) {
        // Dim non-selected cards slightly to indicate they're locked
        el.style.opacity = '0.55';
        el.style.cursor = 'not-allowed';
      } else if (mustGiveBest && isSelected) {
        el.style.cursor = 'default';
      }

      if (!mustGiveBest) {
        // Tycoon/Rich can click any card
        el.style.cursor = 'pointer';
        el.addEventListener('click', () => onToggle(card));
      }

      handEl.appendChild(el);
    });

    const numSelected = mustGiveBest ? required : selectedIds.size;
    if (selInfo) selInfo.textContent = `${numSelected}/${required} selected`;
    if (confirmBtn) {
      confirmBtn.disabled = numSelected !== required;
      confirmBtn.onclick = () => {
        if (mustGiveBest) {
          // Revolution is always false during exchange; sort ascending and take top N
          const topN = Cards.sortHand(playerHand, false).slice(-required);
          onConfirm(topN);
        } else {
          onConfirm([...selectedIds].map(id => playerHand.find(c => c.id === id)).filter(Boolean));
        }
      };
    }
  },

  // ---- Avatar Setup ----

  populateAvatarSelect(avatarFiles) {
    const sel = document.getElementById('select-avatar');
    if (!sel) return;
    // Clear existing options except placeholder
    while (sel.options.length > 1) sel.remove(1);

    avatarFiles.forEach(filename => {
      const opt = document.createElement('option');
      opt.value = filename;
      // Display name = filename without extension
      opt.textContent = filename.replace(/\.(png|jpg|jpeg|gif|webp)$/i, '');
      sel.appendChild(opt);
    });

    sel.addEventListener('change', () => {
      const preview = document.getElementById('avatar-preview-img');
      const none = document.getElementById('avatar-preview-none');
      if (sel.value) {
        preview.src = `avatars/${sel.value}`;
        preview.style.display = 'block';
        if (none) none.style.display = 'none';
      } else {
        preview.style.display = 'none';
        if (none) none.style.display = 'flex';
      }
    });

    // Trigger if already selected
    if (sel.value) sel.dispatchEvent(new Event('change'));
  },

  // ---- Toast Notifications ----

  showToast(msg, duration = 3000) {
    const toast = document.getElementById('toast');
    if (!toast) return;
    toast.textContent = msg;
    toast.classList.remove('hidden');
    toast.classList.add('toast-show');
    setTimeout(() => {
      toast.classList.remove('toast-show');
      setTimeout(() => toast.classList.add('hidden'), 400);
    }, duration);
  },

  // ---- Screen Management ----

  showScreen(name) {
    document.querySelectorAll('.screen').forEach(s => {
      s.classList.remove('active');
      s.classList.add('hidden');
    });
    const target = document.getElementById(`screen-${name}`);
    if (target) {
      target.classList.remove('hidden');
      target.classList.add('active');
    }
  },

  // ---- Helpers ----

  _makeAvatarEl(avatarFile, nickname, className) {
    const wrap = document.createElement('div');
    wrap.className = className || 'avatar-wrap';
    if (avatarFile) {
      const img = document.createElement('img');
      img.src = `avatars/${avatarFile}`;
      img.alt = nickname || '';
      img.onerror = () => {
        img.style.display = 'none';
        const ph = document.createElement('div');
        ph.className = 'avatar-placeholder';
        ph.textContent = (nickname || '?')[0].toUpperCase();
        wrap.appendChild(ph);
      };
      wrap.appendChild(img);
    } else {
      const ph = document.createElement('div');
      ph.className = 'avatar-placeholder';
      ph.textContent = (nickname || '?')[0].toUpperCase();
      wrap.appendChild(ph);
    }
    return wrap;
  }
};

window.UI = UI;

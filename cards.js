// ============================================================
// TYCOON CARD GAME — Card Definitions & Rules Engine
// ============================================================

const SUITS = ['clubs', 'diamonds', 'hearts', 'spades'];
const RANKS = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];

// Normal rank order: 3 is lowest, then 4-10, J, Q, K, A, 2, Joker, 3♠ (special)
// Value index in normal mode (higher = stronger)
const RANK_ORDER_NORMAL = ['3','4','5','6','7','8','9','10','J','Q','K','A','2'];
// Index 0 = 3 (weakest normal), index 12 = 2 (strongest normal non-special)

// Special strengths (always on top):
// 13 = Joker, 14 = 3♠ (only beats single Joker)

const CARD_SPRITESHEET = 'tex/card_sheet.png';
// Sheet layout: 2048x1240, 12 cols x 5 rows
// Row 0: clubs    A 2 3 4 5 6 7 8 9 10 J Q
// Row 1: diamonds A 2 3 4 5 6 7 8 9 10 J Q
// Row 2: hearts   A 2 3 4 5 6 7 8 9 10 J Q
// Row 3: spades   A 2 3 4 5 6 7 8 9 10 J Q
// Row 4: joker_red(0), joker_black(1), card_back(2), K_clubs(3), K_diamonds(4), K_hearts(5), K_spades(6)

const CARD_W = 169;
const CARD_H = 244;
const SHEET_W = 2048;
const SHEET_H = 1240;

function getCardSpriteStyle(card, faceDown = false) {
  if (faceDown) {
    // card back = row4, col2
    const sx = 2 * CARD_W;
    const sy = 4 * CARD_H;
    return spriteStyle(sx, sy);
  }
  if (card.joker) {
    // red joker = col0, black joker = col1
    const sx = (card.jokerType === 'red' ? 0 : 1) * CARD_W;
    const sy = 4 * CARD_H;
    return spriteStyle(sx, sy);
  }
  const rank = card.rank;
  const suit = card.suit;

  if (rank === 'K') {
    const suitIdx = SUITS.indexOf(suit);
    const sx = (3 + suitIdx) * CARD_W;
    const sy = 4 * CARD_H;
    return spriteStyle(sx, sy);
  }

  // Row by suit
  const rowIdx = SUITS.indexOf(suit);
  // Col by rank order in sheet (A=0, 2=1, 3=2, ... Q=11)
  const SHEET_RANK_ORDER = ['A','2','3','4','5','6','7','8','9','10','J','Q'];
  const colIdx = SHEET_RANK_ORDER.indexOf(rank);
  if (colIdx === -1) return '';
  const sx = colIdx * CARD_W;
  const sy = rowIdx * CARD_H;
  return spriteStyle(sx, sy);
}

function spriteStyle(sx, sy) {
  // Scale card to display size
  const displayW = 100;
  const displayH = 145;
  const scaleX = displayW / CARD_W;
  const scaleY = displayH / CARD_H;
  const bgW = SHEET_W * scaleX;
  const bgH = SHEET_H * scaleY;
  const bgX = -(sx * scaleX);
  const bgY = -(sy * scaleY);
  return `background-image:url('${CARD_SPRITESHEET}');background-size:${bgW}px ${bgH}px;background-position:${bgX}px ${bgY}px;background-repeat:no-repeat;`;
}

// ---- Card Object Factory ----
function makeCard(suit, rank, joker = false, jokerType = 'red') {
  return { suit, rank, joker, jokerType, id: joker ? `joker-${jokerType}` : `${rank}-${suit}` };
}

function createDeck() {
  const deck = [];
  for (const suit of SUITS) {
    for (const rank of RANKS) {
      deck.push(makeCard(suit, rank));
    }
  }
  // Add 2 jokers
  deck.push(makeCard(null, null, true, 'red'));
  deck.push(makeCard(null, null, true, 'black'));
  return deck; // 54 cards
}

function shuffleDeck(deck) {
  const d = [...deck];
  for (let i = d.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [d[i], d[j]] = [d[j], d[i]];
  }
  return d;
}

function dealCards(deck, numPlayers) {
  // Shuffle first
  const shuffled = shuffleDeck(deck);
  const hands = Array.from({ length: numPlayers }, () => []);
  shuffled.forEach((card, i) => {
    hands[i % numPlayers].push(card);
  });
  return hands;
}

// ---- Card Value Logic ----

// Returns numeric strength of a card (higher = stronger)
// revolutionActive flips the normal order (Joker stays highest)
// NOTE: 3♠ is treated as a NORMAL card for strength purposes.
// Its special ability (beating a single Joker) is handled only in validatePlay.
function cardStrength(card, revolutionActive = false) {
  if (card.joker) return 1000; // Always highest

  const idx = RANK_ORDER_NORMAL.indexOf(card.rank);
  if (idx === -1) return 0;

  if (revolutionActive) {
    // Flip: rank 0 (3) becomes strongest normal, rank 12 (2) becomes weakest
    return 12 - idx;
  }
  return idx;
}

// Sort a hand by strength (ascending)
function sortHand(hand, revolutionActive = false) {
  return [...hand].sort((a, b) => {
    const sa = cardStrength(a, revolutionActive);
    const sb = cardStrength(b, revolutionActive);
    if (sa !== sb) return sa - sb;
    // Secondary sort: by suit
    return SUITS.indexOf(a.suit) - SUITS.indexOf(b.suit);
  });
}

// Check if a card is an "8 Stop"
function is8Stop(card) {
  return !card.joker && card.rank === '8';
}

// Check if cards contain a Joker
function hasJoker(cards) {
  return cards.some(c => c.joker);
}

// ---- Play Validation ----
// pile: array of cards currently in center pile (last play is at end)
// currentPlay: { cards: [], count: number } — the last played set
// selectedCards: array of cards the player wants to play
// revolutionActive: boolean

function validatePlay(selectedCards, currentPlay, revolutionActive) {
  if (!selectedCards || selectedCards.length === 0) {
    return { valid: false, reason: 'Select at least one card.' };
  }

  const count = selectedCards.length;

  // All-8 stop: ends turn regardless
  const allEights = selectedCards.every(c => is8Stop(c));
  if (allEights) {
    return { valid: true, isStop: true };
  }

  // If pile is empty
  if (!currentPlay) {
    if (count < 1 || count > 4) return { valid: false, reason: 'Play 1-4 cards.' };
    if (!isValidSet(selectedCards)) {
      return { valid: false, reason: 'Cards must be the same rank (Joker counts as any rank).' };
    }
    const rev = isRevolution(selectedCards);
    // Counter-revolution on new trick: 4-of-a-kind played when revolution is active
    const counterRev = rev && revolutionActive;
    return { valid: true, isRevolution: rev, isCounterRevolution: counterRev };
  }

  // Must match count of current play
  if (count !== currentPlay.count) {
    return { valid: false, reason: `Must play exactly ${currentPlay.count} card(s).` };
  }

  if (!isValidSet(selectedCards)) {
    return { valid: false, reason: 'Cards must be the same rank (Joker counts as any rank).' };
  }

  // 3♠ special: only valid as single card against single Joker
  const has3Spades = selectedCards.some(c => !c.joker && c.suit === 'spades' && c.rank === '3');
  if (has3Spades) {
    if (count === 1 && currentPlay.count === 1 && currentPlay.topStrength === 1000) {
      return { valid: true, is3Spades: true };
    }
    // Falls through to strength check as normal 3
  }

  const playStrength = getPlayStrength(selectedCards, revolutionActive);
  const required = currentPlay.topStrength;

  if (playStrength <= required) {
    return { valid: false, reason: 'Your cards must be stronger than the current pile.' };
  }

  // Check if this is a revolution or counter-revolution
  const isRev = isRevolution(selectedCards);
  // Counter-revolution: a 4-of-a-kind played WHILE a revolution is already active
  // It beats the current play AND toggles the revolution back off
  const isCounterRev = isRev && revolutionActive;

  return {
    valid: true,
    isRevolution: isRev,
    isCounterRevolution: isCounterRev,
    playStrength
  };
}

// A valid set: all same rank OR with joker wildcards
function isValidSet(cards) {
  if (cards.length === 1) return true;
  const nonJokers = cards.filter(c => !c.joker);
  if (nonJokers.length === 0) return true; // all jokers
  const rank = nonJokers[0].rank;
  return nonJokers.every(c => c.rank === rank);
}

// Effective rank of a set (highest non-joker rank, or joker)
function getPlayStrength(cards, revolutionActive) {
  if (cards.every(c => c.joker)) return 1000;
  const nonJokers = cards.filter(c => !c.joker);
  return cardStrength(nonJokers[0], revolutionActive);
}

function isRevolution(cards) {
  if (cards.length !== 4) return false;
  return isValidSet(cards);
}

// ---- Hand Playability ----
// Returns which cards in hand can be part of a valid play given current state
function getPlayableCards(hand, currentPlay, revolutionActive) {
  const playable = new Set();

  if (!currentPlay) {
    // Any card can start a new pile
    hand.forEach(c => playable.add(c.id));
    return playable;
  }

  const required = currentPlay.topStrength;
  const requiredCount = currentPlay.count;

  // Check 8 stops
  hand.forEach(c => {
    if (is8Stop(c)) playable.add(c.id);
  });

  // Check if 3♠ can be played (ONLY against a single Joker)
  if (requiredCount === 1 && required === 1000) {
    const threeSpades = hand.find(c => !c.joker && c.suit === 'spades' && c.rank === '3');
    if (threeSpades) playable.add(threeSpades.id);
  }

  // Group cards by rank (jokers group with any rank)
  // NOTE: 3♠ is treated as a normal 3 here — its strength is 0 (weakest)
  const byRank = {};
  hand.forEach(c => {
    if (c.joker) return; // handle separately
    if (!byRank[c.rank]) byRank[c.rank] = [];
    byRank[c.rank].push(c);
  });
  const jokers = hand.filter(c => c.joker);

  // For each rank group, check if with jokers we can form a valid play of required count
  for (const rank in byRank) {
    const group = byRank[rank];
    const totalAvail = group.length + jokers.length;
    if (totalAvail < requiredCount) continue;

    const str = cardStrength(group[0], revolutionActive);
    if (str <= required) continue; // not strong enough

    // Mark all cards in this potential group as playable
    group.forEach(c => playable.add(c.id));
    jokers.forEach(c => playable.add(c.id));
  }

  // If all jokers and strong enough
  if (jokers.length >= requiredCount && 1000 > required) {
    jokers.forEach(c => playable.add(c.id));
  }

  return playable;
}

// Get display name for a card
function cardDisplayName(card) {
  if (card.joker) return `JOKER`;
  return `${card.rank} of ${card.suit.charAt(0).toUpperCase() + card.suit.slice(1)}`;
}

// Get rank display label
function rankLabel(rank) {
  const labels = {
    'tycoon':   '👑 TYCOON',
    'rich':     '🎩 RICH',
    'poor':     '⚔️ POOR',
    'commoner': '🔵 COMMONER',
    'beggar':   '🩶 BEGGAR',
    'bankrupt': '💀 BANKRUPT'
  };
  return labels[rank] || rank.toUpperCase();
}

function rankColor(rank) {
  const colors = {
    'tycoon':   '#ffd700',  // gold
    'rich':     '#4ade80',  // bright green
    'poor':     '#c084fc',  // light purple
    'commoner': '#67e8f9',  // cyan blue
    'beggar':   '#9ca3af',  // gray
    'bankrupt': '#ef4444'   // red (warning)
  };
  return colors[rank] || '#fff';
}

// Find who has 3 of Diamonds in a set of hands
function findStartingPlayer(hands) {
  for (let i = 0; i < hands.length; i++) {
    if (hands[i].some(c => !c.joker && c.rank === '3' && c.suit === 'diamonds')) {
      return i;
    }
  }
  return 0;
}

window.Cards = {
  createDeck, shuffleDeck, dealCards, sortHand,
  cardStrength, validatePlay, getPlayableCards,
  getCardSpriteStyle, cardDisplayName, rankLabel, rankColor,
  findStartingPlayer, isValidSet, getPlayStrength, isRevolution,
  is8Stop, hasJoker, RANK_ORDER_NORMAL, SUITS, RANKS, CARD_W, CARD_H
};

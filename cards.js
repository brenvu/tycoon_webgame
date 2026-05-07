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
function cardStrength(card, revolutionActive = false) {
  if (card.joker) return 1000; // Always highest
  if (card.suit === 'spades' && card.rank === '3') return 999; // Special: only beats single joker

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

  // All-8 stop: can play any number of 8s as stop
  const allEights = selectedCards.every(c => is8Stop(c));
  if (allEights) {
    // Must have a value lower than the top card (8 clears the pile)
    // Actually 8 Stop: ends turn regardless, no value check needed vs pile
    // But you still can't play them if they are higher than required count
    // Rule: 8 Stop ends the turn, player goes next. No value comparison needed.
    return { valid: true, isStop: true };
  }

  // If pile is empty, anything goes (matching count doesn't matter)
  if (!currentPlay) {
    // Any valid set: singles, pairs, triples, quads
    if (count < 1 || count > 4) return { valid: false, reason: 'Play 1-4 cards.' };
    // Must all be same rank (or joker wildcard)
    if (!isValidSet(selectedCards)) {
      return { valid: false, reason: 'Cards must be the same rank (Joker counts as any rank).' };
    }
    return { valid: true, isRevolution: isRevolution(selectedCards) };
  }

  // Must match the count of the current play
  if (count !== currentPlay.count) {
    return { valid: false, reason: `Must play exactly ${currentPlay.count} card(s).` };
  }

  // Must be a valid set
  if (!isValidSet(selectedCards)) {
    return { valid: false, reason: 'Cards must be the same rank (Joker counts as any rank).' };
  }

  // 3 of Spades special: only allowed if current play is a single Joker
  const has3Spades = selectedCards.some(c => !c.joker && c.suit === 'spades' && c.rank === '3');
  if (has3Spades) {
    if (count === 1 && currentPlay.count === 1 && currentPlay.topStrength === 1000) {
      return { valid: true, is3Spades: true };
    }
    return { valid: false, reason: '3♠ can only be played against a single Joker.' };
  }

  // Get play strength
  const playStrength = getPlayStrength(selectedCards, revolutionActive);
  const required = currentPlay.topStrength;

  if (playStrength <= required) {
    return { valid: false, reason: 'Your cards must be stronger than the current pile.' };
  }

  return {
    valid: true,
    isRevolution: isRevolution(selectedCards),
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

  // Check if 3♠ can be played
  if (requiredCount === 1 && required === 1000) {
    const threeSpades = hand.find(c => !c.joker && c.suit === 'spades' && c.rank === '3');
    if (threeSpades) playable.add(threeSpades.id);
  }

  // Group cards by rank (jokers group with any rank)
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
    'commoner': '⚔️ COMMONER',
    'beggar':   '💀 BEGGAR'
  };
  return labels[rank] || rank.toUpperCase();
}

function rankColor(rank) {
  const colors = {
    'tycoon':   '#ffd700',
    'rich':     '#c0c0c0',
    'commoner': '#ffffff',
    'beggar':   '#cc3333'
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

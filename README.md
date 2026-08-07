# Tycoon (Persona 5 Royal Card Game)

https://brenvu.github.io/tycoon_webgame/

A browser-based, multiplayer version of the Tycoon card game from Persona 5 Royal. Two to four players connect directly to each other over a peer-to-peer link using a 6-character room code, no server or account needed.

This project was built with Claude, describing the game's rules, UI, and networking requirements and iterating turn by turn on gameplay logic, layout, and multiplayer syncing until it matched the in-game version from Persona 5 Royal.

## How to Play

### 1. Get into a room
- One player clicks **Create Room**. A 6-character room code appears, share it with the others.
- Everyone else enters that code and clicks **Join Room**.
- Once 2 to 4 players are in, the host clicks **Start Game**.

### 2. The goal
Be the first to play every card in your hand. Whoever empties their hand first each round becomes Tycoon, and whoever is left holding cards at the end becomes Beggar.

### 3. On your turn
- You can play a single card, a pair, or a larger matching set, as long as it beats what's currently on the pile and matches the same number of cards.
- Card strength runs 3 (lowest) through 4, 5, 6, 7, 8, 9, 10, J, Q, K, A, then 2, then Joker (highest).
- If you can't (or don't want to) beat the pile, pass.
- Once everyone else has passed, the pile clears and whoever played last leads the next trick.

### 4. Special plays
- **8 Stop.** Playing an 8 instantly clears the pile, and you lead again immediately.
- **Revolution.** Playing four of a kind flips the entire card ranking upside down for the rest of the round (Joker still stays on top).
- **3♠ Reversal.** A single 3 of Spades is the only card that can beat a single Joker.

### 5. Scoring
Whoever runs out of cards first each round earns a rank. Ranks carry into the next round's card exchange.

| Finish | Rank | Points |
|---|---|---|
| 1st | Tycoon | +30 |
| 2nd | Rich | +20 |
| 3rd | Commoner | +10 |
| 4th | Beggar | +0 |

### 6. Card exchange (rounds 2 and 3)
Before each new round starts, cards trade hands based on last round's ranks.
- The Beggar hands their 2 best cards to the Tycoon.
- The Commoner hands their 1 best card to the Rich player.
- In return, the Tycoon picks 2 cards to give back, and the Rich player picks 1.
- If the reigning Tycoon fails to finish first again, they're bankrupted straight down to Beggar for the next round.

## Built with

- **Claude**
- **Vanilla JavaScript, HTML, and CSS.** No framework or build step, the whole game runs as static files you can open directly in a browser.
- **PeerJS**, loaded from a CDN, handles the WebRTC peer-to-peer connection between players (host-authoritative, star topology) so no game server is required.
- **Google Fonts** (Bebas Neue, Oswald, Rajdhani) for the UI type.
- A sprite sheet from Sprite Resource for the card faces.


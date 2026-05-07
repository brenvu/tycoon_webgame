# TYCOON — Persona 5 Royal Card Game

A browser-based multiplayer implementation of the Tycoon card game from Persona 5 Royal.
Supports 2–4 players with P2P connections via room codes (no server needed).

## Setup

### Adding Avatars
Place `.png` or `.jpg` files in the `/avatars/` folder.
Then update `avatars/manifest.json` to list them:
```json
["Ren_Amamiya.png", "Ryuji.png", "Ann.png"]
```
The dropdown will show each file's name without its extension.

### Deploying to GitHub Pages
1. Push the entire folder to a GitHub repo
2. Go to Settings → Pages → set source to `main` branch, root folder
3. Share your `https://username.github.io/repo-name` URL

### Deploying to itch.io
1. Zip the entire folder contents
2. Create a new project on itch.io → set Kind to "HTML"
3. Upload the zip, check "This file will be played in the browser"
4. Set viewport size to 1280×720 or larger

## How to Play
- One player clicks **CREATE ROOM** and shares the 6-character code
- Other players enter the code and click **JOIN ROOM**
- Host clicks **START GAME** when 2–4 players are ready

## Game Rules (Tycoon)
- Goal: Be the first to discard all your cards each round
- Card strength: 3 (lowest) → 4 → ... → K → A → 2 → Joker → 3♠ (beats single Joker only)
- You must play higher value than the current pile, matching the number of cards played
- **8 Stop**: Immediately ends the trick, you go again
- **Revolution**: Play 4-of-a-kind to flip all card values (Joker stays strongest)
- **3♠ Reversal**: Beats a single Joker only

## Ranks & Points (per round)
| Place | Rank | Points |
|-------|------|--------|
| 1st | Tycoon | +30 |
| 2nd | Rich | +20 |
| 3rd | Commoner | +10 |
| 4th | Beggar | +0 |

**Card Exchange** (rounds 2–3):
- Beggar gives their 2 best cards to Tycoon
- Poor gives their 1 best card to Rich
- Tycoon/Rich choose 2/1 cards to give back
- If Tycoon fails to get 1st place, they are **bankrupted** to Beggar

# LFG Bot

A Discord bot for creating Looking-For-Group lobbies. Run `/lfg`, pick a game and
mode (CS2 5-stack is built in), and the bot posts a lobby card. People join by
pressing ✅. The moment it fills, the bot spins up a **private voice channel** that
only the players in the lobby can see and connect to.

## Features
- `/lfg` interactive picker (game → mode) with dropdowns
- Built-in presets: CS2, Valorant, League, Apex — add more in `config.js`
- A **Custom…** option that pops up a modal ("box") for any game, mode, size + notes
- Join / Leave / Disband buttons, live-updating roster
- Auto-creates a locked voice channel when the lobby is full
- Auto-deletes the voice channel once it's empty
- Host hand-off if the host leaves; mods can disband any lobby

## Setup

### 1. Create the bot
1. Go to https://discord.com/developers/applications → **New Application**.
2. Copy the **Application ID** → this is your `CLIENT_ID`.
3. Open the **Bot** tab → **Reset Token** → copy it → this is your `DISCORD_TOKEN`.
   - No privileged intents are required, so you can leave those toggles off.

### 2. Invite the bot
On the **OAuth2 → URL Generator** page:
- Scopes: `bot` and `applications.commands`
- Bot Permissions: **Manage Channels**, **View Channels**, **Send Messages**,
  **Embed Links**, **Read Message History**

Open the generated URL and add the bot to your server. (Manage Channels is what
lets it create the private voice channels.)

### 3. Configure
```bash
cp .env.example .env
# then edit .env and paste in your DISCORD_TOKEN and CLIENT_ID
```
For instant slash-command updates while testing, also set `GUILD_ID` to your
server's ID (enable Developer Mode in Discord → right-click the server → Copy ID).

### 4. Install & run
```bash
npm install
npm run deploy   # registers the /lfg command (run again whenever you change it)
npm start        # starts the bot
```

You should see `✅ Logged in as ...`. Type `/lfg` in any channel to try it.

## Adding more games
Edit `config.js` and copy one of the `GAMES` blocks. `size` is the player count
that fills the lobby:
```js
rocketleague: {
  label: 'Rocket League',
  emoji: '🚗',
  modes: {
    ranked3v3: { label: 'Ranked 3v3', size: 6 }, // 3v3 = 6 in one lobby? set to taste
    casual2v2: { label: 'Casual 2v2', size: 2 },
  },
},
```
Re-run `npm run deploy` after adding games so they appear in the `/lfg game` option.

## Notes & next steps
- Lobbies live in memory, so a restart clears active lobbies. For persistence,
  swap the `lobbies` Map for SQLite (e.g. `better-sqlite3`) or Redis.
- Want true reaction emotes instead of a button? You can add a
  `messageReactionAdd` listener, but buttons track the roster far more reliably,
  which is why this build uses them (styled with the ✅ emoji).

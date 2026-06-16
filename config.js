require('dotenv').config();

/**
 * ───────────────────────────────────────────────────────────────
 *  GAME PRESETS
 *  Add a new game by copying a block. `size` is the team size that
 *  triggers the lobby to fill. The first mode listed is the default.
 *
 *  `aliases` are used to (a) lock a channel to a game by its name
 *  (e.g. a channel called "lfg-cs2" only allows CS2) and (b) find the
 *  matching category to put the voice channel under (e.g. a category
 *  named "CS2" or "Counter-Strike 2"). Add any spellings people use.
 * ───────────────────────────────────────────────────────────────
 */
const GAMES = {
  cs2: {
    label: 'Counter-Strike 2',
    emoji: '🔫',
    aliases: ['cs2', 'cs', 'csgo', 'counter-strike', 'counter strike', 'counterstrike'],
    modes: {
      premier:     { label: 'Premier (5-stack)', size: 5 },
      community5v5: { label: 'Community 5v5 (captains draft)', size: 10, draft: true },
      competitive: { label: 'Competitive',        size: 5 },
      faceit:      { label: 'FACEIT',              size: 5 },
      wingman:     { label: 'Wingman',             size: 2 },
    },
  },
  valorant: {
    label: 'Valorant',
    emoji: '🎯',
    aliases: ['valorant', 'val'],
    modes: {
      competitive: { label: 'Competitive', size: 5 },
      unrated:     { label: 'Unrated',     size: 5 },
      swiftplay:   { label: 'Swiftplay',   size: 5 },
    },
  },
  lol: {
    label: 'League of Legends',
    emoji: '⚔️',
    aliases: ['lol', 'league', 'league of legends'],
    modes: {
      flex:   { label: 'Ranked Flex', size: 5 },
      normal: { label: 'Normal Draft', size: 5 },
      aram:   { label: 'ARAM', size: 5 },
    },
  },
  apex: {
    label: 'Apex Legends',
    emoji: '🟥',
    aliases: ['apex', 'apex legends'],
    modes: {
      trios:   { label: 'Trios', size: 3 },
      ranked:  { label: 'Ranked', size: 3 },
      duos:    { label: 'Duos', size: 2 },
    },
  },
};

module.exports = {
  token: process.env.DISCORD_TOKEN,
  clientId: process.env.CLIENT_ID,
  // Optional: set a guild id for INSTANT slash-command registration while testing.
  // Leave blank to register globally (can take up to ~1 hour to appear).
  guildId: process.env.GUILD_ID || null,
  // Optional fallback category for created VCs if no game-matching category is found.
  lobbyCategoryId: process.env.LOBBY_CATEGORY_ID || null,
  // If true, running /lfg in a channel whose name matches a game (e.g. "lfg-cs2")
  // locks that channel to only that game. Set to "false" in env to disable.
  lockToChannelGame: process.env.LOCK_TO_CHANNEL_GAME !== 'false',
  // Delete a created VC this long after it becomes EMPTY (after being used). 2 min.
  emptyChannelGraceMs: Number(process.env.EMPTY_CHANNEL_GRACE_MS || 120_000),
  // Delete a created VC if NOBODY ever joins it within this window. 5 min.
  initialEmptyTimeoutMs: Number(process.env.INITIAL_EMPTY_TIMEOUT_MS || 300_000),
  // How long before an unfilled lobby auto-expires (ms). 0 = never.
  lobbyExpiryMs: Number(process.env.LOBBY_EXPIRY_MS || 0),
  GAMES,
};

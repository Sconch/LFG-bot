require('dotenv').config();

/**
 * ───────────────────────────────────────────────────────────────
 *  GAME PRESETS
 *  Add a new game by copying a block. `size` is the team size that
 *  triggers the lobby to fill. The first mode listed is the default.
 * ───────────────────────────────────────────────────────────────
 */
const GAMES = {
  cs2: {
    label: 'Counter-Strike 2',
    emoji: '🔫',
    modes: {
      premier:     { label: 'Premier (5-stack)', size: 5 },
      competitive: { label: 'Competitive',        size: 5 },
      faceit:      { label: 'FACEIT',              size: 5 },
      wingman:     { label: 'Wingman',             size: 2 },
    },
  },
  valorant: {
    label: 'Valorant',
    emoji: '🎯',
    modes: {
      competitive: { label: 'Competitive', size: 5 },
      unrated:     { label: 'Unrated',     size: 5 },
      swiftplay:   { label: 'Swiftplay',   size: 5 },
    },
  },
  lol: {
    label: 'League of Legends',
    emoji: '⚔️',
    modes: {
      flex:   { label: 'Ranked Flex', size: 5 },
      normal: { label: 'Normal Draft', size: 5 },
      aram:   { label: 'ARAM', size: 5 },
    },
  },
  apex: {
    label: 'Apex Legends',
    emoji: '🟥',
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
  // Optional: a category (channel) id to nest created voice channels under.
  lobbyCategoryId: process.env.LOBBY_CATEGORY_ID || null,
  // How long an empty created VC sticks around before auto-deleting (ms).
  emptyChannelGraceMs: Number(process.env.EMPTY_CHANNEL_GRACE_MS || 90_000),
  // How long before an unfilled lobby auto-expires (ms). 0 = never.
  lobbyExpiryMs: Number(process.env.LOBBY_EXPIRY_MS || 0),
  GAMES,
};

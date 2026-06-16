const crypto = require('crypto');
const {
  Client,
  GatewayIntentBits,
  Events,
  EmbedBuilder,
  ActionRowBuilder,
  ButtonBuilder,
  ButtonStyle,
  StringSelectMenuBuilder,
  StringSelectMenuOptionBuilder,
  ModalBuilder,
  TextInputBuilder,
  TextInputStyle,
  ChannelType,
  PermissionFlagsBits,
  MessageFlags,
  REST,
  Routes,
  SlashCommandBuilder,
} = require('discord.js');

const CONFIG = require('./config');
const { GAMES } = CONFIG;

const JOIN_EMOJI = '✅'; // the "emote" people press to join

const client = new Client({
  // None of these are privileged intents — no extra toggles needed in the dev portal.
  intents: [GatewayIntentBits.Guilds, GatewayIntentBits.GuildVoiceStates],
});

// In-memory stores (reset on restart — see README for persistence notes).
const lobbies = new Map();              // lobbyId -> lobby object
const managedVoiceChannels = new Map(); // channelId -> { timeout } for auto-cleanup

// ───────────────────────── helpers ─────────────────────────

// Turn "lfg-CS2!" into "lfg cs2" and ["lfg","cs2"] for fuzzy name matching.
function normalizeName(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}
function nameTokens(s) {
  return normalizeName(s).split(' ').filter(Boolean);
}

// Best display name available for a user from an interaction.
function getDisplayName(interaction) {
  return (
    interaction.member?.displayName ||
    interaction.user.globalName ||
    interaction.user.username ||
    `Player${interaction.user.id.slice(-4)}`
  );
}

// Fisher-Yates shuffle (returns a new array).
function shuffled(arr) {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// Does a name (channel or category) match one of a game's aliases?
function nameMatchesAliases(name, aliases) {
  const tokenSet = new Set(nameTokens(name));
  const norm = normalizeName(name);
  for (const alias of aliases) {
    const at = nameTokens(alias);
    if (at.length === 0) continue;
    if (at.length === 1) {
      if (tokenSet.has(at[0])) return true;           // whole-word match, e.g. "cs2"
    } else if (norm.includes(at.join(' '))) {
      return true;                                     // phrase match, e.g. "counter strike"
    }
  }
  return false;
}

// If a channel's name matches a game (e.g. "lfg-cs2" → cs2), return that key.
function detectGameKeyFromChannel(channelName) {
  for (const [key, g] of Object.entries(GAMES)) {
    const aliases = [key, g.label, ...(g.aliases || [])];
    if (nameMatchesAliases(channelName, aliases)) return key;
  }
  return null;
}

// Find the Discord category to nest the VC under, by matching its name to the game.
async function findCategoryId(guild, { gameKey, categoryHint }) {
  if (gameKey && GAMES[gameKey]?.categoryId) return GAMES[gameKey].categoryId;

  let aliases = [];
  if (gameKey && GAMES[gameKey]) {
    const g = GAMES[gameKey];
    aliases = [gameKey, g.label, ...(g.aliases || [])];
  } else if (categoryHint) {
    aliases = [categoryHint];
  }

  try {
    const channels = await guild.channels.fetch();
    for (const ch of channels.values()) {
      if (ch && ch.type === ChannelType.GuildCategory && nameMatchesAliases(ch.name, aliases)) {
        return ch.id;
      }
    }
  } catch { /* fall through to default */ }

  return CONFIG.lobbyCategoryId || undefined;
}

function newLobby(partial) {
  const id = crypto.randomUUID().slice(0, 8);
  const lobby = {
    id,
    guildId: partial.guildId,
    channelId: partial.channelId,
    messageId: null,
    hostId: partial.hostId,
    gameKey: partial.gameKey || null,
    categoryHint: partial.categoryHint || null,
    gameLabel: partial.gameLabel,
    modeLabel: partial.modeLabel,
    size: partial.size,
    notes: partial.notes || null,
    members: [partial.hostId], // host auto-joins
    names: {},                 // userId -> display name (for draft menus)
    draft: !!partial.draft,    // is this a captains-draft lobby?
    draftState: null,          // populated when the draft starts
    draftMessageId: null,
    voiceChannelId: null,
    teamVoiceChannelIds: [],   // [teamA VC id, teamB VC id] for draft lobbies
    status: 'open',            // 'open' | 'drafting' | 'full' | 'cancelled'
    createdAt: Date.now(),
  };
  lobby.names[partial.hostId] = partial.hostName || 'Host';
  lobbies.set(id, lobby);

  if (CONFIG.lobbyExpiryMs > 0) {
    lobby._expiry = setTimeout(() => expireLobby(id), CONFIG.lobbyExpiryMs);
  }
  return lobby;
}

function buildEmbed(lobby) {
  const slots = `${lobby.members.length}/${lobby.size}`;
  const roster = lobby.members.map((id, i) => `\`${i + 1}.\` <@${id}>${id === lobby.hostId ? ' 👑' : ''}`);
  while (roster.length < lobby.size) roster.push(`\`${roster.length + 1}.\` *open slot*`);

  const color =
    lobby.status === 'full' ? 0x57f287 :
    lobby.status === 'drafting' ? 0xfee75c :
    lobby.status === 'cancelled' ? 0xed4245 :
    0x5865f2;

  const statusLine =
    lobby.status === 'drafting' ? '🟠 **DRAFTING** — captains are picking teams below!' :
    lobby.status === 'full' && lobby.members.length < lobby.size
      ? '🟢 **STARTED EARLY** — private voice channel created below!' :
    lobby.status === 'full' ? '🟢 **LOBBY FULL** — see below!' :
    lobby.status === 'cancelled' ? '🔴 **Lobby disbanded.**' :
    `🟡 Press ${JOIN_EMOJI} to join!`;

  const embed = new EmbedBuilder()
    .setColor(color)
    .setTitle(`${lobby.gameLabel} — ${lobby.modeLabel}`)
    .setDescription(statusLine)
    .addFields(
      { name: 'Slots', value: `**${slots}**`, inline: true },
      { name: 'Host', value: `<@${lobby.hostId}>`, inline: true },
      { name: 'Players', value: roster.join('\n') },
    )
    .setFooter({ text: `Lobby #${lobby.id}` })
    .setTimestamp(lobby.createdAt);

  if (lobby.notes) embed.addFields({ name: 'Notes', value: lobby.notes });
  return embed;
}

function buildButtons(lobby) {
  const open = lobby.status === 'open';
  const row = new ActionRowBuilder().addComponents(
    new ButtonBuilder()
      .setCustomId(`lfg:join:${lobby.id}`)
      .setEmoji(JOIN_EMOJI)
      .setLabel('Join')
      .setStyle(ButtonStyle.Success)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(`lfg:start:${lobby.id}`)
      .setEmoji('▶️')
      .setLabel('Start now (host)')
      .setStyle(ButtonStyle.Primary)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(`lfg:leave:${lobby.id}`)
      .setEmoji('🚪')
      .setLabel('Leave')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(!open),
    new ButtonBuilder()
      .setCustomId(`lfg:disband:${lobby.id}`)
      .setEmoji('🗑️')
      .setLabel('Disband (host)')
      .setStyle(ButtonStyle.Danger)
      .setDisabled(lobby.status === 'cancelled'),
  );
  return [row];
}

async function refreshLobbyMessage(lobby) {
  try {
    const channel = await client.channels.fetch(lobby.channelId);
    const message = await channel.messages.fetch(lobby.messageId);
    await message.edit({ embeds: [buildEmbed(lobby)], components: buildButtons(lobby) });
  } catch (err) {
    console.error(`Could not refresh lobby ${lobby.id}:`, err.message);
  }
}

async function createVoiceChannel(guild, lobby, { name, memberIds }) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    },
    {
      id: client.user.id, // make sure the bot can manage/clean up the channel
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels],
    },
    ...memberIds.map((uid) => ({
      id: uid,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    })),
  ];

  const parent = await findCategoryId(guild, {
    gameKey: lobby.gameKey,
    categoryHint: lobby.categoryHint,
  });

  const channel = await guild.channels.create({
    name: name.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: parent || undefined,
    userLimit: memberIds.length || undefined,
    permissionOverwrites: overwrites,
  });

  trackVoiceChannel(channel);
  return channel;
}

async function createPrivateVoiceChannel(guild, lobby) {
  const channel = await createVoiceChannel(guild, lobby, {
    name: `🔒 ${lobby.gameLabel} • ${lobby.modeLabel}`,
    memberIds: lobby.members,
  });
  lobby.voiceChannelId = channel.id;
  return channel;
}

// Shared "lobby is ready" path: used both when it fills naturally and when the
// host starts early. Creates the private VC and pings everyone.
async function fillLobby(lobby, guild, announceChannel, { manual = false } = {}) {
  lobby.status = 'full';
  if (lobby._expiry) clearTimeout(lobby._expiry);

  const vc = await createPrivateVoiceChannel(guild, lobby);
  await refreshLobbyMessage(lobby);

  const mentions = lobby.members.map((id) => `<@${id}>`).join(' ');
  const tag = manual ? 'started early' : 'is full';
  await announceChannel.send({
    content: `🎉 **Lobby #${lobby.id} ${tag}!** ${mentions}\nYour private voice channel → <#${vc.id}>`,
  });
  return vc;
}

// ───────────────────────── captains draft ─────────────────────────

function buildDraftEmbed(lobby) {
  const d = lobby.draftState;
  const [capA, capB] = d.captains;
  const nm = (id) => lobby.names[id] || `Player${id.slice(-4)}`;

  const teamLine = (capId) =>
    d.teams[capId].map((id, i) => `${i === 0 ? '👑 ' : `\`${i}.\` `}<@${id}>`).join('\n') || '*empty*';

  const poolLine = d.pool.length
    ? d.pool.map((id) => `• <@${id}>`).join('\n')
    : '*— everyone has been picked —*';

  const done = d.pool.length === 0;
  const current = d.pickOrder[d.turnIndex];
  const desc = done
    ? '✅ **Draft complete!** Teams are set — jump into your voice channel below.'
    : `🎲 Captains chosen at random.\n\n**On the clock:** <@${current}> — pick a player from the dropdown.`;

  return new EmbedBuilder()
    .setColor(done ? 0x57f287 : 0xfaa61a)
    .setTitle(`🎖️ Captains Draft — ${lobby.gameLabel} ${lobby.modeLabel}`)
    .setDescription(desc)
    .addFields(
      { name: `🅰️ ${nm(capA)}'s Team`, value: teamLine(capA), inline: true },
      { name: `🅱️ ${nm(capB)}'s Team`, value: teamLine(capB), inline: true },
      { name: '🎯 Available', value: poolLine },
    )
    .setFooter({ text: `Lobby #${lobby.id}` });
}

function buildDraftComponents(lobby) {
  const d = lobby.draftState;
  if (d.pool.length === 0) return []; // draft finished — no menu

  const current = d.pickOrder[d.turnIndex];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`lfg:pick:${lobby.id}`)
    .setPlaceholder(`${lobby.names[current] || 'Captain'}, pick a player…`);

  for (const id of d.pool) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel((lobby.names[id] || `Player${id.slice(-4)}`).slice(0, 100))
        .setValue(id),
    );
  }
  return [new ActionRowBuilder().addComponents(menu)];
}

async function startDraft(lobby, guild, announceChannel) {
  lobby.status = 'drafting';
  if (lobby._expiry) clearTimeout(lobby._expiry);

  // Pick 2 random captains; the rest go into the pool.
  const order = shuffled(lobby.members);
  const captains = [order[0], order[1]];
  const pool = order.slice(2);

  // Alternating pick order: A, B, A, B, … for however many are in the pool.
  const pickOrder = pool.map((_, i) => captains[i % 2]);

  lobby.draftState = {
    captains,
    teams: { [captains[0]]: [captains[0]], [captains[1]]: [captains[1]] },
    pool,
    pickOrder,
    turnIndex: 0,
  };

  await refreshLobbyMessage(lobby); // disables the old buttons, shows "DRAFTING"

  const msg = await announceChannel.send({
    content: `🎖️ **Draft time!** Captains: <@${captains[0]}> 🅰️ vs <@${captains[1]}> 🅱️`,
    embeds: [buildDraftEmbed(lobby)],
    components: buildDraftComponents(lobby),
  });
  lobby.draftMessageId = msg.id;

  // If nobody to draft (e.g. early start with only 2), finish immediately.
  if (pool.length === 0) await finalizeDraft(lobby, guild, announceChannel);
}

async function finalizeDraft(lobby, guild, announceChannel) {
  const d = lobby.draftState;
  const [capA, capB] = d.captains;
  lobby.status = 'full';

  const vcA = await createVoiceChannel(guild, lobby, {
    name: `🅰️ ${lobby.names[capA] || 'Team A'}`,
    memberIds: d.teams[capA],
  });
  const vcB = await createVoiceChannel(guild, lobby, {
    name: `🅱️ ${lobby.names[capB] || 'Team B'}`,
    memberIds: d.teams[capB],
  });
  lobby.teamVoiceChannelIds = [vcA.id, vcB.id];

  const aMentions = d.teams[capA].map((id) => `<@${id}>`).join(' ');
  const bMentions = d.teams[capB].map((id) => `<@${id}>`).join(' ');
  await announceChannel.send({
    content:
      `✅ **Teams are set for Lobby #${lobby.id}!**\n` +
      `🅰️ ${aMentions} → <#${vcA.id}>\n` +
      `🅱️ ${bMentions} → <#${vcB.id}>`,
  });
  return { vcA, vcB };
}

// Auto-delete created VCs. Two cases:
//  - nobody ever joins  → delete after initialEmptyTimeoutMs (default 5 min)
//  - emptied after use  → delete after emptyChannelGraceMs (default 2 min)
function trackVoiceChannel(channel) {
  const timeout = setTimeout(() => deleteIfEmpty(channel.id), CONFIG.initialEmptyTimeoutMs);
  managedVoiceChannels.set(channel.id, { timeout, used: false });
}

async function deleteIfEmpty(channelId) {
  const entry = managedVoiceChannels.get(channelId);
  if (!entry) return;
  try {
    const channel = await client.channels.fetch(channelId);
    if (channel && channel.members.size === 0) {
      await channel.delete('LFG lobby voice channel empty — auto cleanup.');
      managedVoiceChannels.delete(channelId);
    }
  } catch {
    managedVoiceChannels.delete(channelId); // already gone
  }
}

async function expireLobby(id) {
  const lobby = lobbies.get(id);
  if (!lobby || lobby.status !== 'open') return;
  lobby.status = 'cancelled';
  await refreshLobbyMessage(lobby);
  lobbies.delete(id);
}

// ───────────────────────── posting a lobby ─────────────────────────

async function postLobby(interaction, { gameKey, categoryHint, gameLabel, modeLabel, size, notes, draft }) {
  const lobby = newLobby({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    hostName: getDisplayName(interaction),
    gameKey,
    categoryHint,
    gameLabel,
    modeLabel,
    size,
    notes,
    draft,
  });

  const message = await interaction.channel.send({
    content: `**${interaction.user.username}** is looking for a group! ${JOIN_EMOJI}`,
    embeds: [buildEmbed(lobby)],
    components: buildButtons(lobby),
  });
  lobby.messageId = message.id;
  return lobby;
}

// ───────────────────────── pickers ─────────────────────────

function gameSelectRow() {
  const menu = new StringSelectMenuBuilder()
    .setCustomId('lfg:game')
    .setPlaceholder('Pick a game…');

  for (const [key, g] of Object.entries(GAMES)) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder().setLabel(g.label).setEmoji(g.emoji).setValue(key),
    );
  }
  menu.addOptions(
    new StringSelectMenuOptionBuilder().setLabel('Custom…').setEmoji('✏️').setValue('custom'),
  );
  return new ActionRowBuilder().addComponents(menu);
}

function modeSelectRow(gameKey) {
  const game = GAMES[gameKey];
  const menu = new StringSelectMenuBuilder()
    .setCustomId(`lfg:mode:${gameKey}`)
    .setPlaceholder('Pick a mode / type…');

  for (const [key, m] of Object.entries(game.modes)) {
    menu.addOptions(
      new StringSelectMenuOptionBuilder()
        .setLabel(m.label)
        .setDescription(`${m.size} players`)
        .setValue(key),
    );
  }
  return new ActionRowBuilder().addComponents(menu);
}

function customModal() {
  return new ModalBuilder()
    .setCustomId('lfg:custommodal')
    .setTitle('Custom Lobby')
    .addComponents(
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('game').setLabel('Game').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Rocket League').setRequired(true).setMaxLength(60),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('mode').setLabel('Game type / mode').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. Ranked 3v3').setRequired(true).setMaxLength(60),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('size').setLabel('How many players total?').setStyle(TextInputStyle.Short)
          .setPlaceholder('e.g. 3').setRequired(true).setMaxLength(3),
      ),
      new ActionRowBuilder().addComponents(
        new TextInputBuilder()
          .setCustomId('notes').setLabel('Notes (optional)').setStyle(TextInputStyle.Paragraph)
          .setPlaceholder('Rank, region, vibe, etc.').setRequired(false).setMaxLength(300),
      ),
    );
}

// ───────────────────────── interaction routing ─────────────────────────

client.on(Events.InteractionCreate, async (interaction) => {
  try {
    // /lfg
    if (interaction.isChatInputCommand() && interaction.commandName === 'lfg') {
      const preGame = interaction.options.getString('game');

      // If this channel is named after a game (e.g. "lfg-cs2"), lock it to that game.
      const lockedGame = CONFIG.lockToChannelGame
        ? detectGameKeyFromChannel(interaction.channel?.name || '')
        : null;

      if (lockedGame) {
        const g = GAMES[lockedGame];
        // Reject a game option (or custom) that doesn't match this channel.
        if (preGame && preGame !== lockedGame) {
          return interaction.reply({
            content: `🔒 This channel is for **${g.emoji} ${g.label}** only. Use a general LFG channel for other games.`,
            flags: MessageFlags.Ephemeral,
          });
        }
        // Skip the game picker — go straight to mode selection for this game.
        return interaction.reply({
          content: `🔒 **${g.emoji} ${g.label}** (locked to this channel) — pick a mode:`,
          components: [modeSelectRow(lockedGame)],
          flags: MessageFlags.Ephemeral,
        });
      }

      if (preGame === 'custom') {
        return interaction.showModal(customModal());
      }
      if (preGame && GAMES[preGame]) {
        return interaction.reply({
          content: `**${GAMES[preGame].emoji} ${GAMES[preGame].label}** — now pick a mode:`,
          components: [modeSelectRow(preGame)],
          flags: MessageFlags.Ephemeral,
        });
      }
      return interaction.reply({
        content: 'Let’s set up a lobby. **What are we playing?**',
        components: [gameSelectRow()],
        flags: MessageFlags.Ephemeral,
      });
    }

    // Game picked
    if (interaction.isStringSelectMenu() && interaction.customId === 'lfg:game') {
      const gameKey = interaction.values[0];
      if (gameKey === 'custom') return interaction.showModal(customModal());

      return interaction.update({
        content: `**${GAMES[gameKey].emoji} ${GAMES[gameKey].label}** — now pick a mode:`,
        components: [modeSelectRow(gameKey)],
      });
    }

    // Mode picked → post the lobby
    if (interaction.isStringSelectMenu() && interaction.customId.startsWith('lfg:mode:')) {
      const gameKey = interaction.customId.split(':')[2];
      const modeKey = interaction.values[0];
      const game = GAMES[gameKey];
      const mode = game.modes[modeKey];

      await postLobby(interaction, {
        gameKey,
        categoryHint: game.label,
        gameLabel: `${game.emoji} ${game.label}`,
        modeLabel: mode.label,
        size: mode.size,
        draft: !!mode.draft,
      });

      return interaction.update({
        content: `✅ Lobby posted in this channel! People can join with ${JOIN_EMOJI}.`,
        components: [],
      });
    }

    // Custom modal submitted
    if (interaction.isModalSubmit() && interaction.customId === 'lfg:custommodal') {
      const gameName = interaction.fields.getTextInputValue('game').trim();
      const modeName = interaction.fields.getTextInputValue('mode').trim();
      const sizeRaw = interaction.fields.getTextInputValue('size').trim();
      const notes = interaction.fields.getTextInputValue('notes').trim() || null;

      const size = parseInt(sizeRaw, 10);
      if (Number.isNaN(size) || size < 2 || size > 99) {
        return interaction.reply({
          content: '❌ Player count must be a number between 2 and 99.',
          flags: MessageFlags.Ephemeral,
        });
      }

      await postLobby(interaction, { gameKey: null, categoryHint: gameName, gameLabel: `🎮 ${gameName}`, modeLabel: modeName, size, notes });
      return interaction.reply({
        content: `✅ Custom lobby posted! People can join with ${JOIN_EMOJI}.`,
        flags: MessageFlags.Ephemeral,
      });
    }

    // Button presses
    if (interaction.isButton() && interaction.customId.startsWith('lfg:')) {
      const [, action, lobbyId] = interaction.customId.split(':');
      const lobby = lobbies.get(lobbyId);

      if (!lobby || lobby.status === 'cancelled') {
        return interaction.reply({ content: '⚠️ This lobby is no longer active.', flags: MessageFlags.Ephemeral });
      }

      // JOIN
      if (action === 'join') {
        if (lobby.status !== 'open') {
          return interaction.reply({ content: '⚠️ This lobby is already full.', flags: MessageFlags.Ephemeral });
        }
        if (lobby.members.includes(interaction.user.id)) {
          return interaction.reply({ content: 'You’re already in this lobby. 👍', flags: MessageFlags.Ephemeral });
        }

        lobby.members.push(interaction.user.id);
        lobby.names[interaction.user.id] = getDisplayName(interaction);

        // Filled up?
        if (lobby.members.length >= lobby.size) {
          await interaction.deferUpdate();
          if (lobby.draft) await startDraft(lobby, interaction.guild, interaction.channel);
          else await fillLobby(lobby, interaction.guild, interaction.channel);
          return;
        }

        await refreshLobbyMessage(lobby);
        return interaction.reply({ content: `Joined **Lobby #${lobby.id}**! ✅`, flags: MessageFlags.Ephemeral });
      }

      // START EARLY (host / mod) — create the VC even if not full
      if (action === 'start') {
        const isHost = interaction.user.id === lobby.hostId;
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
        if (!isHost && !isAdmin) {
          return interaction.reply({ content: 'Only the host (👑) or a moderator can start the lobby early.', flags: MessageFlags.Ephemeral });
        }
        if (lobby.status !== 'open') {
          return interaction.reply({ content: '⚠️ This lobby has already started.', flags: MessageFlags.Ephemeral });
        }
        if (lobby.draft && lobby.members.length < 4) {
          return interaction.reply({ content: 'You need at least 4 players to start a captains draft.', flags: MessageFlags.Ephemeral });
        }
        await interaction.deferUpdate();
        if (lobby.draft) await startDraft(lobby, interaction.guild, interaction.channel);
        else await fillLobby(lobby, interaction.guild, interaction.channel, { manual: true });
        return;
      }

      // DRAFT PICK (captain selects a player)
      if (action === 'pick') {
        if (lobby.status !== 'drafting' || !lobby.draftState) {
          return interaction.reply({ content: '⚠️ This draft isn’t active.', flags: MessageFlags.Ephemeral });
        }
        const d = lobby.draftState;
        const current = d.pickOrder[d.turnIndex];
        if (interaction.user.id !== current) {
          const youCaptain = d.captains.includes(interaction.user.id);
          return interaction.reply({
            content: youCaptain ? '⏳ It’s the other captain’s turn to pick.' : 'Only the captain on the clock can pick right now.',
            flags: MessageFlags.Ephemeral,
          });
        }

        const pickedId = interaction.values[0];
        if (!d.pool.includes(pickedId)) {
          return interaction.reply({ content: 'That player was just taken — pick again.', flags: MessageFlags.Ephemeral });
        }

        // Apply the pick.
        d.pool = d.pool.filter((id) => id !== pickedId);
        d.teams[current].push(pickedId);
        d.turnIndex += 1;

        if (d.pool.length === 0) {
          await interaction.deferUpdate();
          await finalizeDraft(lobby, interaction.guild, interaction.channel);
          await interaction.editReply({ embeds: [buildDraftEmbed(lobby)], components: [] });
        } else {
          await interaction.update({ embeds: [buildDraftEmbed(lobby)], components: buildDraftComponents(lobby) });
        }
        return;
      }

      // LEAVE
      if (action === 'leave') {
        if (!lobby.members.includes(interaction.user.id)) {
          return interaction.reply({ content: 'You’re not in this lobby.', flags: MessageFlags.Ephemeral });
        }
        lobby.members = lobby.members.filter((id) => id !== interaction.user.id);

        // If the host left, hand off or disband.
        if (interaction.user.id === lobby.hostId) {
          if (lobby.members.length > 0) {
            lobby.hostId = lobby.members[0];
          } else {
            lobby.status = 'cancelled';
            await refreshLobbyMessage(lobby);
            lobbies.delete(lobby.id);
            return interaction.reply({ content: 'You left and the lobby was empty, so it was disbanded.', flags: MessageFlags.Ephemeral });
          }
        }

        await refreshLobbyMessage(lobby);
        return interaction.reply({ content: `Left **Lobby #${lobby.id}**. 🚪`, flags: MessageFlags.Ephemeral });
      }

      // DISBAND
      if (action === 'disband') {
        const isHost = interaction.user.id === lobby.hostId;
        const isAdmin = interaction.memberPermissions?.has(PermissionFlagsBits.ManageChannels);
        if (!isHost && !isAdmin) {
          return interaction.reply({ content: 'Only the host (👑) or a moderator can disband this lobby.', flags: MessageFlags.Ephemeral });
        }

        lobby.status = 'cancelled';
        if (lobby._expiry) clearTimeout(lobby._expiry);

        // Tear down any VCs this lobby created (single or both team channels).
        const vcIds = [lobby.voiceChannelId, ...lobby.teamVoiceChannelIds].filter(Boolean);
        for (const vcId of vcIds) {
          try {
            const vc = await client.channels.fetch(vcId);
            await vc.delete('Lobby disbanded by host.');
          } catch { /* already gone */ }
          managedVoiceChannels.delete(vcId);
        }

        // If a draft was in progress, close out its message too.
        if (lobby.draftMessageId) {
          try {
            const ch = await client.channels.fetch(lobby.channelId);
            const dmsg = await ch.messages.fetch(lobby.draftMessageId);
            await dmsg.edit({ content: '🔴 Draft cancelled (lobby disbanded).', embeds: [], components: [] });
          } catch { /* ignore */ }
        }

        await refreshLobbyMessage(lobby);
        lobbies.delete(lobby.id);
        return interaction.reply({ content: 'Lobby disbanded. 🗑️', flags: MessageFlags.Ephemeral });
      }
    }
  } catch (err) {
    console.error('Interaction error:', err);
    if (interaction.isRepliable() && !interaction.replied && !interaction.deferred) {
      interaction.reply({ content: '⚠️ Something went wrong handling that.', flags: MessageFlags.Ephemeral }).catch(() => {});
    }
  }
});

// Track joins/leaves on managed VCs to drive cleanup.
client.on(Events.VoiceStateUpdate, (oldState, newState) => {
  const joined = newState.channel;
  const left = oldState.channel;

  // Someone joined a managed channel → mark used, cancel any pending deletion.
  if (joined && managedVoiceChannels.has(joined.id)) {
    const entry = managedVoiceChannels.get(joined.id);
    entry.used = true;
    if (entry.timeout) { clearTimeout(entry.timeout); entry.timeout = null; }
  }

  // Someone left a managed channel and it's now empty → start the 2-min timer
  // (only once it has actually been used, so we don't double-handle creation).
  if (left && left.id !== joined?.id && managedVoiceChannels.has(left.id) && left.members.size === 0) {
    const entry = managedVoiceChannels.get(left.id);
    if (entry.used) {
      if (entry.timeout) clearTimeout(entry.timeout);
      entry.timeout = setTimeout(() => deleteIfEmpty(left.id), CONFIG.emptyChannelGraceMs);
    }
  }
});

// Register the /lfg slash command automatically on startup, so there's no
// separate "deploy" step to run. A PUT just overwrites the existing command.
async function registerCommands() {
  const gameChoices = Object.entries(GAMES)
    .map(([key, g]) => ({ name: `${g.emoji} ${g.label}`, value: key }))
    .slice(0, 24);
  gameChoices.push({ name: '✏️ Custom…', value: 'custom' });

  const command = new SlashCommandBuilder()
    .setName('lfg')
    .setDescription('Create a Looking-For-Group lobby. People join, and a private VC opens when it fills.')
    .addStringOption((opt) =>
      opt
        .setName('game')
        .setDescription('Optionally pick a game right away to skip a step.')
        .setRequired(false)
        .addChoices(...gameChoices))
    .toJSON();

  const rest = new REST({ version: '10' }).setToken(CONFIG.token);
  try {
    if (CONFIG.guildId) {
      await rest.put(Routes.applicationGuildCommands(CONFIG.clientId, CONFIG.guildId), { body: [command] });
      console.log(`✅ /lfg registered to guild ${CONFIG.guildId} (instant).`);
    } else {
      await rest.put(Routes.applicationCommands(CONFIG.clientId), { body: [command] });
      console.log('✅ /lfg registered globally (may take up to ~1 hour the first time).');
    }
  } catch (err) {
    console.error('⚠️ Could not register /lfg command:', err.message);
  }
}

client.once(Events.ClientReady, async (c) => {
  console.log(`✅ Logged in as ${c.user.tag}. Ready to make lobbies!`);
  await registerCommands();
});

if (!CONFIG.token) {
  console.error('❌ Missing DISCORD_TOKEN in your .env file.');
  process.exit(1);
}
client.login(CONFIG.token);

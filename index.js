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

function newLobby(partial) {
  const id = crypto.randomUUID().slice(0, 8);
  const lobby = {
    id,
    guildId: partial.guildId,
    channelId: partial.channelId,
    messageId: null,
    hostId: partial.hostId,
    gameLabel: partial.gameLabel,
    modeLabel: partial.modeLabel,
    size: partial.size,
    notes: partial.notes || null,
    members: [partial.hostId], // host auto-joins
    voiceChannelId: null,
    status: 'open', // 'open' | 'full' | 'cancelled'
    createdAt: Date.now(),
  };
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
    lobby.status === 'cancelled' ? 0xed4245 :
    0x5865f2;

  const statusLine =
    lobby.status === 'full' ? '🟢 **LOBBY FULL** — private voice channel created below!' :
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

async function createPrivateVoiceChannel(guild, lobby) {
  const overwrites = [
    {
      id: guild.roles.everyone.id,
      deny: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    },
    {
      id: client.user.id, // make sure the bot can manage/clean up the channel
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect, PermissionFlagsBits.ManageChannels],
    },
    ...lobby.members.map((uid) => ({
      id: uid,
      allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.Connect],
    })),
  ];

  const channel = await guild.channels.create({
    name: `🔒 ${lobby.gameLabel} • ${lobby.modeLabel}`.slice(0, 100),
    type: ChannelType.GuildVoice,
    parent: CONFIG.lobbyCategoryId || undefined,
    userLimit: lobby.size,
    permissionOverwrites: overwrites,
  });

  lobby.voiceChannelId = channel.id;
  trackVoiceChannel(channel);
  return channel;
}

// Auto-delete created VCs once they're empty (with a grace period so it's not
// nuked before anyone joins).
function trackVoiceChannel(channel) {
  const timeout = setTimeout(() => deleteIfEmpty(channel.id), CONFIG.emptyChannelGraceMs);
  managedVoiceChannels.set(channel.id, { timeout });
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

async function postLobby(interaction, { gameLabel, modeLabel, size, notes }) {
  const lobby = newLobby({
    guildId: interaction.guildId,
    channelId: interaction.channelId,
    hostId: interaction.user.id,
    gameLabel,
    modeLabel,
    size,
    notes,
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
        gameLabel: `${game.emoji} ${game.label}`,
        modeLabel: mode.label,
        size: mode.size,
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

      await postLobby(interaction, { gameLabel: `🎮 ${gameName}`, modeLabel: modeName, size, notes });
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

        // Filled up?
        if (lobby.members.length >= lobby.size) {
          lobby.status = 'full';
          if (lobby._expiry) clearTimeout(lobby._expiry);

          await interaction.deferUpdate();
          const vc = await createPrivateVoiceChannel(interaction.guild, lobby);
          await refreshLobbyMessage(lobby);

          const mentions = lobby.members.map((id) => `<@${id}>`).join(' ');
          await interaction.channel.send({
            content: `🎉 **Lobby #${lobby.id} is full!** ${mentions}\nYour private voice channel is ready → <#${vc.id}>`,
          });
          return;
        }

        await refreshLobbyMessage(lobby);
        return interaction.reply({ content: `Joined **Lobby #${lobby.id}**! ✅`, flags: MessageFlags.Ephemeral });
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

        // Tear down the VC if one was created.
        if (lobby.voiceChannelId) {
          try {
            const vc = await client.channels.fetch(lobby.voiceChannelId);
            await vc.delete('Lobby disbanded by host.');
            managedVoiceChannels.delete(lobby.voiceChannelId);
          } catch { /* already gone */ }
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

// Clean up empty managed voice channels.
client.on(Events.VoiceStateUpdate, (oldState) => {
  const chan = oldState.channel;
  if (chan && managedVoiceChannels.has(chan.id) && chan.members.size === 0) {
    const entry = managedVoiceChannels.get(chan.id);
    if (entry?.timeout) clearTimeout(entry.timeout);
    const timeout = setTimeout(() => deleteIfEmpty(chan.id), CONFIG.emptyChannelGraceMs);
    managedVoiceChannels.set(chan.id, { timeout });
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

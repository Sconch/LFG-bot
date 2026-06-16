const { REST, Routes, SlashCommandBuilder } = require('discord.js');
const { token, clientId, guildId, GAMES } = require('./config');

// Build the optional `game` choices straight from the presets (+ a Custom option).
const gameChoices = Object.entries(GAMES)
  .map(([key, g]) => ({ name: `${g.emoji} ${g.label}`, value: key }))
  .slice(0, 24); // Discord allows max 25 choices; leave room for "Custom".
gameChoices.push({ name: '✏️ Custom…', value: 'custom' });

const command = new SlashCommandBuilder()
  .setName('lfg')
  .setDescription('Create a Looking-For-Group lobby. People join, and a private VC opens when it fills.')
  .addStringOption((opt) =>
    opt
      .setName('game')
      .setDescription('Optionally pick a game right away to skip a step.')
      .setRequired(false)
      .addChoices(...gameChoices)
  )
  .toJSON();

(async () => {
  if (!token || !clientId) {
    console.error('❌ Missing DISCORD_TOKEN or CLIENT_ID in your .env file.');
    process.exit(1);
  }

  const rest = new REST({ version: '10' }).setToken(token);

  try {
    if (guildId) {
      await rest.put(Routes.applicationGuildCommands(clientId, guildId), { body: [command] });
      console.log(`✅ Registered /lfg to guild ${guildId} (appears instantly).`);
    } else {
      await rest.put(Routes.applicationCommands(clientId), { body: [command] });
      console.log('✅ Registered /lfg globally (may take up to ~1 hour to appear).');
    }
  } catch (err) {
    console.error('❌ Failed to register commands:', err);
    process.exit(1);
  }
})();

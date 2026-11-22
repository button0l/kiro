require('dotenv').config();
const { Client, GatewayIntentBits, Events } = require('discord.js');
const {
    handleChatMessage,
    handleVoiceStateUpdate,
    handleRankCommand,
    handleTopCommand,
    handleLevelResetCommand,
    handleLevelResetAllCommand,
    handleLevelButton
} = require('./leveling');
const {
    handleRecruitCommand,
    handleRecruitSelectMenu,
    handleRecruitButton,
    handleRecruitModalSubmit
} = require('./recruit');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMembers,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates,
    ]
});

client.once(Events.ClientReady, readyClient => {
    console.log(`起動完了: ${readyClient.user.tag} がオンラインになりました！`);
});

// チャット投稿時のXP付与
client.on(Events.MessageCreate, async message => {
    try {
        await handleChatMessage(message);
    } catch (error) {
        console.error('チャットXP処理エラー:', error);
    }
});

// ボイスチャンネル入退室時のXP付与
client.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    try {
        await handleVoiceStateUpdate(oldState, newState);
    } catch (error) {
        console.error('VC XP処理エラー:', error);
    }
});

// スラッシュコマンド・セレクトメニュー・ボタン・モーダルの統合窓口
client.on(Events.InteractionCreate, async interaction => {
    try {
        if (interaction.isChatInputCommand()) {
            if (interaction.commandName === 'recruit') {
                await handleRecruitCommand(interaction);
            } else if (interaction.commandName === 'rank') {
                await handleRankCommand(interaction);
            } else if (interaction.commandName === 'top') {
                await handleTopCommand(interaction);
            } else if (interaction.commandName === 'level-reset') {
                await handleLevelResetCommand(interaction);
            } else if (interaction.commandName === 'level-reset-all') {
                await handleLevelResetAllCommand(interaction);
            }
            return;
        }

        if (interaction.isStringSelectMenu()) {
            if (interaction.customId.startsWith('recruit_menu_')) {
                await handleRecruitSelectMenu(interaction);
            }
            return;
        }

        if (interaction.isButton()) {
            if (interaction.customId.startsWith('recruit_')) {
                await handleRecruitButton(interaction);
            } else if (interaction.customId.startsWith('level_reset_')) {
                await handleLevelButton(interaction);
            }
            return;
        }

        if (interaction.isModalSubmit()) {
            if (interaction.customId === 'recruit_text_modal') {
                await handleRecruitModalSubmit(interaction);
            }
            return;
        }
    } catch (error) {
        console.error('Interactionエラー:', error);
        if (!interaction.replied && !interaction.deferred) {
            await interaction.reply({
                content: '⚠️ 処理中にエラーが発生しました。時間をおいて再度お試しください。',
                ephemeral: true
            }).catch(() => {});
        }
    }
});

client.login(process.env.DISCORD_TOKEN);

// WebサーバーをBotと同じプロセスで起動（activerecruitmentsを共有するため）
// clientを渡してユーザー情報取得に使えるようにする
require('./web/server')(client);
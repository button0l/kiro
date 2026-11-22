require('dotenv').config();
const { REST, Routes, SlashCommandBuilder, PermissionFlagsBits } = require('discord.js');

const commands = [
    new SlashCommandBuilder()
        .setName('recruit')
        .setDescription('VALORANTのパーティー募集パネルを作成します'),

    new SlashCommandBuilder()
        .setName('rank')
        .setDescription('自分または指定したメンバーの現在のレベル・XPを確認します')
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('レベルを調べたいメンバー（未指定なら自分を表示）')
                .setRequired(false)
        ),

    new SlashCommandBuilder()
        .setName('top')
        .setDescription('サーバー内のレベル・XPランキング TOP20 を表示します'),

    new SlashCommandBuilder()
        .setName('level-reset')
        .setDescription('【管理者専用】指定メンバーのレベルとXPを初期状態にリセットします')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
        .addUserOption(option =>
            option
                .setName('user')
                .setDescription('レベルをリセットする対象メンバー')
                .setRequired(true)
        ),

    new SlashCommandBuilder()
        .setName('level-reset-all')
        .setDescription('【管理者専用】サーバー内全員のレベルとXPを初期状態に一括リセットします')
        .setDefaultMemberPermissions(PermissionFlagsBits.Administrator),
].map(command => command.toJSON());

const rest = new REST({ version: '10' }).setToken(process.env.DISCORD_TOKEN);

(async () => {
    try {
        console.log('スラッシュコマンドをDiscordへ登録中...');

        if (process.env.GUILD_ID) {
            await rest.put(
                Routes.applicationGuildCommands(process.env.CLIENT_ID, process.env.GUILD_ID),
                { body: commands }
            );
            console.log('✅ サーバー専用コマンドの登録が完了しました！（即時反映）');
        } else {
            await rest.put(
                Routes.applicationCommands(process.env.CLIENT_ID),
                { body: commands }
            );
            console.log('✅ グローバルコマンドの登録が完了しました！');
        }
    } catch (error) {
        console.error('❌ コマンド登録エラー:', error);
    }
})();
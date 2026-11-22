const {
    EmbedBuilder,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle,
    PermissionFlagsBits
} = require('discord.js');
const {
    getOrCreateUser,
    updateUserProgress,
    getTopUsers,
    resetUserLevel,
    resetAllLevels
} = require('./database');

// チャットXPのクールダウン管理用メモリキャッシュ（DBへの過剰な書き込み防止）
// キー: "guildId_userId", 値: 最後にXPを獲得したUNIXタイムスタンプ(ms)
const chatCooldowns = new Map();
const COOLDOWN_MS = 60 * 1000; // 1分間

// VC滞在時間の計測用メモリキャッシュ
// キー: "guildId_userId", 値: VCに入室したUNIXタイムスタンプ(ms)
const vcJoinTimes = new Map();

// レベル到達時の自動ロール報酬設定（サーバー内のロール名と完全一致させる）
const LEVEL_ROLES = {
    2: 'ブロンズ常連',
    5: 'シルバー常連',
    10: 'ゴールド常連',
    20: 'ダイヤ常連',
};

/**
 * 次のレベルに必要な累計XPを計算する式
 * 例: Lv.1→2 は 100XP, Lv.2→3 は 300XP
 */
function getRequiredXpForLevel(level) {
    return 50 * (level ** 2) + 50 * level;
}

/**
 * XPを加算し、レベルアップ判定・自動ロール付与・お祝い通知を行う共通関数
 * asyncにする理由: Discord APIへのロール付与やメッセージ送信はネットワーク通信を伴うため待機（await）が必要だから
 */
async function addXpAndCheckLevelUp(member, addedXp, notifyChannel = null, addedVcMinutes = 0) {
    if (!member || member.user.bot) return;

    const userId = member.id;
    const guildId = member.guild.id;
    const userData = getOrCreateUser(userId, guildId);

    const newXp = userData.xp + addedXp;
    let currentLevel = userData.level;
    let leveledUp = false;

    // 複数レベル一気に上がった場合にも対応するため while で判定する
    while (newXp >= getRequiredXpForLevel(currentLevel)) {
        currentLevel++;
        leveledUp = true;
    }

    updateUserProgress(userId, guildId, newXp, currentLevel, addedVcMinutes);

    if (leveledUp) {
        let grantedRoleName = null;

        if (LEVEL_ROLES[currentLevel]) {
            const targetRoleName = LEVEL_ROLES[currentLevel];
            const role = member.guild.roles.cache.find(r => r.name === targetRoleName);

            if (role) {
                try {
                    // try-catchで囲む理由: Botのロール位置が報酬ロールより下だと権限エラーになるため、Bot全体の停止を防ぐため
                    await member.roles.add(role);
                    grantedRoleName = role.name;
                } catch (err) {
                    console.error(`ロール付与失敗 (${targetRoleName}): Botのロールを報酬ロールより上に移動してください。`, err.message);
                }
            }
        }

        if (notifyChannel) {
            try {
                let msg = `🎉 **${member.displayName}** さんが **Lv.${currentLevel}** にレベルアップしました！`;
                if (grantedRoleName) {
                    msg += `\n🏅 報酬ロール **「${grantedRoleName}」** を獲得しました！`;
                }
                await notifyChannel.send(msg);
            } catch (err) {
                console.error('レベルアップ通知の送信に失敗:', err.message);
            }
        }
    }
}

/**
 * 1. チャット投稿時のXP処理（1分クールダウン）
 */
async function handleChatMessage(message) {
    if (!message.guild || message.author.bot) return;

    const cacheKey = `${message.guild.id}_${message.author.id}`;
    const now = Date.now();
    const lastEarned = chatCooldowns.get(cacheKey) || 0;

    // クールダウン中はDBに触れず即終了して負荷を抑える
    if (now - lastEarned < COOLDOWN_MS) return;

    chatCooldowns.set(cacheKey, now);

    // 15〜25XPをランダム付与
    const earnedXp = Math.floor(Math.random() * 11) + 15;
    await addXpAndCheckLevelUp(message.member, earnedXp, message.channel, 0);
}

/**
 * 2. VCの入退室・移動時のXP処理（退室時に滞在時間を一括計算してDB保存）
 */
async function handleVoiceStateUpdate(oldState, newState) {
    const member = newState.member || oldState.member;
    if (!member || member.user.bot) return;

    const cacheKey = `${member.guild.id}_${member.id}`;
    const now = Date.now();

    const wasInVc = Boolean(oldState.channelId);
    const isInVc = Boolean(newState.channelId);

    // 入室時刻を記録
    if (!wasInVc && isInVc) {
        vcJoinTimes.set(cacheKey, now);
        return;
    }

    // 退室またはAFKチャンネル移動時にまとめて計算
    const afkChannelId = member.guild.afkChannelId;
    const movedToAfk = isInVc && newState.channelId === afkChannelId;

    if ((wasInVc && !isInVc) || movedToAfk) {
        const joinedAt = vcJoinTimes.get(cacheKey);
        if (!joinedAt) return;

        vcJoinTimes.delete(cacheKey);

        const stayedMinutes = Math.floor((now - joinedAt) / (60 * 1000));
        if (stayedMinutes >= 1) {
            const earnedXp = stayedMinutes * 10;
            const notifyChannel = member.guild.systemChannel || null;
            await addXpAndCheckLevelUp(member, earnedXp, notifyChannel, stayedMinutes);
            console.log(`[VC XP] ${member.displayName}: ${stayedMinutes}分滞在 -> +${earnedXp}XP`);
        }
    }
}

/**
 * 3. /rank コマンド処理（自分または指定ユーザーのレベル・XP検索）
 */
async function handleRankCommand(interaction) {
    const targetUser = interaction.options.getUser('user') || interaction.user;

    if (targetUser.bot) {
        return interaction.reply({
            content: '⚠️ Botのレベルは集計対象外です。',
            ephemeral: true
        });
    }

    const targetMember = await interaction.guild.members.fetch(targetUser.id).catch(() => null);
    const displayName = targetMember ? targetMember.displayName : targetUser.username;

    const userData = getOrCreateUser(targetUser.id, interaction.guild.id);
    const nextLevelXp = getRequiredXpForLevel(userData.level);
    const prevLevelXp = userData.level === 1 ? 0 : getRequiredXpForLevel(userData.level - 1);

    const currentProgress = Math.max(userData.xp - prevLevelXp, 0);
    const neededForNext = Math.max(nextLevelXp - prevLevelXp, 1);
    const ratio = Math.min(Math.max(currentProgress / neededForNext, 0), 1);
    const filledBlocks = Math.round(ratio * 10);
    const progressBar = '🟦'.repeat(filledBlocks) + '⬜'.repeat(10 - filledBlocks);

    const embed = new EmbedBuilder()
        .setColor(0xFF4655)
        .setAuthor({
            name: `${displayName} のコミュニティステータス`,
            iconURL: targetUser.displayAvatarURL()
        })
        .addFields(
            { name: '現在のレベル', value: `**Lv.${userData.level}**`, inline: true },
            { name: '累計XP', value: `**${userData.xp.toLocaleString()} XP**`, inline: true },
            { name: '累計VC滞在時間', value: `**${userData.vc_minutes.toLocaleString()} 分**`, inline: true },
            {
                name: `次のレベルまで (${currentProgress.toLocaleString()} / ${neededForNext.toLocaleString()} XP)`,
                value: `${progressBar} (${Math.floor(ratio * 100)}%)`
            }
        )
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

/**
 * 4. /top コマンド処理（サーバー内レベル＆XPランキング TOP20 表示）
 */
async function handleTopCommand(interaction) {
    const topUsers = getTopUsers(interaction.guild.id, 20);

    if (!topUsers || topUsers.length === 0) {
        return interaction.reply({
            content: '📊 まだXPを獲得しているメンバーがいません。チャットやVCで最初の1位を目指しましょう！',
            ephemeral: true
        });
    }

    const medals = ['🥇', '🥈', '🥉'];
    const lines = topUsers.map((row, index) => {
        const rankBadge = medals[index] || `**#${index + 1}**`;
        return `${rankBadge} <@${row.user_id}> — **Lv.${row.level}**（\`${row.xp.toLocaleString()} XP\` / VC: ${row.vc_minutes}分）`;
    });

    const embed = new EmbedBuilder()
        .setColor(0xFFD700)
        .setTitle(`🏆 ${interaction.guild.name} レベルランキング TOP${topUsers.length}`)
        .setDescription(lines.join('\n'))
        .setFooter({ text: 'チャット（1分毎）やVC滞在・パーティー募集成立でXPが貯まります' })
        .setTimestamp();

    await interaction.reply({ embeds: [embed] });
}

/**
 * 5. /level-reset コマンド処理（管理者専用・個人リセットの確認画面）
 * 理由: Discord側のコマンド権限設定だけでなく、コード内でも Administrator を二重チェックして誤操作や不正実行を防ぐため
 */
async function handleLevelResetCommand(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: '⛔ このコマンドは **サーバー管理者（Administrator）** のみ実行できます。',
            ephemeral: true
        });
    }

    const targetUser = interaction.options.getUser('user', true);
    if (targetUser.bot) {
        return interaction.reply({
            content: '⚠️ Botはリセット対象に指定できません。',
            ephemeral: true
        });
    }

    const currentData = getOrCreateUser(targetUser.id, interaction.guild.id);

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`level_reset_confirm_${targetUser.id}`)
            .setLabel('リセットを実行する')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⚠️'),
        new ButtonBuilder()
            .setCustomId('level_reset_cancel')
            .setLabel('キャンセル')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
        content:
            `⚠️ **レベルリセットの確認**\n` +
            `対象メンバー: <@${targetUser.id}>（現在 **Lv.${currentData.level}** / **${currentData.xp.toLocaleString()} XP**）\n` +
            `本当に **Lv.1 / 0 XP** に初期化しますか？この操作は取り消せません。`,
        components: [confirmRow],
        ephemeral: true
    });
}

/**
 * 6. /level-reset-all コマンド処理（管理者専用・全員一括リセットの確認画面）
 */
async function handleLevelResetAllCommand(interaction) {
    if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
        return interaction.reply({
            content: '⛔ このコマンドは **サーバー管理者（Administrator）** のみ実行できます。',
            ephemeral: true
        });
    }

    const confirmRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('level_reset_all_confirm')
            .setLabel('全員をリセットする')
            .setStyle(ButtonStyle.Danger)
            .setEmoji('⚠️'),
        new ButtonBuilder()
            .setCustomId('level_reset_all_cancel')
            .setLabel('キャンセル')
            .setStyle(ButtonStyle.Secondary)
    );

    await interaction.reply({
        content:
            `⚠️ **【重要】サーバー全員のレベル一括リセット確認**\n` +
            `**${interaction.guild.name}** 内の全メンバーのレベルとXPを **Lv.1 / 0 XP** に初期化します。\n` +
            `本当によろしいですか？この操作は元に戻せません。`,
        components: [confirmRow],
        ephemeral: true
    });
}

/**
 * 7. レベルリセット系ボタン（個人確認・個人キャンセル・全員確認・全員キャンセル）の処理
 */
async function handleLevelButton(interaction) {
    const { customId } = interaction;

    if (customId === 'level_reset_cancel') {
        return interaction.update({
            content: '❎ レベルリセットをキャンセルしました。',
            components: []
        });
    }

    if (customId.startsWith('level_reset_confirm_')) {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '⛔ この操作はサーバー管理者のみ実行できます。',
                ephemeral: true
            });
        }

        const targetUserId = customId.replace('level_reset_confirm_', '');
        resetUserLevel(targetUserId, interaction.guild.id);

        return interaction.update({
            content: `✅ <@${targetUserId}> さんのレベルとXPを **Lv.1（0 XP）** にリセットしました。`,
            components: []
        });
    }

    if (customId === 'level_reset_all_cancel') {
        return interaction.update({
            content: '❎ 全員リセットをキャンセルしました。',
            components: []
        });
    }

    if (customId === 'level_reset_all_confirm') {
        if (!interaction.memberPermissions || !interaction.memberPermissions.has(PermissionFlagsBits.Administrator)) {
            return interaction.reply({
                content: '⛔ この操作はサーバー管理者のみ実行できます。',
                ephemeral: true
            });
        }

        const result = resetAllLevels(interaction.guild.id);

        return interaction.update({
            content: `✅ サーバー内 **${result.changes}名** 分のレベルとXPを **Lv.1（0 XP）** に一括リセットしました。`,
            components: []
        });
    }
}

module.exports = {
    handleChatMessage,
    handleVoiceStateUpdate,
    addXpAndCheckLevelUp,
    getRequiredXpForLevel,
    handleRankCommand,
    handleTopCommand,
    handleLevelResetCommand,
    handleLevelResetAllCommand,
    handleLevelButton,
};
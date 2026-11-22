const {
    ActionRowBuilder,
    StringSelectMenuBuilder,
    ButtonBuilder,
    ButtonStyle,
    EmbedBuilder,
    ModalBuilder,
    TextInputBuilder,
    TextInputStyle
} = require('discord.js');
const { addXpAndCheckLevelUp } = require('./leveling');

// 募集作成中のユーザーの選択状態を一時保持するメモリキャッシュ（キー: userId）
const recruitDrafts = new Map();

// 投稿済みの募集パネルを管理するメモリキャッシュ（キー: messageId）
const activeRecruitments = new Map();

// 投稿時に自動メンションするロール名
const RECRUIT_MENTION_ROLE_NAMES = ['募集', 'VALORANT募集'];

// 30分再募集確認用の待機時間（ミリ秒）
const RECRUIT_REMIND_MS = 30 * 60 * 1000;

// 1時間（60分）更新がなかった場合の自動〆切時間（ミリ秒）
const RECRUIT_AUTO_CLOSE_MS = 60 * 60 * 1000;

// 募集成立時（参加者1人以上で〆切）に付与するボーナスXP
const RECRUIT_COMPLETE_BONUS_XP = 50;

// VALORANTの全ランク定義（絵文字なし・ランク無し〜レディアント全10種）
const VALORANT_RANKS = [
    { label: 'ランク無し', value: 'ランク無し' },
    { label: 'アイアン', value: 'アイアン' },
    { label: 'ブロンズ', value: 'ブロンズ' },
    { label: 'シルバー', value: 'シルバー' },
    { label: 'ゴールド', value: 'ゴールド' },
    { label: 'プラチナ', value: 'プラチナ' },
    { label: 'ダイヤモンド', value: 'ダイヤモンド' },
    { label: 'アセンダント', value: 'アセンダント' },
    { label: 'イモータル', value: 'イモータル' },
    { label: 'レディアント', value: 'レディアント' },
];

/**
 * 指定ユーザーが現在「募集中（OPEN）」のパネルを持っているか検索するヘルパー関数
 * 理由: 1人のユーザーが同時に複数の募集を立ててチャット欄を埋めたり、参加承認が混乱するのを防ぐため
 */
function findOpenRecruitmentByHost(userId) {
    for (const [messageId, recruit] of activeRecruitments.entries()) {
        if (recruit.hostId === userId && recruit.status === 'OPEN') {
            return { messageId, recruit };
        }
    }
    return null;
}

/**
 * 募集のタイマー（30分後の再募集確認 ＆ 1時間後の自動〆切）をセット／リセットする関数
 * 理由: 新規投稿時だけでなく、「再募集」や「メンバー承認」など更新があった際にも
 *       そこから改めて1時間カウントし直すことで、やり取り中の募集が勝手に閉じるのを防ぐため
 */
function startRecruitTimers(client, messageId) {
    const recruit = activeRecruitments.get(messageId);
    if (!recruit || recruit.status === 'CLOSED') return;

    // すでに動いているタイマーがあれば一旦解除してリセットする
    if (recruit.remindTimeoutId) {
        clearTimeout(recruit.remindTimeoutId);
        recruit.remindTimeoutId = null;
    }
    if (recruit.autoCloseTimeoutId) {
        clearTimeout(recruit.autoCloseTimeoutId);
        recruit.autoCloseTimeoutId = null;
    }

    // --- ① 30分後の再募集確認タイマー ---
    recruit.remindTimeoutId = setTimeout(async () => {
        const currentRecruit = activeRecruitments.get(messageId);
        if (!currentRecruit || currentRecruit.status === 'CLOSED') return;

        const renewRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`recruit_renew_${messageId}`)
                .setLabel('再募集する（チャンネルに再投稿）')
                .setStyle(ButtonStyle.Primary)
                .setEmoji('🔄'),
            new ButtonBuilder()
                .setCustomId(`recruit_timeout_close_${messageId}`)
                .setLabel('募集を〆る')
                .setStyle(ButtonStyle.Danger)
                .setEmoji('🔒')
        );

        const remaining = currentRecruit.maxSlots - currentRecruit.members.length;
        const noticeEmbed = new EmbedBuilder()
            .setColor(0xFFA500)
            .setTitle('⏰ 募集開始（または最終更新）から30分が経過しました')
            .setDescription(
                `現在の募集（**${currentRecruit.mode}** / あと**@${remaining}人**）はまだ募集中です。\n` +
                `このままチャンネルの最新位置に再投稿して募集を続けますか？\n` +
                `※このまま更新がない場合、**あと30分（計1時間）で自動的に募集が締め切られます。**`
            )
            .setTimestamp();

        // DM拒否時のクラッシュを防ぐため try-catch で捕捉し、失敗時はチャンネル側へフォールバック通知する
        try {
            const hostUser = await client.users.fetch(currentRecruit.hostId);
            await hostUser.send({ embeds: [noticeEmbed], components: [renewRow] });
        } catch (dmError) {
            console.warn(`30分経過通知のDM送信失敗(${currentRecruit.hostId})のためチャンネルへフォールバックします:`, dmError.message);
            try {
                const guild = await client.guilds.fetch(currentRecruit.guildId);
                const channel = await guild.channels.fetch(currentRecruit.channelId);
                await channel.send({
                    content: `⏰ <@${currentRecruit.hostId}> さん、募集から30分が経過しました！（※DM設定がオフのためこちらに通知しています）`,
                    embeds: [noticeEmbed],
                    components: [renewRow]
                });
            } catch (chError) {
                console.error('チャンネルへのフォールバック通知にも失敗しました:', chError.message);
            }
        }
    }, RECRUIT_REMIND_MS);

    // --- ② 1時間（60分）更新なしでの自動クローズタイマー ---
    recruit.autoCloseTimeoutId = setTimeout(async () => {
        const currentRecruit = activeRecruitments.get(messageId);
        if (!currentRecruit || currentRecruit.status === 'CLOSED') return;

        console.log(`募集(${messageId})が1時間更新なしのため自動クローズを実行します。`);
        await finalizeRecruitment(client, messageId, null, '1時間更新がなかったため自動的に締め切りました');
    }, RECRUIT_AUTO_CLOSE_MS);
}

/**
 * 募集を締め切り、成立していればボーナスXPを付与する共通処理
 * @param {string|null} autoCloseReason 自動〆切の場合の理由文（手動・満員〆切時は null）
 */
async function finalizeRecruitment(client, messageId, notifyChannel = null, autoCloseReason = null) {
    const recruit = activeRecruitments.get(messageId);
    if (!recruit || recruit.status === 'CLOSED') return;

    recruit.status = 'CLOSED';

    // 動いているタイマーをすべて確実に停止する（メモリリークや二重実行の防止）
    if (recruit.remindTimeoutId) {
        clearTimeout(recruit.remindTimeoutId);
        recruit.remindTimeoutId = null;
    }
    if (recruit.autoCloseTimeoutId) {
        clearTimeout(recruit.autoCloseTimeoutId);
        recruit.autoCloseTimeoutId = null;
    }

    const guild = await client.guilds.fetch(recruit.guildId);
    const channel = notifyChannel || await guild.channels.fetch(recruit.channelId);

    try {
        const recruitMessage = await channel.messages.fetch(messageId);
        await recruitMessage.edit({
            embeds: [buildRecruitEmbed(recruit)],
            components: [buildRecruitButtons(true)]
        });
    } catch (err) {
        console.warn('募集パネルの〆切更新に失敗:', err.message);
    }

    if (autoCloseReason) {
        await channel.send(
            `⏰ <@${recruit.hostId}> さんの募集（**${recruit.mode}**）は、**${autoCloseReason}**。`
        ).catch(() => {});
    }

    if (recruit.members.length >= 1) {
        const participantIds = [recruit.hostId, ...recruit.members];

        for (const uid of participantIds) {
            try {
                const member = await guild.members.fetch(uid);
                await addXpAndCheckLevelUp(member, RECRUIT_COMPLETE_BONUS_XP, channel, 0);
            } catch (err) {
                console.error(`ボーナスXP付与エラー (${uid}):`, err.message);
            }
        }

        await channel.send(
            `🎊 **パーティー募集が成立しました！**\n` +
            `参加メンバー（<@${participantIds.join('>, <@')}>）に募集成立ボーナス **+${RECRUIT_COMPLETE_BONUS_XP}XP** を付与しました！`
        );
    }
}

/**
 * 選択中のドラフト状態から、セレクトメニュー4つ＋ボタンの画面を生成する
 */
function buildSetupComponents(draft) {
    const isComplete = Boolean(draft.mode && draft.slots && draft.myRank && draft.targetRanks.length > 0);
    const isOther = draft.mode === 'OTHER';

    const modeMenu = new StringSelectMenuBuilder()
        .setCustomId('recruit_menu_mode')
        .setPlaceholder(draft.mode ? `モード: ${isOther ? 'その他' : draft.mode}` : '1. 募集するモードを選択')
        .addOptions([
            { label: 'コンペティティブ', value: 'コンペティティブ', default: draft.mode === 'コンペティティブ' },
            { label: 'アンレート', value: 'アンレート', default: draft.mode === 'アンレート' },
            { label: 'スイフトプレイ', value: 'スイフトプレイ', default: draft.mode === 'スイフトプレイ' },
            { label: 'カスタムマッチ', value: 'カスタムマッチ', default: draft.mode === 'カスタムマッチ' },
            { label: 'その他（次画面で自由入力）', value: 'OTHER', default: isOther },
        ]);

    const slotsMenu = new StringSelectMenuBuilder()
        .setCustomId('recruit_menu_slots')
        .setPlaceholder(draft.slots ? `募集人数: @${draft.slots}` : '2. 何人募集するか選択')
        .addOptions([
            { label: '@1（デュオ）', value: '1', default: draft.slots === 1 },
            { label: '@2（トリオ）', value: '2', default: draft.slots === 2 },
            { label: '@3（あと3人）', value: '3', default: draft.slots === 3 },
            { label: '@4（フルパ募集）', value: '4', default: draft.slots === 4 },
        ]);

    const myRankMenu = new StringSelectMenuBuilder()
        .setCustomId('recruit_menu_myrank')
        .setPlaceholder(draft.myRank ? `自分のランク: ${draft.myRank}` : '3. 自分のランクを選択')
        .addOptions(
            VALORANT_RANKS.map(r => ({
                label: r.label,
                value: r.value,
                default: draft.myRank === r.value
            }))
        );

    const targetRankMenu = new StringSelectMenuBuilder()
        .setCustomId('recruit_menu_targetrank')
        .setPlaceholder(draft.targetRanks.length > 0 ? `募集ランク帯: ${draft.targetRanks.length}個選択中` : '4. 募集するランク帯（複数選択可）')
        .setMinValues(1)
        .setMaxValues(VALORANT_RANKS.length)
        .addOptions(
            VALORANT_RANKS.map(r => ({
                label: r.label,
                value: r.value,
                default: draft.targetRanks.includes(r.value)
            }))
        );

    const buttonRow = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('recruit_btn_open_modal')
            .setLabel(isOther ? 'モード名と一言を入力して投稿' : '一言を入力して投稿')
            .setStyle(ButtonStyle.Primary)
            .setDisabled(!isComplete),
        new ButtonBuilder()
            .setCustomId('recruit_btn_quick_post')
            .setLabel('一言なしで即投稿')
            .setStyle(ButtonStyle.Success)
            .setDisabled(!isComplete || isOther)
    );

    const summary = [
        '**VALORANT パーティー募集作成**',
        `・モード: **${isOther ? 'その他（次画面で入力）' : (draft.mode || '未選択')}**`,
        `・募集人数: **${draft.slots ? `@${draft.slots}` : '未選択'}**`,
        `・自分のランク: **${draft.myRank || '未選択'}**`,
        `・募集ランク帯: **${draft.targetRanks.length > 0 ? draft.targetRanks.join(' / ') : '未選択'}**`,
    ].join('\n');

    return {
        content: summary,
        components: [
            new ActionRowBuilder().addComponents(modeMenu),
            new ActionRowBuilder().addComponents(slotsMenu),
            new ActionRowBuilder().addComponents(myRankMenu),
            new ActionRowBuilder().addComponents(targetRankMenu),
            buttonRow
        ]
    };
}

/**
 * 1. /recruit コマンド実行時
 */
async function handleRecruitCommand(interaction) {
    // すでに自分が募集中（OPEN）のパネルを持っていないかチェックする
    const existing = findOpenRecruitmentByHost(interaction.user.id);
    if (existing) {
        const jumpUrl = `https://discord.com/channels/${existing.recruit.guildId}/${existing.recruit.channelId}/${existing.messageId}`;
        return interaction.reply({
            content:
                `⚠️ **すでに募集中のパネルが存在します！**\n` +
                `新しい募集を立てる前に、現在の募集パネル（**${existing.recruit.mode}**）の「🔒 募集を〆る」ボタンを押して終了してください。\n` +
                `👉 現在の募集パネルへ移動: ${jumpUrl}`,
            ephemeral: true
        });
    }

    const draft = { mode: null, slots: null, myRank: null, targetRanks: [] };
    recruitDrafts.set(interaction.user.id, draft);

    await interaction.reply({
        ...buildSetupComponents(draft),
        ephemeral: true
    });
}

/**
 * 2. セレクトメニュー選択時
 */
async function handleRecruitSelectMenu(interaction) {
    const draft = recruitDrafts.get(interaction.user.id);
    if (!draft) {
        return interaction.reply({ content: '⚠️ セッションが切れました。もう一度 `/recruit` を実行してください。', ephemeral: true });
    }

    if (interaction.customId === 'recruit_menu_mode') draft.mode = interaction.values[0];
    if (interaction.customId === 'recruit_menu_slots') draft.slots = Number(interaction.values[0]);
    if (interaction.customId === 'recruit_menu_myrank') draft.myRank = interaction.values[0];
    if (interaction.customId === 'recruit_menu_targetrank') draft.targetRanks = interaction.values;

    await interaction.update(buildSetupComponents(draft));
}

/**
 * 3. ボタン押下時（Modalを開く / 即投稿 / 参加リクエスト / 〆切 / 再募集 / 承認・却下）
 */
async function handleRecruitButton(interaction) {
    const { customId } = interaction;

    // --- A. テキスト入力Modalを開くボタン ---
    if (customId === 'recruit_btn_open_modal') {
        const draft = recruitDrafts.get(interaction.user.id);
        if (!draft) {
            return interaction.reply({ content: '⚠️ セッションが切れました。もう一度 `/recruit` を実行してください。', ephemeral: true });
        }

        const modal = new ModalBuilder()
            .setCustomId('recruit_text_modal')
            .setTitle('募集詳細の入力');

        if (draft.mode === 'OTHER') {
            const modeInput = new TextInputBuilder()
                .setCustomId('custom_mode_input')
                .setLabel('募集するモード名（必須）')
                .setStyle(TextInputStyle.Short)
                .setPlaceholder('例：チームデスマッチ / スパイクラッシュ')
                .setRequired(true)
                .setMaxLength(30);
            modal.addComponents(new ActionRowBuilder().addComponents(modeInput));
        }

        const commentInput = new TextInputBuilder()
            .setCustomId('comment_input')
            .setLabel('一言（空欄でもOK）')
            .setStyle(TextInputStyle.Short)
            .setPlaceholder('例：楽しくやりましょう！VCあり・聞き専OK')
            .setRequired(false)
            .setMaxLength(100);
        modal.addComponents(new ActionRowBuilder().addComponents(commentInput));

        await interaction.showModal(modal);
        return;
    }

    // --- B. 一言なしで即投稿ボタン ---
    if (customId === 'recruit_btn_quick_post') {
        const draft = recruitDrafts.get(interaction.user.id);
        if (!draft) {
            return interaction.reply({ content: '⚠️ セッションが切れました。もう一度 `/recruit` を実行してください。', ephemeral: true });
        }

        const existing = findOpenRecruitmentByHost(interaction.user.id);
        if (existing) {
            return interaction.reply({
                content: '⚠️ すでに募集中のパネルが存在するため投稿できません。先に現在の募集を〆てください。',
                ephemeral: true
            });
        }

        await interaction.deferUpdate();

        await publishRecruitment(interaction, draft.mode, draft, 'よろしくお願いします！');
        recruitDrafts.delete(interaction.user.id);

        await interaction.editReply({ content: '✅ 募集パネルを投稿しました！', components: [] });
        return;
    }

    // --- C. 募集パネルの「参加リクエスト」ボタン ---
    if (customId === 'recruit_join_request') {
        const recruit = activeRecruitments.get(interaction.message.id);
        if (!recruit || recruit.status === 'CLOSED') {
            return interaction.reply({ content: '⚠️ この募集はすでに終了しています。', ephemeral: true });
        }
        if (interaction.user.id === recruit.hostId) {
            return interaction.reply({ content: '⚠️ 自分自身の募集には参加リクエストを送れません。', ephemeral: true });
        }
        if (recruit.members.includes(interaction.user.id)) {
            return interaction.reply({ content: '✅ すでにこのパーティーへの参加が承認されています！', ephemeral: true });
        }
        if (recruit.pendingUsers.includes(interaction.user.id)) {
            return interaction.reply({ content: '⏳ すでに参加リクエストを送信済みです。募集主の応答をお待ちください。', ephemeral: true });
        }

        await interaction.deferReply({ ephemeral: true });
        recruit.pendingUsers.push(interaction.user.id);

        const approvalRow = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`recruit_approve_${interaction.message.id}_${interaction.user.id}`)
                .setLabel('承認する')
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`recruit_reject_${interaction.message.id}_${interaction.user.id}`)
                .setLabel('見送る（却下）')
                .setStyle(ButtonStyle.Secondary)
                .setEmoji('❌')
        );

        const dmEmbed = new EmbedBuilder()
            .setColor(0x00B0F4)
            .setTitle('📩 パーティーへの参加リクエストが届きました！')
            .setDescription(`**${interaction.member.displayName}** (<@${interaction.user.id}>) さんがあなたの募集（**${recruit.mode}**）への参加を希望しています。`)
            .setTimestamp();

        try {
            const hostUser = await interaction.client.users.fetch(recruit.hostId);
            await hostUser.send({ embeds: [dmEmbed], components: [approvalRow] });

            await interaction.editReply({
                content: '📨 募集主のDMに参加リクエストを送信しました！承認されるまで少々お待ちください。'
            });
        } catch (dmError) {
            console.warn(`募集主(${recruit.hostId})へのDM送信失敗のためチャンネルへフォールバック:`, dmError.message);
            await interaction.editReply({
                content: '📨 参加リクエストを受け付けました！（募集主のDM設定がオフのためチャンネル上に承認ボタンを表示します）'
            });
            await interaction.channel.send({
                content: `📩 <@${recruit.hostId}> さん、<@${interaction.user.id}> さんから参加リクエストが届いています：`,
                components: [approvalRow]
            });
        }
        return;
    }

    // --- D. 募集パネルの「募集を〆る」ボタン ---
    if (customId === 'recruit_close') {
        const recruit = activeRecruitments.get(interaction.message.id);
        if (!recruit) {
            return interaction.reply({ content: '⚠️ 募集データが見つかりません。', ephemeral: true });
        }
        if (interaction.user.id !== recruit.hostId) {
            return interaction.reply({ content: '⚠️ 「募集を〆る」ボタンは募集主本人のみ操作できます。', ephemeral: true });
        }
        if (recruit.status === 'CLOSED') {
            return interaction.reply({ content: 'ℹ️ この募集はすでに〆切済みです。', ephemeral: true });
        }

        await interaction.deferUpdate();
        await finalizeRecruitment(interaction.client, interaction.message.id, interaction.channel);
        return;
    }

    // --- E. 30分経過通知の「再募集する」ボタン ---
    if (customId.startsWith('recruit_renew_')) {
        const oldMessageId = customId.replace('recruit_renew_', '');
        const recruit = activeRecruitments.get(oldMessageId);

        if (!recruit || recruit.status === 'CLOSED') {
            return interaction.update({ content: '⚠️ この募集はすでに終了しているため再募集できません。', embeds: [], components: [] });
        }
        if (interaction.user.id !== recruit.hostId) {
            return interaction.reply({ content: '⚠️ この操作は募集主本人のみ実行できます。', ephemeral: true });
        }

        await interaction.deferUpdate();

        // 旧募集のタイマーを全停止し、CLOSEDにする
        if (recruit.remindTimeoutId) clearTimeout(recruit.remindTimeoutId);
        if (recruit.autoCloseTimeoutId) clearTimeout(recruit.autoCloseTimeoutId);
        recruit.status = 'CLOSED';

        const guild = await interaction.client.guilds.fetch(recruit.guildId);
        const channel = await guild.channels.fetch(recruit.channelId);

        try {
            const oldMsg = await channel.messages.fetch(oldMessageId);
            await oldMsg.edit({
                embeds: [buildRecruitEmbed(recruit)],
                components: [buildRecruitButtons(true)]
            });
        } catch (err) {
            console.warn('旧募集パネルの更新をスキップ:', err.message);
        }

        const newRecruitData = {
            ...recruit,
            status: 'OPEN',
            createdAt: Date.now(),
            remindTimeoutId: null,
            autoCloseTimeoutId: null
        };
        activeRecruitments.delete(oldMessageId);

        const targetRole = guild.roles.cache.find(r => RECRUIT_MENTION_ROLE_NAMES.includes(r.name));
        const mentionText = targetRole ? `${targetRole} ` : '';

        const newMsg = await channel.send({
            content: `${mentionText}🔄 **再募集！**`,
            embeds: [buildRecruitEmbed(newRecruitData)],
            components: [buildRecruitButtons(false)]
        });

        activeRecruitments.set(newMsg.id, newRecruitData);
        // 再投稿した時点から改めて30分確認＆1時間自動クローズタイマーをリセットして開始
        startRecruitTimers(interaction.client, newMsg.id);

        await interaction.editReply({
            content: '🔄 チャンネルに募集パネルを再投稿し、タイマー（30分確認・1時間自動〆切）をリセットしました！',
            embeds: [],
            components: []
        });
        return;
    }

    // --- F. 30分経過通知の「募集を〆る」ボタン ---
    if (customId.startsWith('recruit_timeout_close_')) {
        const messageId = customId.replace('recruit_timeout_close_', '');
        const recruit = activeRecruitments.get(messageId);

        if (!recruit || recruit.status === 'CLOSED') {
            return interaction.update({ content: 'ℹ️ この募集はすでに終了しています。', embeds: [], components: [] });
        }
        if (interaction.user.id !== recruit.hostId) {
            return interaction.reply({ content: '⚠️ この操作は募集主本人のみ実行できます。', ephemeral: true });
        }

        await interaction.deferUpdate();
        await finalizeRecruitment(interaction.client, messageId);
        await interaction.editReply({ content: '🔒 募集を締め切りました！', embeds: [], components: [] });
        return;
    }

    // --- G. 参加リクエストの「承認 / 却下」ボタン ---
    if (customId.startsWith('recruit_approve_') || customId.startsWith('recruit_reject_')) {
        const parts = customId.split('_');
        const action = parts[1];
        const messageId = parts[2];
        const applicantId = parts[3];

        const recruit = activeRecruitments.get(messageId);
        if (!recruit) {
            return interaction.update({ content: '⚠️ 対象の募集データはすでに終了または削除されています。', embeds: [], components: [] });
        }
        if (interaction.user.id !== recruit.hostId) {
            return interaction.reply({ content: '⚠️ この承認・却下ボタンは募集主本人のみ操作できます。', ephemeral: true });
        }

        await interaction.deferUpdate();
        recruit.pendingUsers = recruit.pendingUsers.filter(id => id !== applicantId);

        const guild = await interaction.client.guilds.fetch(recruit.guildId);
        const channel = await guild.channels.fetch(recruit.channelId);

        if (action === 'approve') {
            if (recruit.status === 'CLOSED' || recruit.members.length >= recruit.maxSlots) {
                return interaction.editReply({ content: '⚠️ すでに募集枠が埋まっているか、募集が締め切られています。', embeds: [], components: [] });
            }

            if (!recruit.members.includes(applicantId)) {
                recruit.members.push(applicantId);
            }

            try {
                const applicantUser = await interaction.client.users.fetch(applicantId);
                await applicantUser.send(`🎉 **参加が承認されました！**\n<@${recruit.hostId}> さんのパーティー（**${recruit.mode}**）への参加が確定しました。ボイスチャンネルへ合流してください！`);
            } catch (dmError) {
                console.warn(`申請者(${applicantId})へのDM送信失敗のためチャンネルへ通知:`, dmError.message);
                await channel.send(`🎉 <@${applicantId}> さん、<@${recruit.hostId}> さんのパーティー（**${recruit.mode}**）への参加が承認されました！（※DM設定がオフのためこちらに通知しています）`);
            }

            await interaction.editReply({ content: `✅ <@${applicantId}> さんの参加を**承認**しました！`, embeds: [], components: [] });

            if (recruit.members.length >= recruit.maxSlots) {
                await finalizeRecruitment(interaction.client, messageId, channel);
            } else {
                // 枠が更新されたので、自動クローズタイマーをリセットして延長する
                startRecruitTimers(interaction.client, messageId);

                const recruitMessage = await channel.messages.fetch(messageId);
                await recruitMessage.edit({
                    embeds: [buildRecruitEmbed(recruit)],
                    components: [buildRecruitButtons(false)]
                });
            }
        } else {
            try {
                const applicantUser = await interaction.client.users.fetch(applicantId);
                await applicantUser.send(`ℹ️ 今回応募した <@${recruit.hostId}> さんのパーティー募集（**${recruit.mode}**）は、枠の都合等により見送りとなりました。また別の募集でぜひご参加ください！`);
            } catch (dmError) {
                console.warn(`申請者(${applicantId})への却下DM送信失敗:`, dmError.message);
                await channel.send(`ℹ️ <@${applicantId}> さん、先ほどのパーティー募集は見送りとなりました（※DM設定がオフのためこちらに通知しています）。`);
            }

            await interaction.editReply({ content: `❌ <@${applicantId}> さんのリクエストを見送り（却下）として通知しました。`, embeds: [], components: [] });
        }
    }
}

/**
 * 4. テキスト入力Modalの送信時
 */
async function handleRecruitModalSubmit(interaction) {
    if (interaction.customId !== 'recruit_text_modal') return;

    const draft = recruitDrafts.get(interaction.user.id);
    if (!draft) {
        return interaction.reply({ content: '⚠️ セッションが切れました。もう一度 `/recruit` を実行してください。', ephemeral: true });
    }

    const existing = findOpenRecruitmentByHost(interaction.user.id);
    if (existing) {
        return interaction.reply({
            content: '⚠️ すでに募集中のパネルが存在するため投稿できません。先に現在の募集を〆てください。',
            ephemeral: true
        });
    }

    await interaction.deferReply({ ephemeral: true });

    const modeName = draft.mode === 'OTHER'
        ? interaction.fields.getTextInputValue('custom_mode_input').trim()
        : draft.mode;
    const comment = interaction.fields.getTextInputValue('comment_input')?.trim() || 'よろしくお願いします！';

    await publishRecruitment(interaction, modeName, draft, comment);
    recruitDrafts.delete(interaction.user.id);

    await interaction.editReply({ content: '✅ 募集パネルを投稿しました！' });
}

/**
 * 募集パネルのEmbed（テンプレート5項目＋枠一覧）を視認性重視で組み立てる関数
 */
function buildRecruitEmbed(data) {
    const remaining = Math.max(data.maxSlots - data.members.length, 0);
    const isClosed = data.status === 'CLOSED' || remaining <= 0;

    const templateLines = [
        `🎮 **モード：** \`${data.mode}\``,
        `👥 **募集人数：** \`@${data.maxSlots}人\`（残り **${remaining}** 枠）`,
        `🏅 **募集主ランク：** \`${data.myRank}\``,
        `🎯 **募集ランク帯：** \`${data.targetRank}\``,
        `💬 **ひとこと：**\n> ${data.comment}`
    ].join('\n');

    const slotLines = [
        `👑 **募集主：** <@${data.hostId}>`,
        `────────────────────`
    ];

    for (let i = 0; i < data.maxSlots; i++) {
        if (data.members[i]) {
            slotLines.push(`🟢 **枠 ${i + 1} ：** <@${data.members[i]}>`);
        } else if (isClosed) {
            slotLines.push(`⚫ **枠 ${i + 1} ：** *（〆切）*`);
        } else {
            slotLines.push(`⚪ **枠 ${i + 1} ：** *（募集中）*`);
        }
    }

    return new EmbedBuilder()
        .setColor(isClosed ? 0x4E5058 : 0xFF4655)
        .setTitle(
            isClosed
                ? `🔒 【募集〆切】${data.mode}（@${data.maxSlots}）`
                : `🔥 【募集中】${data.mode}（あと @${remaining}人）`
        )
        .setDescription(templateLines)
        .addFields({
            name: `📋 パーティーメンバー（${data.members.length + 1} / ${data.maxSlots + 1}人）`,
            value: slotLines.join('\n'),
            inline: false
        })
        .setFooter({
            text: isClosed
                ? 'この募集は締め切られました'
                : '「参加リクエスト」を押すと募集主に申請が送られます（1時間更新がないと自動〆切）'
        })
        .setTimestamp(data.createdAt);
}

function buildRecruitButtons(disabled = false) {
    return new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('recruit_join_request')
            .setLabel('参加リクエスト')
            .setStyle(ButtonStyle.Success)
            .setEmoji('🙋‍♂️')
            .setDisabled(disabled),
        new ButtonBuilder()
            .setCustomId('recruit_close')
            .setLabel('募集を〆る')
            .setStyle(ButtonStyle.Secondary)
            .setEmoji('🔒')
            .setDisabled(disabled)
    );
}

/**
 * 募集パネルをチャンネルに投稿する共通処理
 */
async function publishRecruitment(interaction, modeName, draft, comment) {
    const targetRankText = draft.targetRanks.length === VALORANT_RANKS.length
        ? '全ランク（ランク無し〜レディアント）'
        : draft.targetRanks.join(' / ');

    const recruitData = {
        hostId: interaction.user.id,
        guildId: interaction.guild.id,
        channelId: interaction.channel.id,
        mode: modeName,
        maxSlots: draft.slots,
        myRank: draft.myRank,
        targetRank: targetRankText,
        comment: comment,
        members: [],
        pendingUsers: [],
        status: 'OPEN',
        createdAt: Date.now(),
        remindTimeoutId: null,
        autoCloseTimeoutId: null
    };

    const mentionRole = interaction.guild.roles.cache.find(r => RECRUIT_MENTION_ROLE_NAMES.includes(r.name));
    const msg = await interaction.channel.send({
        content: mentionRole ? `${mentionRole}` : '@募集',
        embeds: [buildRecruitEmbed(recruitData)],
        components: [buildRecruitButtons(false)]
    });

    activeRecruitments.set(msg.id, recruitData);
    startRecruitTimers(interaction.client, msg.id);
}

module.exports = {
    activeRecruitments,
    finalizeRecruitment,
    handleRecruitCommand,
    handleRecruitSelectMenu,
    handleRecruitButton,
    handleRecruitModalSubmit
};
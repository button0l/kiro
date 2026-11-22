const express = require('express');
const { activeRecruitments } = require('../../recruit');
const {
    getRatingSummary,
    getRatingHistory,
    addRating,
    getOrCreateUser,
    hasPlayedTogether,
} = require('../../database');

const GUILD_ID = process.env.GUILD_ID;

// ログイン必須ミドルウェア
function requireAuth(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'ログインが必要です' });
    next();
}

module.exports = function apiRouter(client) {
    const router = express.Router();

    // 現在募集中のパーティー一覧
    router.get('/recruitments', requireAuth, async (req, res) => {
        const list = [];
        try {
            const guild = await client.guilds.fetch(GUILD_ID);

            for (const [messageId, recruit] of activeRecruitments.entries()) {
                if (recruit.status !== 'OPEN') continue;

                // ホストと参加メンバーの表示名を取得する
                const allIds = [recruit.hostId, ...recruit.members];
                const memberInfos = await Promise.all(allIds.map(async id => {
                    try {
                        const m = await guild.members.fetch(id);
                        return {
                            id,
                            displayName: m.displayName,
                            avatar: m.user.avatar
                                ? `https://cdn.discordapp.com/avatars/${id}/${m.user.avatar}.png`
                                : `https://cdn.discordapp.com/embed/avatars/0.png`
                        };
                    } catch {
                        return { id, displayName: id.slice(0, 8) + '...', avatar: `https://cdn.discordapp.com/embed/avatars/0.png` };
                    }
                }));

                list.push({
                    messageId,
                    hostId: recruit.hostId,
                    mode: recruit.mode,
                    maxSlots: recruit.maxSlots,
                    filledSlots: recruit.members.length,
                    myRank: recruit.myRank,
                    targetRank: recruit.targetRank,
                    comment: recruit.comment,
                    createdAt: recruit.createdAt,
                    members: recruit.members,
                    memberInfos,
                });
            }
        } catch (e) {
            console.error('募集一覧取得エラー:', e.message);
        }
        res.json(list);
    });

    // ユーザーのプロフィール（評価サマリー＋レベル情報＋Discord表示名）
    router.get('/profile/:userId', requireAuth, async (req, res) => {
        const { userId } = req.params;
        const summary = getRatingSummary(userId, GUILD_ID);
        const history = getRatingHistory(userId, GUILD_ID, 20);
        const userData = getOrCreateUser(userId, GUILD_ID);

        // BotのClientからDiscordのユーザー情報を取得する
        let displayName = null;
        let avatar = null;
        try {
            const guild = await client.guilds.fetch(GUILD_ID);
            const member = await guild.members.fetch(userId);
            displayName = member.displayName;
            avatar = member.user.avatar
                ? `https://cdn.discordapp.com/avatars/${userId}/${member.user.avatar}.png`
                : `https://cdn.discordapp.com/embed/avatars/0.png`;
        } catch (e) {
            displayName = `ユーザーID: ${userId.slice(0, 8)}...`;
            avatar = `https://cdn.discordapp.com/embed/avatars/0.png`;
        }

        res.json({
            userId,
            displayName,
            avatar,
            level: userData.level,
            xp: userData.xp,
            vcMinutes: userData.vc_minutes,
            ratings: {
                total: summary.total || 0,
                average: summary.average || 0,
                positive: summary.positive || 0,
                negative: summary.negative || 0,
            },
            history,
        });
    });

    // 評価を送信する
    router.post('/rate', requireAuth, (req, res) => {
        const fromUserId = req.session.user.id;
        const { toUserId, score, comment } = req.body;

        if (!toUserId || !score) {
            return res.status(400).json({ error: 'パラメータが不足しています' });
        }
        if (fromUserId === toUserId) {
            return res.status(400).json({ error: '自分自身は評価できません' });
        }
        const scoreNum = parseInt(score);
        if (scoreNum < 1 || scoreNum > 5) {
            return res.status(400).json({ error: 'スコアは1〜5で指定してください' });
        }

        // 同じ募集に参加したことがある相手のみ評価可能
        if (!hasPlayedTogether(fromUserId, toUserId, GUILD_ID)) {
            return res.status(403).json({ error: '同じ募集に参加したことがある相手のみ評価できます' });
        }

        const result = addRating(fromUserId, toUserId, GUILD_ID, scoreNum, comment || null);
        if (!result.success) {
            return res.status(429).json({ error: '24時間以内にすでに評価済みです' });
        }

        res.json({ success: true });
    });

    // 自分のセッション情報を返す
    router.get('/me', requireAuth, (req, res) => {
        res.json(req.session.user);
    });

    return router;
};

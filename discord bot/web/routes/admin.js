const express = require('express');
const router = express.Router();
const {
    getFlaggedUsers,
    addAdminFlag,
    getAdminFlags,
    removeAdminFlag,
} = require('../../database');

const GUILD_ID = process.env.GUILD_ID;
const ADMIN_ROLE_IDS = (process.env.ADMIN_ROLE_IDS || '').split(',').filter(Boolean);

// 管理者チェックミドルウェア
function requireAdmin(req, res, next) {
    if (!req.session.user) return res.status(401).json({ error: 'ログインが必要です' });

    const userRoles = req.session.user.roles || [];
    const isAdmin = ADMIN_ROLE_IDS.some(roleId => userRoles.includes(roleId));
    if (!isAdmin) return res.status(403).json({ error: '管理者権限が必要です' });

    next();
}

// 低評価ユーザー一覧
router.get('/flagged-users', requireAdmin, (req, res) => {
    const threshold = parseInt(req.query.threshold) || 3;
    const users = getFlaggedUsers(GUILD_ID, threshold);
    res.json(users);
});

// 管理者フラグの一覧
router.get('/flags', requireAdmin, (req, res) => {
    const flags = getAdminFlags(GUILD_ID);
    res.json(flags);
});

// 管理者フラグを追加
router.post('/flags', requireAdmin, (req, res) => {
    const { userId, reason } = req.body;
    if (!userId || !reason) return res.status(400).json({ error: 'パラメータが不足しています' });

    addAdminFlag(userId, GUILD_ID, reason, req.session.user.id);
    res.json({ success: true });
});

// 管理者フラグを削除
router.delete('/flags/:id', requireAdmin, (req, res) => {
    removeAdminFlag(req.params.id);
    res.json({ success: true });
});

module.exports = router;

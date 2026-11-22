const Database = require('better-sqlite3');
const path = require('path');

// SQLiteデータベースファイルを開く（存在しない場合は自動で作成される）
const db = new Database(path.join(__dirname, 'database.sqlite'));

// WAL（Write-Ahead Logging）モードを有効化
// 理由: 読み書きの競合を減らし、無料のクラウドサーバー（Oracle Cloud Always Free等）でも軽量かつ安全に動かすため
db.pragma('journal_mode = WAL');

// ユーザーごとのXP・レベル・VC滞在時間を管理するテーブルを作成
db.exec(`
    CREATE TABLE IF NOT EXISTS users (
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        xp INTEGER NOT NULL DEFAULT 0,
        level INTEGER NOT NULL DEFAULT 1,
        vc_minutes INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (user_id, guild_id)
    )
`);

/**
 * ユーザーデータを取得する（未登録の場合は Lv.1 / 0XP で自動作成して返す）
 * 理由: まだチャットやVCをしていないメンバーを検索・リセットした際にも、データが undefined になって落ちるのを防ぐため
 */
function getOrCreateUser(userId, guildId) {
    const selectStmt = db.prepare('SELECT * FROM users WHERE user_id = ? AND guild_id = ?');
    let user = selectStmt.get(userId, guildId);

    if (!user) {
        const insertStmt = db.prepare(`
            INSERT INTO users (user_id, guild_id, xp, level, vc_minutes)
            VALUES (?, ?, 0, 1, 0)
        `);
        insertStmt.run(userId, guildId);
        user = selectStmt.get(userId, guildId);
    }

    return user;
}

/**
 * ユーザーのXP・レベル・VC滞在時間を更新する
 */
function updateUserProgress(userId, guildId, newXp, newLevel, addedVcMinutes = 0) {
    getOrCreateUser(userId, guildId);

    const updateStmt = db.prepare(`
        UPDATE users
        SET xp = ?, level = ?, vc_minutes = vc_minutes + ?
        WHERE user_id = ? AND guild_id = ?
    `);
    return updateStmt.run(newXp, newLevel, addedVcMinutes, userId, guildId);
}

/**
 * 指定サーバーのXP上位メンバーを取得する（デフォルトTOP20）
 * 理由: 全員分をJavaScriptに読み込んで並び替えるより、SQLite側で ORDER BY / LIMIT を使った方がメモリ節約になるため
 */
function getTopUsers(guildId, limit = 20) {
    const stmt = db.prepare(`
        SELECT user_id, guild_id, xp, level, vc_minutes
        FROM users
        WHERE guild_id = ? AND xp > 0
        ORDER BY xp DESC, level DESC
        LIMIT ?
    `);
    return stmt.all(guildId, limit);
}

/**
 * 対象1名のレベルとXPを初期状態（Lv.1 / 0XP）にリセットする
 */
function resetUserLevel(userId, guildId) {
    getOrCreateUser(userId, guildId);

    // 累計VC滞在時間(vc_minutes)は記録として残し、レベルとXPのみ初期化する
    const stmt = db.prepare(`
        UPDATE users
        SET xp = 0, level = 1
        WHERE user_id = ? AND guild_id = ?
    `);
    return stmt.run(userId, guildId);
}

/**
 * 指定サーバー内「全員」のレベルとXPを初期状態（Lv.1 / 0XP）に一括リセットする
 * 理由: シーズン切り替えやイベント終了時に、全メンバーのレベルをまとめて初期化する運用に対応するため
 */
function resetAllLevels(guildId) {
    const stmt = db.prepare(`
        UPDATE users
        SET xp = 0, level = 1
        WHERE guild_id = ?
    `);
    return stmt.run(guildId);
}

// 評価テーブル
db.exec(`
    CREATE TABLE IF NOT EXISTS ratings (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        from_user_id TEXT NOT NULL,
        to_user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        score INTEGER NOT NULL CHECK(score BETWEEN 1 AND 5),
        comment TEXT,
        created_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
`);

// 既存テーブルに score カラムがない場合は追加してマイグレーションする
try {
    db.exec(`ALTER TABLE ratings ADD COLUMN score INTEGER NOT NULL DEFAULT 3`);
    // is_positive が残っている場合は score に変換する（1=高評価→5, 0=低評価→1）
    db.exec(`UPDATE ratings SET score = CASE WHEN is_positive = 1 THEN 5 ELSE 1 END WHERE score = 3`);
} catch (e) {
    // カラムがすでに存在する場合は無視する
}

// 管理者フラグテーブル
db.exec(`
    CREATE TABLE IF NOT EXISTS admin_flags (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        reason TEXT,
        flagged_by TEXT NOT NULL,
        flagged_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
`);

// 同じ募集に参加したペアを記録するテーブル（評価資格チェックに使用）
db.exec(`
    CREATE TABLE IF NOT EXISTS party_history (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id_a TEXT NOT NULL,
        user_id_b TEXT NOT NULL,
        guild_id TEXT NOT NULL,
        played_at INTEGER NOT NULL DEFAULT (strftime('%s', 'now'))
    )
`);

/**
 * 募集が成立した際にパーティー全員のペアを記録する
 */
function recordPartyHistory(memberIds, guildId) {
    const stmt = db.prepare(`
        INSERT INTO party_history (user_id_a, user_id_b, guild_id)
        VALUES (?, ?, ?)
    `);
    for (let i = 0; i < memberIds.length; i++) {
        for (let j = i + 1; j < memberIds.length; j++) {
            stmt.run(memberIds[i], memberIds[j], guildId);
        }
    }
}

/**
 * 2人が同じ募集に参加したことがあるか確認する
 */
function hasPlayedTogether(userIdA, userIdB, guildId) {
    const row = db.prepare(`
        SELECT id FROM party_history
        WHERE guild_id = ?
        AND ((user_id_a = ? AND user_id_b = ?) OR (user_id_a = ? AND user_id_b = ?))
        LIMIT 1
    `).get(guildId, userIdA, userIdB, userIdB, userIdA);
    return Boolean(row);
}

/**
 * 評価を追加する（1ペアにつき1日1回まで）
 */
function addRating(fromUserId, toUserId, guildId, score, comment = null) {
    if (score < 1 || score > 5) return { success: false, reason: 'invalid_score' };

    // 同じペアで24時間以内に評価済みかチェック
    const existing = db.prepare(`
        SELECT id FROM ratings
        WHERE from_user_id = ? AND to_user_id = ? AND guild_id = ?
        AND created_at > strftime('%s', 'now') - 86400
    `).get(fromUserId, toUserId, guildId);

    if (existing) return { success: false, reason: 'cooldown' };

    db.prepare(`
        INSERT INTO ratings (from_user_id, to_user_id, guild_id, score, comment)
        VALUES (?, ?, ?, ?, ?)
    `).run(fromUserId, toUserId, guildId, score, comment);

    return { success: true };
}

/**
 * ユーザーの評価サマリーを取得する
 */
function getRatingSummary(userId, guildId) {
    return db.prepare(`
        SELECT
            COUNT(*) as total,
            ROUND(AVG(score), 1) as average,
            SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) as negative
        FROM ratings
        WHERE to_user_id = ? AND guild_id = ?
    `).get(userId, guildId);
}

/**
 * ユーザーが受けた評価の履歴を取得する
 */
function getRatingHistory(userId, guildId, limit = 20) {
    return db.prepare(`
        SELECT from_user_id, score, comment, created_at
        FROM ratings
        WHERE to_user_id = ? AND guild_id = ?
        ORDER BY created_at DESC
        LIMIT ?
    `).all(userId, guildId, limit);
}

/**
 * 低評価が多いユーザーの一覧を取得する（管理者用・平均スコア2.5以下）
 */
function getFlaggedUsers(guildId, threshold = 3) {
    return db.prepare(`
        SELECT
            to_user_id as user_id,
            COUNT(*) as total,
            ROUND(AVG(score), 1) as average,
            SUM(CASE WHEN score >= 4 THEN 1 ELSE 0 END) as positive,
            SUM(CASE WHEN score <= 2 THEN 1 ELSE 0 END) as negative
        FROM ratings
        WHERE guild_id = ?
        GROUP BY to_user_id
        HAVING negative >= ?
        ORDER BY average ASC
    `).all(guildId, threshold);
}

/**
 * 管理者フラグを追加する
 */
function addAdminFlag(userId, guildId, reason, flaggedBy) {
    db.prepare(`
        INSERT INTO admin_flags (user_id, guild_id, reason, flagged_by)
        VALUES (?, ?, ?, ?)
    `).run(userId, guildId, reason, flaggedBy);
}

/**
 * 管理者フラグの一覧を取得する
 */
function getAdminFlags(guildId) {
    return db.prepare(`
        SELECT * FROM admin_flags
        WHERE guild_id = ?
        ORDER BY flagged_at DESC
    `).all(guildId);
}

/**
 * 管理者フラグを削除する
 */
function removeAdminFlag(id) {
    db.prepare('DELETE FROM admin_flags WHERE id = ?').run(id);
}

module.exports = {
    getOrCreateUser,
    updateUserProgress,
    getTopUsers,
    resetUserLevel,
    resetAllLevels,
    addRating,
    getRatingSummary,
    getRatingHistory,
    getFlaggedUsers,
    addAdminFlag,
    getAdminFlags,
    removeAdminFlag,
    recordPartyHistory,
    hasPlayedTogether,
};
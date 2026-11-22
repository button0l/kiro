const express = require('express');
const router = express.Router();

const DISCORD_CLIENT_ID = process.env.CLIENT_ID;
const DISCORD_CLIENT_SECRET = process.env.DISCORD_CLIENT_SECRET;
const REDIRECT_URI = 'http://161.33.42.156:3000/auth/callback';
const GUILD_ID = process.env.GUILD_ID;

// Discord OAuth2 ログインページへリダイレクト
router.get('/login', (req, res) => {
    const params = new URLSearchParams({
        client_id: DISCORD_CLIENT_ID,
        redirect_uri: REDIRECT_URI,
        response_type: 'code',
        scope: 'identify guilds.members.read',
    });
    res.redirect(`https://discord.com/oauth2/authorize?${params}`);
});

// Discord からのコールバック
router.get('/callback', async (req, res) => {
    const { code } = req.query;
    if (!code) return res.redirect('/?error=no_code');

    try {
        // アクセストークンを取得
        const tokenRes = await fetch('https://discord.com/api/oauth2/token', {
            method: 'POST',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
            body: new URLSearchParams({
                client_id: DISCORD_CLIENT_ID,
                client_secret: DISCORD_CLIENT_SECRET,
                grant_type: 'authorization_code',
                code,
                redirect_uri: REDIRECT_URI,
            }),
        });

        const tokenData = await tokenRes.json();
        if (!tokenData.access_token) return res.redirect('/?error=token_failed');

        // ユーザー情報を取得
        const userRes = await fetch('https://discord.com/api/users/@me', {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });
        const user = await userRes.json();

        // サーバーメンバーか確認
        const memberRes = await fetch(`https://discord.com/api/users/@me/guilds/${GUILD_ID}/member`, {
            headers: { Authorization: `Bearer ${tokenData.access_token}` },
        });

        if (!memberRes.ok) {
            return res.redirect('/?error=not_member');
        }

        const member = await memberRes.json();

        // セッションに保存
        req.session.user = {
            id: user.id,
            username: user.username,
            discriminator: user.discriminator,
            avatar: user.avatar,
            displayName: member.nick || user.global_name || user.username,
            roles: member.roles || [],
        };

        res.redirect('/dashboard');
    } catch (err) {
        console.error('OAuth2エラー:', err);
        res.redirect('/?error=server_error');
    }
});

// ログアウト
router.get('/logout', (req, res) => {
    req.session.destroy();
    res.redirect('/');
});

// セッション情報を返す API
router.get('/me', (req, res) => {
    if (!req.session.user) return res.json({ loggedIn: false });
    res.json({ loggedIn: true, user: req.session.user });
});

module.exports = router;

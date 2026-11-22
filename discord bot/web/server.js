require('dotenv').config({ path: require('path').join(__dirname, '../.env') });
const express = require('express');
const session = require('express-session');
const path = require('path');
const authRouter = require('./routes/auth');
const apiRouter = require('./routes/api');
const adminRouter = require('./routes/admin');

const PORT = process.env.WEB_PORT || 3000;

module.exports = function startWebServer(client) {
    const app = express();

    app.use(express.json());
    app.use(express.urlencoded({ extended: true }));
    app.use(express.static(path.join(__dirname, 'public')));

    app.use(session({
        secret: process.env.SESSION_SECRET || 'changeme',
        resave: false,
        saveUninitialized: false,
        cookie: { maxAge: 7 * 24 * 60 * 60 * 1000 }
    }));

    app.use('/auth', authRouter);
    app.use('/api', apiRouter(client));
    app.use('/admin', adminRouter);

    app.get('/dashboard', (req, res) => res.sendFile(path.join(__dirname, 'public/dashboard.html')));
    app.get('/profile', (req, res) => res.sendFile(path.join(__dirname, 'public/profile.html')));
    app.get('/rate', (req, res) => res.sendFile(path.join(__dirname, 'public/rate.html')));
    app.get('/admin-panel', (req, res) => res.sendFile(path.join(__dirname, 'public/admin.html')));

    app.listen(PORT, () => {
        console.log(`Webサーバー起動: http://161.33.42.156:${PORT}`);
    });
};

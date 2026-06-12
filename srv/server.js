const cds = require('@sap/cds');
const cors = require('cors');

const corsOptions = {
    origin: (origin, callback) => {
        // Allow no-origin requests (Postman, curl) and any localhost
        if (!origin || origin.includes('localhost') || origin.includes('127.0.0.1')) {
            callback(null, true);
        } else {
            callback(null, true); // In dev, allow all — restrict in production
        }
    },
    methods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    allowedHeaders: [
        'Origin',
        'X-Requested-With',
        'Content-Type',
        'Accept',
        'Authorization',
        'x-csrf-token',
        'X-CSRF-Token'
    ],
    credentials: true,
    optionsSuccessStatus: 204
};

// ✅ Use 'bootstrap' — fires BEFORE auth middleware is registered
cds.on('bootstrap', (app) => {
    // Handle preflight first — before ANY other middleware including auth
    app.options('*', (req, res) => {
        res.header('Access-Control-Allow-Origin', req.headers.origin || '*');
        res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        res.header('Access-Control-Allow-Headers', 'Origin, X-Requested-With, Content-Type, Accept, Authorization, x-csrf-token, X-CSRF-Token');
        res.header('Access-Control-Allow-Credentials', 'true');
        return res.sendStatus(204);
    });

    // Apply CORS to all other routes
    app.use(cors(corsOptions));
});

module.exports = cds.server;
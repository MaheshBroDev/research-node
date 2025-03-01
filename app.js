const express = require('express');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const { createObjectCsvWriter } = require('csv-writer');
const bodyParser = require('body-parser');

const app = express();
app.use(bodyParser.json());

const PORT = 8081;

// MySQL Database Connection
const db = mysql.createConnection({
    host: process.env.DB_HOST || 'localhost',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASS || '',
    port: process.env.DB_PORT || 3306,
    database: process.env.DB_NAME || 'research_node'
});

db.connect(err => {
    if (err) {
        console.error('Database connection failed:', err);
        process.exit(1);
    }
    console.log('Connected to MySQL');
});

// Performance Metrics Logger
const logPerformanceMetrics = (endpoint, startTime) => {
    const elapsed = process.hrtime(startTime);
    const elapsedTimeMs = (elapsed[0] * 1000 + elapsed[1] / 1e6).toFixed(2);
    const memoryUsage = process.memoryUsage();
    const csvWriter = createObjectCsvWriter({
        path: 'performance_metrics_node.csv',
        append: true,
        header: [
            { id: 'timestamp', title: 'Timestamp' },
            { id: 'endpoint', title: 'Endpoint' },
            { id: 'rss', title: 'Resident Set Size (bytes)' },
            { id: 'heapTotal', title: 'Heap Total (bytes)' },
            { id: 'heapUsed', title: 'Heap Used (bytes)' },
            { id: 'elapsedTime', title: 'Elapsed Time (ms)' },
            { id: 'cpuUsage', title: 'CPU Usage (%)' },
            { id: 'memoryUsage', title: 'Memory Usage (MB)' }
        ]
    });

    const record = {
        timestamp: new Date().toISOString(),
        endpoint: endpoint,
        rss: memoryUsage.rss,
        heapTotal: memoryUsage.heapTotal,
        heapUsed: memoryUsage.heapUsed,
        elapsedTime: elapsedTimeMs,
        cpuUsage: (os.loadavg()[0] * 100).toFixed(2),
        memoryUsage: (memoryUsage.heapUsed / 1024 / 1024).toFixed(2)
    };

    csvWriter.writeRecords([record]).catch(err => console.error('Error writing to CSV:', err));
};

// Middleware for performance logging
const performanceLoggingMiddleware = (endpoint) => (req, res, next) => {
    const startTime = process.hrtime();
    res.on('finish', () => logPerformanceMetrics(endpoint, startTime));
    next();
};

// Authentication Middleware
const authMiddleware = (req, res, next) => {
    const authHeader = req.headers['authorization'];
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ error: 'Unauthorized' });
    }

    const token = authHeader.substring(7);
    db.query('SELECT username FROM users WHERE token = ?', [token], (err, results) => {
        if (err) {
            return res.status(500).json({ error: 'Database error' ,err});
        }
        if (results.length === 0) {
            return res.status(401).json({ error: 'Unauthorized' });
        }
        req.user = results[0].username;
        next();
    });
};

// Login Endpoint
app.post('/login', performanceLoggingMiddleware('/login'), (req, res) => {
    const { username, password } = req.body;
    db.query('SELECT token FROM users WHERE username = ? AND password = ?', [username, password], (err, results) => {
        if (err || results.length === 0) {
            return res.status(401).json({ error: 'Invalid credentials' });
        }
        res.json({ token: results[0].token });
    });
});

// Get Items (Authenticated)
app.get('/items', authMiddleware, performanceLoggingMiddleware('/items'), (req, res) => {
    db.query('SELECT id, name, value FROM items', (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        res.json(results);
    });
});

// Get Item by ID (Authenticated)
app.get('/item', authMiddleware, performanceLoggingMiddleware('/item'), (req, res) => {
    const { id } = req.query || null;
    if (!id) return res.status(400).json({ error: 'Missing ID parameter' });
    if (isNaN(id)) return res.status(400).json({ error: 'ID must be a number' });
    db.query('SELECT id, name, value FROM items WHERE id = ?', [id], (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (results.length === 0) return res.status(404).json({ error: 'Item not found' });
        res.json(results[0]);
    });
});

// Get Last item (Authenticated)
app.get('/item/last', authMiddleware, performanceLoggingMiddleware('/item/last'), (req, res) => {
    db.query('SELECT id, name, value FROM items ORDER BY id DESC LIMIT 1', (err, results) => {
        if (err) return res.status(500).json({ error: 'Database error' });
        if (results.length === 0) return res.status(404).json({ error: 'Item not found' });
        res.json(results[0]);
    });
})

// Create Item (Authenticated)
app.post('/items/create', authMiddleware, performanceLoggingMiddleware('/items/create'), (req, res) => {
    const { name, value } = req.body;
    db.query('INSERT INTO items (name, value) VALUES (?, ?)', [name, value], (err) => {
        if (err) return res.status(500).json({ error: 'Error saving item' });
        res.status(201).send('Item created');
    });
});


// Get performance metrics
app.get('/metrics', performanceLoggingMiddleware('/metrics'), (req, res) => {
    if (!fs.existsSync('performance_metrics_node.csv')) {
        return res.status(404).send('No performance metrics available');
    }
    const csv = fs.readFileSync('performance_metrics_node.csv', 'utf8');
    res.set('Content-Type', 'text/csv');
    res.send(csv);
});

// Start the Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

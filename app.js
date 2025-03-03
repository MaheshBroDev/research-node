const express = require('express');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const { createObjectCsvWriter } = require('csv-writer');
const bodyParser = require('body-parser');
const DockerStats = require('dockerstats');

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

    fs.appendFile('performance_metrics_node.json', JSON.stringify(record) + '\n', err => {
        if (err) console.error('Error writing to JSON file:', err);
    });
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
        if (err) return res.status(500).json({ error: 'Error saving item' ,err});
        res.status(201).json({ message: 'Item created' });
    });
});

// Helper functions for sorting
function bubbleSort(arr) {
    let len = arr.length;
    for (let i = 0; i < len; i++) {
        for (let j = 0; j < len - i - 1; j++) {
            if (arr[j] > arr[j + 1]) {
                let temp = arr[j];
                arr[j] = arr[j + 1];
                arr[j + 1] = temp;
            }
        }
    }
    return arr;
}

function quickSort(arr) {
    if (arr.length <= 1) {
        return arr;
    }
    let pivot = arr[0];
    let left = [];
    let right = [];
    for (let i = 1; i < arr.length; i++) {
        if (arr[i] < pivot) {
            left.push(arr[i]);
        } else {
            right.push(arr[i]);
        }
    }
    return quickSort(left).concat(pivot, quickSort(right));
}

function binaryInsertionSort(arr) {
    for (let i = 1; i < arr.length; i++) {
        let key = arr[i];
        let left = 0;
        let right = i - 1;

        // Binary search to find the correct position
        while (left <= right) {
            let mid = Math.floor((left + right) / 2);
            if (key < arr[mid]) {
                right = mid - 1;
            } else {
                left = mid + 1;
            }
        }

        // Shift elements to make space
        for (let j = i - 1; j >= left; j--) {
            arr[j + 1] = arr[j];
        }

        arr[left] = key;
    }
    return arr;
}

app.post('/sort', authMiddleware, performanceLoggingMiddleware('/sort'), (req, res) => {
    const { list } = req.body;

    if (!Array.isArray(list)) {
        return res.status(400).json({ error: 'Invalid input: List must be an array' });
    }

    const startTimeBubble = process.hrtime();
    const memoryUsageBeforeBubble = process.memoryUsage().heapUsed;
    const cpuUsageBeforeBubble = os.loadavg()[0];
    const sortedBubble = bubbleSort([...list]); // Perform Bubble Sort
    const elapsedBubble = process.hrtime(startTimeBubble);
    const elapsedTimeMsBubble = (elapsedBubble[0] * 1000 + elapsedBubble[1] / 1e6).toFixed(2);
    const memoryUsageAfterBubble = process.memoryUsage().heapUsed;
    const cpuUsageAfterBubble = os.loadavg()[0];

    const startTimeQuick = process.hrtime();
    const memoryUsageBeforeQuick = process.memoryUsage().heapUsed;
    const cpuUsageBeforeQuick = os.loadavg()[0];
    const sortedQuick = quickSort([...list]); // Perform Quick Sort
    const elapsedQuick = process.hrtime(startTimeQuick);
    const elapsedTimeMsQuick = (elapsedQuick[0] * 1000 + elapsedQuick[1] / 1e6).toFixed(2);
    const memoryUsageAfterQuick = process.memoryUsage().heapUsed;
    const cpuUsageAfterQuick = os.loadavg()[0];

    const startTimeBinary = process.hrtime();
    const memoryUsageBeforeBinary = process.memoryUsage().heapUsed;
    const cpuUsageBeforeBinary = os.loadavg()[0];
    const sortedBinary = binaryInsertionSort([...list]); // Perform Binary Insertion Sort
    const elapsedBinary = process.hrtime(startTimeBinary);
    const elapsedTimeMsBinary = (elapsedBinary[0] * 1000 + elapsedBinary[1] / 1e6).toFixed(2);
    const memoryUsageAfterBinary = process.memoryUsage().heapUsed;
    const cpuUsageAfterBinary = os.loadavg()[0];

    const results = {
        bubbleSort: {
            sortedList: sortedBubble,
            elapsedTime: `${elapsedTimeMsBubble} ms`,
            memoryUsage: `${(memoryUsageAfterBubble - memoryUsageBeforeBubble) / 1024 / 1024} MB`,
            cpuUsage: `${((cpuUsageAfterBubble - cpuUsageBeforeBubble) * 100).toFixed(2)}%`
        },
        quickSort: {
            sortedList: sortedQuick,
            elapsedTime: `${elapsedTimeMsQuick} ms`,
            memoryUsage: `${(memoryUsageAfterQuick - memoryUsageBeforeQuick) / 1024 / 1024} MB`,
            cpuUsage: `${((cpuUsageAfterQuick - cpuUsageBeforeQuick) * 100).toFixed(2)}%`
        },
        binarySort: {
            sortedList: sortedBinary,
            elapsedTime: `${elapsedTimeMsBinary} ms`,
            memoryUsage: `${(memoryUsageAfterBinary - memoryUsageBeforeBinary) / 1024 / 1024} MB`,
            cpuUsage: `${((cpuUsageAfterBinary - cpuUsageBeforeBinary) * 100).toFixed(2)}%`
        }
    };

    res.json(results);
});

// Get performance metrics
app.get('/metrics', performanceLoggingMiddleware('/metrics'), (req, res) => {
    if (!fs.existsSync('performance_metrics_node.json')) {
        return res.status(404).send('No performance metrics available');
    }
    const json = fs.readFileSync('performance_metrics_node.json', 'utf8');
    res.set('Content-Type', 'application/json');
    res.send(json);
});

app.get('/docker_metrics', (req, res) => {
    if (!fs.existsSync('docker_metrics_node.json')) {
        return res.status(404).send('No docker metrics available');
    }
    const json = fs.readFileSync('docker_metrics_node.json', 'utf8');
    res.set('Content-Type', 'application/json');
    res.send(json);
});

const dockerStats = new DockerStats();

dockerStats.on('stats', (stats) => {
const cpuUsage = stats.cpu.usage;
const memoryUsage = stats.memory.usage;
const activeConnections = stats.networks.eth0.rx_bytes; // Example for capturing active connections
const timestamp = new Date().toISOString();

const logEntry = {
    timestamp: timestamp,
    cpuUsage: cpuUsage,
    memoryUsage: memoryUsage,
    activeConnections: activeConnections
};

  fs.appendFile('docker_metrics_node.json', JSON.stringify(logEntry) + '\n', (err) => {
    if (err) {
      console.error('Error writing to docker_metrics_node.json:', err);
    }
  });
});

dockerStats.start();

// Start the Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

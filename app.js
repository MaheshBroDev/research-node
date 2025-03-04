const express = require('express');
const mysql = require('mysql2');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const os = require('os');
const { createObjectCsvWriter } = require('csv-writer');
const bodyParser = require('body-parser');
// const Docker = require('dockerode');

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
/**
 * Logs performance metrics for a given endpoint.
 *
 * @param {string} endpoint - The endpoint being measured.
 * @param {Array} startTime - The high-resolution real time [seconds, nanoseconds] tuple.
 *
 * @property {string} timestamp - The ISO string of the current date and time.
 * @property {string} endpoint - The endpoint being measured.
 * @property {number} rss - Resident Set Size, the total memory allocated for the process execution.
 * @property {number} heapTotal - Total size of the allocated heap.
 * @property {number} heapUsed - Actual memory used during the execution.
 * @property {string} elapsedTime - The elapsed time in milliseconds.
 * @property {string} cpuUsage - The CPU usage percentage.
 * @property {string} memoryUsage - The memory usage in megabytes.
 */
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

// Update Item (Authenticated)
app.put('/item/update', authMiddleware, performanceLoggingMiddleware('/item/update'), (req, res) => {
    const { id, name, value } = req.body;
    if (!id || !name || !value) {
        return res.status(400).json({ message: 'Missing parameters' });
    }

    db.query('UPDATE items SET name = ?, value = ? WHERE id = ?', [name, value, id], (err) => {
        if (err) {
            return res.status(500).json({ message: 'Error updating item' });
        }
        res.status(200).json({ message: 'Item updated' });
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

app.get('/metrics/delete', performanceLoggingMiddleware('/metrics/delete'), (req, res) => {
    fs.unlink('performance_metrics_node.json', (err) => {
        if (err) {
            console.error('Error deleting performance metrics file:', err);
            return res.status(500).json({ error: 'Failed to delete performance metrics' });
        }
        return res.status(200).json({ message: 'Performance metrics deleted' });
    });
});

app.get('/docker_metrics', (req, res) => {
    if (!fs.existsSync('docker_metrics_node.json')) {
        return res.status(404).send('No docker metrics available');
    }
    const json = fs.readFileSync('docker_metrics_node.json', 'utf8');
    res.set('Content-Type', 'application/json');
    res.send(json);
});

// const docker = new Docker();

// async function getContainerStats() {
//   try {
//     const containers = await docker.listContainers();
//     if (containers.length === 0) {
//       console.log('No containers running.');
//       return;
//     }

//     // Assuming we want stats for the first container
//     const container = docker.getContainer(containers[0].Id);
//     const statsStream = await container.stats({ stream: true });

//     statsStream.on('data', (stat) => {
//       const logEntry = {
//         timestamp: new Date().toISOString(),
//         cpuUsage: stat.cpu_stats.cpu_usage.total_usage,
//         memoryUsage: stat.memory_stats.usage,
//         netInput: stat.networks.eth0.rx_bytes,
//         netOutput: stat.networks.eth0.tx_bytes
//       };

//       fs.appendFile('docker_metrics_node.json', JSON.stringify(logEntry) + '\n', (err) => {
//         if (err) {
//           console.error('Error writing to docker_metrics_node.json:', err);
//         }
//       });
//     });

//     statsStream.on('error', (err) => {
//       console.error('Error getting container stats:', err);
//     });
//   } catch (err) {
//     console.error('Error listing containers:', err);
//   }
// }

// getContainerStats();

// Health Check Endpoint
app.get('/health', (req, res) => {
    db.query('SELECT 1', (err) => {
        if (err) {
            console.error('Database health check failed:', err);
            return res.status(500).send('Database not OK');
        }
        res.status(200).send('OK');
    });
});

app.get('/performance/last', performanceLoggingMiddleware('/performance/last'), (req, res) => {
    fs.readFile('performance_metrics_node.json', 'utf8', (err, data) => {
        if (err) {
            console.error('Error reading performance metrics file:', err);
            return res.status(500).json({ error: 'Failed to read performance metrics' });
        }

        const lines = data.trim().split('\n');
        if (lines.length === 0) {
            return res.status(404).json({ error: 'No performance metrics available' });
        }

        try {
            const lastMetric = JSON.parse(lines[lines.length - 1]);
            res.json(lastMetric);
        } catch (parseError) {
            console.error('Error parsing last performance metric:', parseError);
            res.status(500).json({ error: 'Failed to parse performance metrics' });
        }
    });
});

// Endpoint to serve text files from /loader/<path>.txt
app.get('/loaderio-:filename([a-zA-Z0-9]{32}).txt', (req, res) => {
    const filename = req.params.filename;
    res.set('Content-Type', 'text/plain');
    res.send(`loaderio-${filename}`);
});

app.delete('/item/delete', authMiddleware, performanceLoggingMiddleware('/item/delete'), (req, res) => {
    const { id } = req.query;
    if (!id || isNaN(id)) {
        return res.status(400).json({ message: 'Invalid ID' });
    }
    db.query('DELETE FROM items WHERE id = ?', [id], (err) => {
        if (err) return res.status(500).json({ message: 'Error deleting item' });
        res.json({ message: 'Item deleted' });
    });
});

app.delete('/item/last/delete', authMiddleware, performanceLoggingMiddleware('/item/last/delete'), (req, res) => {
    db.query('SELECT id FROM items ORDER BY id DESC LIMIT 1', (err, results) => {
        if (err) return res.status(500).json({ message: 'Database error' });
        if (results.length === 0) return res.status(404).json({ message: 'No items found' });
        const lastItemId = results[0].id;
        db.query('DELETE FROM items WHERE id = ?', [lastItemId], (err) => {
            if (err) return res.status(500).json({ message: 'Error deleting last item' });
            res.json({ message: 'Last item deleted' });
        });
    });
});

// // Graceful Shutdown
// process.on('SIGINT', () => {
//     console.log('Shutting down server...');
//     db.end(err => {
//         if (err) {
//             console.error('Error closing database connection:', err);
//             process.exit(1);
//         }
//         console.log('Database connection closed.');
//         process.exit(0);
//     });
// });

// process.on('SIGTERM', () => {
//     console.log('Shutting down server...');
//     db.end(err => {
//         if (err) {
//             console.error('Error closing database connection:', err);
//             process.exit(1);
//         }
//         console.log('Database connection closed.');
//         process.exit(0);
//     });
// });

// Start the Server
app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});

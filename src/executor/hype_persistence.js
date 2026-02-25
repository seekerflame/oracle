import sqlite3 from 'sqlite3';
import path from 'path';

/**
 * hype_persistence.js
 * 📁 THE HYPE SENTINEL: Persistence Layer
 * 
 * Manages the SQLite storage for discovered Blue-Chip gems.
 */

const DB_PATH = path.join(process.cwd(), 'data', 'oracle.db');

class HypePersistence {
    constructor() {
        this.db = new sqlite3.Database(DB_PATH);
        this.init();
    }

    init() {
        const sql = `
            CREATE TABLE IF NOT EXISTS gems (
                address TEXT PRIMARY KEY,
                symbol TEXT,
                name TEXT,
                liquidity REAL,
                age_days INTEGER,
                discovered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
                status TEXT DEFAULT 'WATCHING'
            )
        `;
        this.db.run(sql);
    }

    saveGem(gem) {
        const sql = `
            INSERT OR REPLACE INTO gems (address, symbol, name, liquidity, age_days)
            VALUES (?, ?, ?, ?, ?)
        `;
        const params = [
            gem.address,
            gem.symbol,
            gem.name,
            gem.liquidity,
            gem.age
        ];

        return new Promise((resolve, reject) => {
            this.db.run(sql, params, (err) => {
                if (err) reject(err);
                else resolve();
            });
        });
    }

    getWatchlist() {
        const sql = `SELECT * FROM gems WHERE status = 'WATCHING' ORDER BY discovered_at DESC`;
        return new Promise((resolve, reject) => {
            this.db.all(sql, [], (err, rows) => {
                if (err) reject(err);
                else resolve(rows);
            });
        });
    }
}

export default new HypePersistence();

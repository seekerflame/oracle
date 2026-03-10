import 'dotenv/config';
import fetch from 'node-fetch';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Polymarket Data Connector
 *
 * Enhanced connector for Polymarket's Gamma API and CLOB.
 * Follows coingecko.js pattern: rate limiting, retry on 429, class-based.
 *
 * Provides: market listings, individual market data, price history,
 * recent trades, and geopolitical market filtering.
 *
 * Rate limits: ~10 calls/min on public API (conservative)
 */

const GAMMA_API = 'https://gamma-api.polymarket.com';
const CLOB_API = 'https://clob.polymarket.com';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

// Geopolitical keyword tags for filtering markets
const GEO_KEYWORDS = [
    'war', 'strike', 'invasion', 'embassy', 'evacuation', 'military',
    'missile', 'ceasefire', 'sanctions', 'troops', 'deploy', 'nato',
    'nuclear', 'iran', 'israel', 'gaza', 'ukraine', 'russia', 'china',
    'taiwan', 'baghdad', 'conflict', 'attack', 'defense', 'pentagon',
    'state department', 'un security council', 'peace deal', 'treaty',
];

export class PolymarketConnector {
    constructor() {
        this.lastRequest = 0;
        this.minInterval = 6000; // 6s between requests (safe for public API)
        this.db = null;
    }

    // ─── Rate-limited fetch (coingecko.js pattern) ────────────────

    async _fetch(url) {
        const now = Date.now();
        const elapsed = now - this.lastRequest;
        if (elapsed < this.minInterval) {
            await new Promise(r => setTimeout(r, this.minInterval - elapsed));
        }
        this.lastRequest = Date.now();

        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (response.status === 429) {
            console.log('  ⏳ Rate limited. Waiting 60s...');
            await new Promise(r => setTimeout(r, 60000));
            return this._fetch(url); // Retry
        }

        if (!response.ok) {
            throw new Error(`Polymarket ${response.status}: ${response.statusText}`);
        }

        return response.json();
    }

    // ─── Database ─────────────────────────────────────────────────

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS markets (
                    id TEXT PRIMARY KEY,
                    title TEXT,
                    odds_yes REAL,
                    odds_no REAL,
                    volume_24h REAL,
                    liquidity REAL,
                    efficiency_score REAL,
                    end_date TEXT,
                    active INTEGER DEFAULT 1,
                    updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS market_snapshots (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id TEXT,
                    odds_yes REAL,
                    odds_no REAL,
                    volume_24h REAL,
                    captured_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_snapshots_market ON market_snapshots(market_id, captured_at);
            `);
        }
        return this.db;
    }

    // ─── API Methods ──────────────────────────────────────────────

    /**
     * Get active markets from Gamma API.
     * @param {number} limit - Max markets to return
     * @param {number} offset - Pagination offset
     * @returns {Array} Market objects
     */
    async getMarkets(limit = 100, offset = 0) {
        const data = await this._fetch(
            `${GAMMA_API}/markets?limit=${limit}&offset=${offset}&active=true&closed=false`
        );
        return Array.isArray(data) ? data : [];
    }

    /**
     * Get a single market by ID.
     * @param {string} id - Market ID
     * @returns {Object} Market data with parsed odds
     */
    async getMarket(id) {
        const data = await this._fetch(`${GAMMA_API}/markets?id=${id}`);
        if (!data || data.length === 0) return null;

        const m = data[0];
        return this._parseMarket(m);
    }

    /**
     * Get price history for a market (from snapshots).
     * Falls back to stored snapshots since Gamma doesn't expose full history.
     * @param {string} marketId
     * @param {number} hours - How many hours back
     * @returns {Array} Price snapshots
     */
    getHistory(marketId, hours = 24) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);
        return db.prepare(`
            SELECT odds_yes, odds_no, volume_24h, captured_at
            FROM market_snapshots
            WHERE market_id = ? AND captured_at > ?
            ORDER BY captured_at ASC
        `).all(marketId, since);
    }

    /**
     * Get recent trades from CLOB API.
     * @param {string} tokenId - Condition token ID
     * @param {number} limit - Max trades
     * @returns {Array} Recent trades
     */
    async getTrades(tokenId, limit = 50) {
        try {
            const data = await this._fetch(
                `${CLOB_API}/trades?asset_id=${tokenId}&limit=${limit}`
            );
            return data || [];
        } catch (e) {
            // CLOB trades endpoint may require auth for some queries
            return [];
        }
    }

    /**
     * Get order book from CLOB API.
     * @param {string} tokenId - Condition token ID
     * @returns {Object} { bids: [], asks: [] }
     */
    async getOrderBook(tokenId) {
        try {
            const data = await this._fetch(
                `${CLOB_API}/book?token_id=${tokenId}`
            );
            return data || { bids: [], asks: [] };
        } catch (e) {
            return { bids: [], asks: [] };
        }
    }

    /**
     * Get active geopolitical markets filtered by keywords.
     * @returns {Array} Filtered market objects with parsed odds
     */
    async getActiveGeopolitical() {
        const allMarkets = [];
        let offset = 0;

        // Paginate through markets (max 3 pages to avoid rate limiting)
        for (let page = 0; page < 3; page++) {
            const batch = await this.getMarkets(100, offset);
            if (batch.length === 0) break;
            allMarkets.push(...batch);
            offset += 100;
        }

        // Filter by geopolitical keywords
        const geoMarkets = allMarkets.filter(m => {
            const text = `${m.question || ''} ${m.description || ''}`.toLowerCase();
            return GEO_KEYWORDS.some(kw => text.includes(kw));
        });

        return geoMarkets.map(m => this._parseMarket(m));
    }

    /**
     * Snapshot current market state to SQLite for historical tracking.
     * @param {Array} markets - Parsed market objects
     */
    snapshotMarkets(markets) {
        const db = this._getDb();
        const now = Date.now();

        const upsertMarket = db.prepare(`
            INSERT INTO markets (id, title, odds_yes, odds_no, volume_24h, liquidity, end_date, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(id) DO UPDATE SET
                odds_yes = excluded.odds_yes,
                odds_no = excluded.odds_no,
                volume_24h = excluded.volume_24h,
                liquidity = excluded.liquidity,
                updated_at = excluded.updated_at
        `);

        const insertSnapshot = db.prepare(`
            INSERT INTO market_snapshots (market_id, odds_yes, odds_no, volume_24h, captured_at)
            VALUES (?, ?, ?, ?, ?)
        `);

        const txn = db.transaction((mkts) => {
            for (const m of mkts) {
                upsertMarket.run(m.id, m.title, m.oddsYes, m.oddsNo, m.volume24h, m.liquidity || 0, m.endDate || null, now);
                insertSnapshot.run(m.id, m.oddsYes, m.oddsNo, m.volume24h, now);
            }
        });

        txn(markets);
        return markets.length;
    }

    // ─── Helpers ──────────────────────────────────────────────────

    _parseMarket(m) {
        let prices = [0, 0];
        try {
            prices = typeof m.outcomePrices === 'string' ? JSON.parse(m.outcomePrices) : (m.outcomePrices || [0, 0]);
        } catch (e) { /* default to [0,0] */ }

        return {
            id: m.id || m.condition_id,
            title: m.question || m.title || 'Unknown',
            oddsYes: parseFloat(prices[0]) || 0,
            oddsNo: parseFloat(prices[1]) || 0,
            volume24h: parseFloat(m.volume24hr || m.volume || 0),
            liquidity: parseFloat(m.liquidityClob || m.liquidity || 0),
            endDate: m.endDate || m.end_date_iso || null,
            tokens: m.clobTokenIds ? (typeof m.clobTokenIds === 'string' ? JSON.parse(m.clobTokenIds) : m.clobTokenIds) : [],
            description: m.description || '',
            active: m.active !== false && m.closed !== true,
        };
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const pm = new PolymarketConnector();

    console.log('🔮 POLYMARKET CONNECTOR — SELF-TEST\n');

    // Test 1: Fetch some markets
    console.log('1. Fetching active markets...');
    const markets = await pm.getMarkets(10);
    console.log(`   Found ${markets.length} markets`);

    if (markets.length > 0) {
        const first = pm._parseMarket(markets[0]);
        console.log(`   Sample: "${first.title}" — YES: ${(first.oddsYes * 100).toFixed(1)}%`);
    }

    // Test 2: Geopolitical filter
    console.log('\n2. Scanning for geopolitical markets...');
    const geoMarkets = await pm.getActiveGeopolitical();
    console.log(`   Found ${geoMarkets.length} geopolitical markets:`);

    for (const m of geoMarkets.slice(0, 10)) {
        const yesP = (m.oddsYes * 100).toFixed(1);
        const vol = Math.floor(m.volume24h).toLocaleString();
        const asymmetric = m.oddsYes < 0.10 ? ' ← ASYMMETRIC' : '';
        console.log(`   📍 [${yesP}%] ${m.title} | Vol: $${vol}${asymmetric}`);
    }

    // Test 3: Snapshot to DB
    if (geoMarkets.length > 0) {
        console.log('\n3. Snapshotting to SQLite...');
        const count = pm.snapshotMarkets(geoMarkets);
        console.log(`   Persisted ${count} market snapshots`);
    }

    // Test 4: History check
    if (geoMarkets.length > 0) {
        console.log('\n4. Checking history for first market...');
        const history = pm.getHistory(geoMarkets[0].id, 168); // 7 days
        console.log(`   ${history.length} snapshots recorded`);
    }

    pm.close();
    console.log('\n✅ Self-test complete.');
}

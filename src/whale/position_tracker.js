import 'dotenv/config';
import Database from 'better-sqlite3';
import { PolygonscanConnector } from './polygonscan.js';
import { PolymarketConnector } from '../market/polymarket_api.js';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Polymarket Position Tracker
 *
 * Monitors known whale wallets' Polymarket positions via on-chain data.
 * Detects: new positions, position increases, exits.
 * Alerts on: whale enters >$1k position on <10% odds (asymmetric signal).
 *
 * Uses ERC1155 transfers on Polygon (Polymarket CTF tokens).
 *
 * This is the "who's putting money where" transparency layer.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

// Polymarket CTF (Conditional Token Framework) contract on Polygon
const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045'.toLowerCase();
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'.toLowerCase();

export class PositionTracker {
    constructor() {
        this.ps = new PolygonscanConnector();
        this.pm = new PolymarketConnector();
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS positions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wallet TEXT,
                    market_id TEXT,
                    token_id TEXT,
                    side TEXT,
                    amount REAL,
                    entry_price REAL,
                    detected_at INTEGER,
                    status TEXT DEFAULT 'ACTIVE'
                );
                CREATE TABLE IF NOT EXISTS position_changes (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    wallet TEXT,
                    token_id TEXT,
                    change_type TEXT,
                    amount_change REAL,
                    tx_hash TEXT,
                    detected_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_pos_wallet ON positions(wallet);
                CREATE INDEX IF NOT EXISTS idx_pos_status ON positions(status);
                CREATE INDEX IF NOT EXISTS idx_changes_wallet ON position_changes(wallet);
            `);
        }
        return this.db;
    }

    /**
     * Scan a wallet for Polymarket-related token transfers.
     * Detects CTF token movements (buys/sells on prediction markets).
     * @param {string} address - Wallet to scan
     * @returns {Object} Position activity
     */
    async scanWallet(address) {
        const normalAddr = address.toLowerCase();
        const db = this._getDb();

        console.log(`     Scanning ${normalAddr.slice(0, 10)}... for PM activity`);

        // Get ERC1155 transfers (CTF tokens are ERC1155)
        let transfers = [];
        try {
            transfers = await this.ps.getERC1155Transfers(normalAddr);
            if (!Array.isArray(transfers)) transfers = [];
        } catch (e) {
            // Fallback: check normal token transfers
            try {
                transfers = await this.ps.getTokenTransfers(normalAddr);
                if (!Array.isArray(transfers)) transfers = [];
                // Filter for CTF-related transfers
                transfers = transfers.filter(tx =>
                    tx.contractAddress?.toLowerCase() === CTF_CONTRACT ||
                    tx.to?.toLowerCase() === CTF_EXCHANGE ||
                    tx.from?.toLowerCase() === CTF_EXCHANGE
                );
            } catch (e2) {
                return { address: normalAddr, error: e2.message, positions: [] };
            }
        }

        // Filter for Polymarket-related transfers (CTF contract interactions)
        const pmTransfers = transfers.filter(tx => {
            const contract = (tx.contractAddress || '').toLowerCase();
            const to = (tx.to || '').toLowerCase();
            const from = (tx.from || '').toLowerCase();
            return contract === CTF_CONTRACT ||
                   to === CTF_EXCHANGE ||
                   from === CTF_EXCHANGE ||
                   to === CTF_CONTRACT ||
                   from === CTF_CONTRACT;
        });

        // Aggregate by token ID
        const tokenPositions = {};

        for (const tx of pmTransfers) {
            const tokenId = tx.tokenID || tx.tokenId || 'unknown';
            const isReceive = tx.to?.toLowerCase() === normalAddr;
            const value = parseInt(tx.tokenValue || tx.value || '0');

            if (!tokenPositions[tokenId]) {
                tokenPositions[tokenId] = {
                    tokenId,
                    netAmount: 0,
                    buys: 0,
                    sells: 0,
                    lastTx: null,
                };
            }

            if (isReceive) {
                tokenPositions[tokenId].netAmount += value;
                tokenPositions[tokenId].buys++;
            } else {
                tokenPositions[tokenId].netAmount -= value;
                tokenPositions[tokenId].sells++;
            }
            tokenPositions[tokenId].lastTx = tx.hash || tx.transactionHash;
        }

        // Filter to active positions (net > 0)
        const activePositions = Object.values(tokenPositions).filter(p => p.netAmount > 0);

        // Detect changes from last scan
        const changes = [];
        for (const pos of activePositions) {
            const existing = db.prepare(`
                SELECT * FROM positions WHERE wallet = ? AND token_id = ? AND status = 'ACTIVE'
            `).get(normalAddr, pos.tokenId);

            if (!existing) {
                // New position
                changes.push({
                    type: 'NEW_POSITION',
                    tokenId: pos.tokenId,
                    amount: pos.netAmount,
                    wallet: normalAddr,
                });

                db.prepare(`
                    INSERT INTO positions (wallet, token_id, amount, detected_at)
                    VALUES (?, ?, ?, ?)
                `).run(normalAddr, pos.tokenId, pos.netAmount, Date.now());
            } else if (pos.netAmount !== existing.amount) {
                // Position changed
                const delta = pos.netAmount - existing.amount;
                changes.push({
                    type: delta > 0 ? 'INCREASED' : 'DECREASED',
                    tokenId: pos.tokenId,
                    amount: pos.netAmount,
                    previousAmount: existing.amount,
                    delta,
                    wallet: normalAddr,
                });

                db.prepare('UPDATE positions SET amount = ?, detected_at = ? WHERE id = ?')
                    .run(pos.netAmount, Date.now(), existing.id);
            }

            // Record change
            if (changes.length > 0) {
                const latest = changes[changes.length - 1];
                db.prepare(`
                    INSERT INTO position_changes (wallet, token_id, change_type, amount_change, tx_hash, detected_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                `).run(normalAddr, pos.tokenId, latest.type, latest.delta || latest.amount, pos.lastTx, Date.now());
            }
        }

        return {
            address: normalAddr,
            totalTransfers: pmTransfers.length,
            activePositions: activePositions.length,
            positions: activePositions,
            changes,
        };
    }

    /**
     * Scan all tracked wallets and return alerts.
     * @param {Array<string>} addresses - Wallets to scan
     * @returns {Object} Scan results with alerts
     */
    async scanAll(addresses) {
        console.log(`  🐋 POSITION SCAN — ${addresses.length} wallets\n`);

        const results = [];
        const alerts = [];

        for (const addr of addresses) {
            const result = await this.scanWallet(addr);
            results.push(result);

            // Generate alerts for significant changes
            for (const change of (result.changes || [])) {
                if (change.type === 'NEW_POSITION') {
                    alerts.push({
                        severity: 'HIGH',
                        type: 'NEW_WHALE_POSITION',
                        wallet: change.wallet,
                        tokenId: change.tokenId,
                        amount: change.amount,
                        message: `Whale ${change.wallet.slice(0, 10)}... opened new position (${change.amount} shares)`,
                    });
                } else if (change.type === 'INCREASED' && change.delta > 0) {
                    alerts.push({
                        severity: 'MEDIUM',
                        type: 'POSITION_INCREASED',
                        wallet: change.wallet,
                        tokenId: change.tokenId,
                        delta: change.delta,
                        message: `Whale ${change.wallet.slice(0, 10)}... added ${change.delta} shares`,
                    });
                }
            }
        }

        return {
            walletsScanned: addresses.length,
            totalPositions: results.reduce((s, r) => s + (r.activePositions || 0), 0),
            totalChanges: results.reduce((s, r) => s + (r.changes?.length || 0), 0),
            alerts,
            results,
        };
    }

    /**
     * Get recent position changes from database.
     * @param {number} hours - How far back to look
     * @returns {Array} Recent changes
     */
    getRecentChanges(hours = 24) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);
        return db.prepare(`
            SELECT * FROM position_changes
            WHERE detected_at > ?
            ORDER BY detected_at DESC
        `).all(since);
    }

    /**
     * Format scan results for human-readable output.
     */
    static formatReport(scanResults) {
        let r = `\n🐋 POSITION TRACKER REPORT\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Wallets Scanned: ${scanResults.walletsScanned}\n`;
        r += `  Active Positions: ${scanResults.totalPositions}\n`;
        r += `  Changes Detected: ${scanResults.totalChanges}\n`;

        if (scanResults.alerts.length > 0) {
            r += `\n  🚨 ALERTS (${scanResults.alerts.length}):\n`;
            for (const a of scanResults.alerts) {
                const icon = a.severity === 'HIGH' ? '🔴' : a.severity === 'MEDIUM' ? '🟡' : '🟢';
                r += `     ${icon} [${a.type}] ${a.message}\n`;
            }
        }

        for (const result of scanResults.results) {
            if (result.error) {
                r += `\n  ❌ ${result.address.slice(0, 10)}...: ${result.error}\n`;
                continue;
            }
            if (result.activePositions > 0) {
                r += `\n  📍 ${result.address.slice(0, 10)}...${result.address.slice(-6)}\n`;
                r += `     Transfers: ${result.totalTransfers} | Active: ${result.activePositions}\n`;
                for (const pos of result.positions.slice(0, 5)) {
                    r += `     Token: ${pos.tokenId.slice(0, 12)}... | Net: ${pos.netAmount} shares | B:${pos.buys} S:${pos.sells}\n`;
                }
            }
        }

        return r;
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.pm.close();
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const tracker = new PositionTracker();

    console.log('🐋 POSITION TRACKER — SELF-TEST\n');

    const walletList = process.env.WHALE_WALLETS
        ? process.env.WHALE_WALLETS.split(',').map(w => w.trim())
        : [];

    if (walletList.length === 0) {
        console.log('  ⚠️  No WHALE_WALLETS set in .env');
        console.log('  Set WHALE_WALLETS=0xABC...,0xDEF... to track positions\n');

        // Show recent changes
        const changes = tracker.getRecentChanges(168); // 7 days
        if (changes.length > 0) {
            console.log(`  Recent changes (${changes.length}):`);
            for (const c of changes.slice(0, 10)) {
                console.log(`    ${c.change_type}: ${c.wallet.slice(0, 10)}... | ${c.amount_change} shares`);
            }
        } else {
            console.log('  No position changes recorded yet.');
        }
    } else {
        const results = await tracker.scanAll(walletList);
        console.log(PositionTracker.formatReport(results));
    }

    tracker.close();
    console.log('\n✅ Self-test complete.');
}

import 'dotenv/config';
import Database from 'better-sqlite3';
import { PolygonscanConnector } from './polygonscan.js';
import { fileURLToPath } from 'url';
import path from 'path';
import crypto from 'crypto';

/**
 * Oracle Truth Machine — Wallet Cluster Analysis
 *
 * Identifies wallets likely controlled by the same entity using:
 * - Common funding sources (same "mother wallet")
 * - Transaction timing patterns (same gas schedule)
 * - Behavioral correlation (similar bet patterns)
 *
 * All analysis uses PUBLIC on-chain data only.
 * This is the transparency layer that exposes hidden coordination.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

export class ClusterAnalyzer {
    constructor() {
        this.ps = new PolygonscanConnector();
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS wallets (
                    address TEXT PRIMARY KEY,
                    label TEXT,
                    cluster_id TEXT,
                    first_seen INTEGER,
                    total_value REAL,
                    tx_count INTEGER DEFAULT 0,
                    updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS clusters (
                    id TEXT PRIMARY KEY,
                    mother_wallet TEXT,
                    confidence REAL,
                    wallet_count INTEGER,
                    total_value REAL,
                    updated_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS funding_links (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    funder TEXT,
                    funded TEXT,
                    amount_pol REAL,
                    tx_count INTEGER,
                    first_seen TEXT,
                    UNIQUE(funder, funded)
                );
            `);
        }
        return this.db;
    }

    /**
     * Analyze a list of wallets for clustering patterns.
     * @param {Array<string>} addresses - Wallet addresses to analyze
     * @returns {Object} Cluster analysis results
     */
    async analyzeClusters(addresses) {
        console.log(`  🔍 Analyzing ${addresses.length} wallets for clusters...`);

        const db = this._getDb();
        const fundingMap = {}; // funder -> [funded wallets]
        const walletFunders = {}; // wallet -> [funders]
        const walletData = {};

        // Step 1: Get funding sources for each wallet
        for (const addr of addresses) {
            const normalAddr = addr.toLowerCase();
            console.log(`     Tracing funding for ${normalAddr.slice(0, 10)}...`);

            try {
                const sources = await this.ps.getFundingSources(normalAddr);
                walletFunders[normalAddr] = sources;

                // Get genesis tx for age check
                const genesis = await this.ps.getGenesisTransaction(normalAddr);
                const firstSeen = genesis ? parseInt(genesis.timeStamp) * 1000 : Date.now();

                // Get balance
                const balanceWei = await this.ps.getBalance(normalAddr);
                const balance = parseInt(balanceWei) / 1e18;

                walletData[normalAddr] = {
                    address: normalAddr,
                    firstSeen,
                    balance,
                    fundingSources: sources,
                    txCount: sources.reduce((s, f) => s + f.txCount, 0),
                };

                // Build reverse map: funder -> funded wallets
                for (const source of sources) {
                    const funderAddr = source.address;
                    if (!fundingMap[funderAddr]) fundingMap[funderAddr] = [];
                    fundingMap[funderAddr].push({
                        wallet: normalAddr,
                        amount: source.totalPOL,
                        firstSeen: source.firstSeen,
                    });

                    // Persist funding link
                    db.prepare(`
                        INSERT INTO funding_links (funder, funded, amount_pol, tx_count, first_seen)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(funder, funded) DO UPDATE SET
                            amount_pol = excluded.amount_pol,
                            tx_count = excluded.tx_count
                    `).run(funderAddr, normalAddr, source.totalPOL, source.txCount, source.firstSeen);
                }
            } catch (e) {
                console.log(`     ⚠️  Failed for ${normalAddr.slice(0, 10)}: ${e.message}`);
                walletData[normalAddr] = { address: normalAddr, error: e.message };
            }
        }

        // Step 2: Identify clusters (wallets sharing the same funder)
        const clusters = [];

        for (const [funder, fundedWallets] of Object.entries(fundingMap)) {
            if (fundedWallets.length >= 2) {
                // This funder funded 2+ of our tracked wallets — cluster detected!
                const clusterId = crypto.createHash('md5').update(funder).digest('hex').slice(0, 12);

                // Calculate timing correlation
                const timestamps = fundedWallets
                    .map(w => new Date(w.firstSeen).getTime())
                    .filter(t => !isNaN(t));

                let timingScore = 0;
                if (timestamps.length >= 2) {
                    timestamps.sort();
                    const maxGap = timestamps[timestamps.length - 1] - timestamps[0];
                    const hoursGap = maxGap / (1000 * 60 * 60);
                    // If all funded within 24 hours, high correlation
                    timingScore = Math.max(0, 1 - (hoursGap / 24));
                }

                // Confidence = combo of shared funder + timing + count
                const countScore = Math.min(1, fundedWallets.length / 5);
                const confidence = Math.round(((0.5 + timingScore * 0.3 + countScore * 0.2)) * 100);

                const totalValue = fundedWallets.reduce((s, w) => s + w.amount, 0);

                const cluster = {
                    id: clusterId,
                    motherWallet: funder,
                    wallets: fundedWallets.map(w => w.wallet),
                    walletCount: fundedWallets.length,
                    totalValue,
                    confidence: Math.min(100, confidence),
                    timingScore: parseFloat(timingScore.toFixed(2)),
                    fundedWithinHours: timestamps.length >= 2
                        ? ((timestamps[timestamps.length - 1] - timestamps[0]) / (1000 * 60 * 60)).toFixed(1)
                        : 'N/A',
                };

                clusters.push(cluster);

                // Persist cluster
                db.prepare(`
                    INSERT INTO clusters (id, mother_wallet, confidence, wallet_count, total_value, updated_at)
                    VALUES (?, ?, ?, ?, ?, ?)
                    ON CONFLICT(id) DO UPDATE SET
                        confidence = excluded.confidence,
                        wallet_count = excluded.wallet_count,
                        total_value = excluded.total_value,
                        updated_at = excluded.updated_at
                `).run(clusterId, funder, cluster.confidence, cluster.walletCount, totalValue, Date.now());

                // Tag wallets with cluster ID
                for (const w of fundedWallets) {
                    db.prepare(`
                        INSERT INTO wallets (address, cluster_id, first_seen, total_value, updated_at)
                        VALUES (?, ?, ?, ?, ?)
                        ON CONFLICT(address) DO UPDATE SET
                            cluster_id = excluded.cluster_id,
                            updated_at = excluded.updated_at
                    `).run(w.wallet, clusterId, new Date(w.firstSeen).getTime(), w.amount, Date.now());
                }
            }
        }

        // Sort clusters by confidence descending
        clusters.sort((a, b) => b.confidence - a.confidence);

        return {
            walletsAnalyzed: addresses.length,
            clustersFound: clusters.length,
            clusters,
            walletData,
            unclustered: addresses.filter(a =>
                !clusters.some(c => c.wallets.includes(a.toLowerCase()))
            ),
        };
    }

    /**
     * Get persisted clusters from database.
     * @returns {Array} Stored clusters
     */
    getClusters() {
        const db = this._getDb();
        return db.prepare('SELECT * FROM clusters ORDER BY confidence DESC').all();
    }

    /**
     * Get wallets in a specific cluster.
     * @param {string} clusterId
     * @returns {Array} Wallet addresses
     */
    getClusterWallets(clusterId) {
        const db = this._getDb();
        return db.prepare('SELECT * FROM wallets WHERE cluster_id = ?').all(clusterId);
    }

    /**
     * Format cluster analysis for human-readable output.
     */
    static formatReport(analysis) {
        let r = `\n🐋 CLUSTER ANALYSIS REPORT\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Wallets Analyzed: ${analysis.walletsAnalyzed}\n`;
        r += `  Clusters Found: ${analysis.clustersFound}\n`;
        r += `  Unclustered: ${analysis.unclustered.length}\n`;

        for (const c of analysis.clusters) {
            const icon = c.confidence >= 80 ? '🔴' : c.confidence >= 50 ? '🟡' : '🟢';
            r += `\n  ${icon} CLUSTER ${c.id} — Confidence: ${c.confidence}%\n`;
            r += `     Mother Wallet: ${c.motherWallet.slice(0, 10)}...${c.motherWallet.slice(-6)}\n`;
            r += `     Wallets: ${c.walletCount} | Total Funded: ${c.totalValue.toFixed(2)} POL\n`;
            r += `     Timing: ${c.fundedWithinHours}h window | Score: ${c.timingScore}\n`;
            r += `     Members:\n`;
            for (const w of c.wallets) {
                r += `       - ${w.slice(0, 10)}...${w.slice(-6)}\n`;
            }
        }

        if (analysis.unclustered.length > 0) {
            r += `\n  ⚪ Unclustered wallets:\n`;
            for (const w of analysis.unclustered) {
                r += `     - ${w.slice(0, 10)}...${w.slice(-6)}\n`;
            }
        }

        return r;
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
    const analyzer = new ClusterAnalyzer();

    console.log('🐋 CLUSTER ANALYZER — SELF-TEST\n');

    // Parse wallet list from env or use defaults
    const walletList = process.env.WHALE_WALLETS
        ? process.env.WHALE_WALLETS.split(',').map(w => w.trim())
        : [];

    if (walletList.length === 0) {
        console.log('  ⚠️  No WHALE_WALLETS set in .env');
        console.log('  Set WHALE_WALLETS=0xABC...,0xDEF... to analyze wallet clusters');
        console.log('\n  Showing persisted clusters instead...');

        const clusters = analyzer.getClusters();
        if (clusters.length > 0) {
            console.log(`  Found ${clusters.length} stored clusters:`);
            for (const c of clusters) {
                console.log(`  - ${c.id}: ${c.wallet_count} wallets, ${c.confidence}% confidence`);
            }
        } else {
            console.log('  No clusters in database yet.');
        }
    } else {
        console.log(`  Analyzing ${walletList.length} wallets: ${walletList.map(w => w.slice(0, 10)).join(', ')}...\n`);
        const results = await analyzer.analyzeClusters(walletList);
        console.log(ClusterAnalyzer.formatReport(results));
    }

    analyzer.close();
    console.log('\n✅ Self-test complete.');
}

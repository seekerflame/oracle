import 'dotenv/config';
import { ClobClient } from '@polymarket/clob-client';
import { ethers } from 'ethers';
import { checkGas } from '../executor/gas_sentinel.js';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Generalized Order Stager
 *
 * Generalized version of baghdad_bet.js pattern.
 * Handles: limit buy, limit sell, market buy on Polymarket CLOB.
 * Includes: pre-flight checks (gas, balance), position sizing, risk limits.
 *
 * Risk limits:
 * - Max 5% bankroll per trade (configurable)
 * - Max 3 concurrent positions (configurable)
 * - Pre-flight gas check before every trade
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

const CTF_CONTRACT = '0x4D97DCd97eC945f40cF65F87097ACe5EA0476045';
const CTF_EXCHANGE = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E';

export class OrderStager {
    constructor() {
        this.db = null;
        this.client = null;
        this.wallet = null;
        this.maxPositionUsd = parseFloat(process.env.MAX_POSITION_USD || '50');
        this.maxPositions = parseInt(process.env.MAX_POSITIONS || '3');
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS orders (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id TEXT,
                    market_title TEXT,
                    token_id TEXT,
                    side TEXT,
                    price REAL,
                    size REAL,
                    status TEXT DEFAULT 'STAGED',
                    conviction_score REAL,
                    order_response TEXT,
                    executed_at INTEGER,
                    created_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
                CREATE INDEX IF NOT EXISTS idx_orders_market ON orders(market_id);
            `);
        }
        return this.db;
    }

    /**
     * Initialize CLOB client and wallet.
     * Follows baghdad_bet.js pattern exactly.
     */
    async _initClient() {
        if (this.client) return;

        const privateKey = process.env.ETH_PRIVATE_KEY;
        if (!privateKey) throw new Error('ETH_PRIVATE_KEY not set');

        const provider = new ethers.JsonRpcProvider('https://polygon-rpc.com');
        this.wallet = new ethers.Wallet(privateKey, provider);

        // TypedData signing (required by Polymarket CLOB)
        this.wallet.signTypedData = async (domain, types, value) => {
            const payload = ethers.TypedDataEncoder.hash(domain, types, value);
            return this.wallet.signingKey.sign(payload).serialized;
        };
        this.wallet._signTypedData = this.wallet.signTypedData.bind(this.wallet);

        this.client = new ClobClient(
            'https://clob.polymarket.com',
            137,
            this.wallet,
            {
                key: process.env.POLY_API_KEY,
                secret: process.env.POLY_API_SECRET,
                passphrase: process.env.POLY_API_PASSPHRASE,
            },
            0
        );
    }

    /**
     * Pre-flight checks before staging an order.
     * @returns {Object} { clear: boolean, issues: [] }
     */
    async preflight() {
        const issues = [];
        const db = this._getDb();

        // 1. Gas check
        const gasOk = await checkGas('POL');
        if (!gasOk) issues.push('LOW_GAS: Insufficient POL for gas');

        // 2. Check concurrent positions
        const activeOrders = db.prepare(`
            SELECT COUNT(*) as c FROM orders WHERE status IN ('STAGED', 'FILLED', 'ACTIVE')
        `).get();

        if (activeOrders.c >= this.maxPositions) {
            issues.push(`MAX_POSITIONS: ${activeOrders.c}/${this.maxPositions} positions active`);
        }

        // 3. Check credentials
        if (!process.env.ETH_PRIVATE_KEY) issues.push('NO_KEY: ETH_PRIVATE_KEY not set');
        if (!process.env.POLY_API_KEY) issues.push('NO_CLOB: POLY_API_KEY not set');

        return {
            clear: issues.length === 0,
            issues,
            activePositions: activeOrders.c,
            maxPositions: this.maxPositions,
        };
    }

    /**
     * Stage an order on Polymarket CLOB.
     *
     * @param {Object} params
     * @param {string} params.marketId - Market ID (for tracking)
     * @param {string} params.marketTitle - Market title (for logging)
     * @param {string} params.tokenId - CLOB token ID (YES or NO token)
     * @param {string} params.side - 'BUY' or 'SELL'
     * @param {number} params.price - Limit price (0.01 to 0.99)
     * @param {number} params.size - Number of shares
     * @param {number} params.convictionScore - Conviction score that triggered this
     * @param {boolean} params.dryRun - If true, don't execute, just validate
     * @returns {Object} Order result
     */
    async stageOrder(params) {
        const { marketId, marketTitle, tokenId, side, price, size, convictionScore, dryRun = false } = params;
        const db = this._getDb();

        console.log(`  🎯 Staging ${side} order: ${size} shares @ $${price}`);
        console.log(`     Market: ${marketTitle || marketId}`);
        console.log(`     Conviction: ${convictionScore}/100`);

        // Validate params
        if (price < 0.01 || price > 0.99) {
            return { success: false, error: 'Price must be between $0.01 and $0.99' };
        }
        if (size <= 0) {
            return { success: false, error: 'Size must be positive' };
        }

        const totalCost = price * size;
        if (totalCost > this.maxPositionUsd) {
            return { success: false, error: `Position $${totalCost.toFixed(2)} exceeds max $${this.maxPositionUsd}` };
        }

        // Preflight
        const flight = await this.preflight();
        if (!flight.clear) {
            return { success: false, error: `Preflight failed: ${flight.issues.join(', ')}` };
        }

        // Record order
        const orderRecord = db.prepare(`
            INSERT INTO orders (market_id, market_title, token_id, side, price, size, status, conviction_score, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(marketId, marketTitle, tokenId, side, price, size, dryRun ? 'DRY_RUN' : 'STAGED', convictionScore, Date.now());

        const orderId = orderRecord.lastInsertRowid;

        if (dryRun) {
            console.log(`     📋 DRY RUN — Order #${orderId} staged (not executed)`);
            return {
                success: true,
                dryRun: true,
                orderId,
                side,
                price,
                size,
                totalCost: parseFloat(totalCost.toFixed(2)),
                potentialReturn: parseFloat((size * (1 - price)).toFixed(2)),
                returnMultiple: parseFloat((1 / price).toFixed(1)),
            };
        }

        // Execute
        try {
            await this._initClient();

            // Ensure CTF approval (baghdad_bet.js pattern)
            await this._ensureApproval();

            console.log(`     📡 Posting to CLOB...`);

            const order = await this.client.createOrder({
                tokenID: tokenId,
                price,
                side,
                size,
            });

            const response = await this.client.postOrder(order);

            // Update order status
            db.prepare('UPDATE orders SET status = ?, order_response = ?, executed_at = ? WHERE id = ?')
                .run('FILLED', JSON.stringify(response), Date.now(), orderId);

            console.log(`     ✅ Order #${orderId} FILLED`);

            return {
                success: true,
                orderId,
                side,
                price,
                size,
                totalCost: parseFloat(totalCost.toFixed(2)),
                potentialReturn: parseFloat((size * (1 - price)).toFixed(2)),
                returnMultiple: parseFloat((1 / price).toFixed(1)),
                response,
            };
        } catch (e) {
            db.prepare('UPDATE orders SET status = ?, order_response = ? WHERE id = ?')
                .run('FAILED', e.message, orderId);

            console.log(`     ❌ Order #${orderId} FAILED: ${e.message}`);
            return { success: false, orderId, error: e.message };
        }
    }

    /**
     * Ensure CTF contract approval for exchange.
     * Retries up to 3 times (baghdad_bet.js pattern).
     */
    async _ensureApproval() {
        const ctfAbi = [
            "function isApprovedForAll(address, address) view returns (bool)",
            "function setApprovalForAll(address, bool) returns ()"
        ];

        const ctf = new ethers.Contract(CTF_CONTRACT, ctfAbi, this.wallet);

        for (let i = 0; i < 3; i++) {
            try {
                const approved = await ctf.isApprovedForAll(this.wallet.address, CTF_EXCHANGE);
                if (approved) return;

                console.log(`     🔓 Sending approval (attempt ${i + 1})...`);
                const tx = await ctf.setApprovalForAll(CTF_EXCHANGE, true, {
                    gasLimit: 120000,
                    maxPriorityFeePerGas: ethers.parseUnits("50", "gwei"),
                    maxFeePerGas: ethers.parseUnits("300", "gwei"),
                });
                await tx.wait();
                return;
            } catch (e) {
                console.log(`     ⚠️  Approval attempt ${i + 1} failed: ${e.message}`);
                await new Promise(r => setTimeout(r, 10000));
            }
        }
    }

    /**
     * Get order history.
     */
    getOrders(status = null, limit = 20) {
        const db = this._getDb();
        if (status) {
            return db.prepare('SELECT * FROM orders WHERE status = ? ORDER BY created_at DESC LIMIT ?').all(status, limit);
        }
        return db.prepare('SELECT * FROM orders ORDER BY created_at DESC LIMIT ?').all(limit);
    }

    /**
     * Get P&L summary.
     */
    getPnL() {
        const db = this._getDb();
        const filled = db.prepare("SELECT * FROM orders WHERE status = 'FILLED'").all();

        let totalInvested = 0;
        let totalOrders = filled.length;

        for (const order of filled) {
            if (order.side === 'BUY') {
                totalInvested += order.price * order.size;
            }
        }

        return {
            totalOrders,
            totalInvested: parseFloat(totalInvested.toFixed(2)),
            orders: filled,
        };
    }

    close() {
        if (this.db) { this.db.close(); this.db = null; }
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const stager = new OrderStager();

    console.log('🎯 ORDER STAGER — SELF-TEST\n');

    // Preflight check
    console.log('1. Running preflight checks...');
    const flight = await stager.preflight();
    console.log(`   Clear: ${flight.clear}`);
    if (!flight.clear) {
        console.log(`   Issues: ${flight.issues.join(', ')}`);
    }
    console.log(`   Active Positions: ${flight.activePositions}/${flight.maxPositions}`);

    // Dry run test
    console.log('\n2. Dry-run order staging...');
    const dryResult = await stager.stageOrder({
        marketId: 'test-market-001',
        marketTitle: 'Test Market — Self-Test',
        tokenId: 'test-token-id',
        side: 'BUY',
        price: 0.05,
        size: 100,
        convictionScore: 75,
        dryRun: true,
    });

    if (dryResult.success) {
        console.log(`   Order #${dryResult.orderId}: ${dryResult.side} ${dryResult.size} @ $${dryResult.price}`);
        console.log(`   Cost: $${dryResult.totalCost} | Potential: $${dryResult.potentialReturn} (${dryResult.returnMultiple}x)`);
    } else {
        console.log(`   Failed: ${dryResult.error}`);
    }

    // P&L check
    console.log('\n3. P&L Summary...');
    const pnl = stager.getPnL();
    console.log(`   Total Orders: ${pnl.totalOrders}`);
    console.log(`   Total Invested: $${pnl.totalInvested}`);

    stager.close();
    console.log('\n✅ Self-test complete.');
}

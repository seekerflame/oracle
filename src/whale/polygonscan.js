import 'dotenv/config';
import fetch from 'node-fetch';
import { fileURLToPath } from 'url';

/**
 * Oracle Truth Machine — Polygonscan API Connector
 *
 * Public blockchain explorer API for Polygon network.
 * Follows coingecko.js pattern: rate limiting, retry on 429, class-based.
 *
 * Provides: transaction history, token transfers, wallet balances.
 * All data is PUBLIC on-chain data — this is transparency, not surveillance.
 *
 * Free tier: 5 calls/sec, 100k calls/day.
 */

const BASE_URL = 'https://api.etherscan.io/v2/api';

// Multi-RPC fallback (gas_sentinel.js pattern)
const POLYGON_RPCS = [
    'https://polygon-rpc.com',
    'https://polygon.drpc.org',
    'https://1rpc.io/poly',
];

export class PolygonscanConnector {
    constructor() {
        this.apiKey = process.env.POLYGONSCAN_API_KEY || '';
        this.lastRequest = 0;
        this.minInterval = 250; // 250ms = 4 calls/sec (under 5/sec limit)
        this.chainId = 137; // Polygon Mainnet
    }

    // ─── Rate-limited fetch ───────────────────────────────────────

    async _fetch(params) {
        const now = Date.now();
        const elapsed = now - this.lastRequest;
        if (elapsed < this.minInterval) {
            await new Promise(r => setTimeout(r, this.minInterval - elapsed));
        }
        this.lastRequest = Date.now();

        const queryParams = new URLSearchParams({
            ...params,
            chainid: this.chainId,
            apikey: this.apiKey,
        });

        const url = `${BASE_URL}?${queryParams}`;
        const response = await fetch(url, {
            headers: { 'Accept': 'application/json' }
        });

        if (response.status === 429) {
            console.log('  ⏳ Polygonscan rate limited. Waiting 5s...');
            await new Promise(r => setTimeout(r, 5000));
            return this._fetch(params);
        }

        if (!response.ok) {
            throw new Error(`Polygonscan ${response.status}: ${response.statusText}`);
        }

        const data = await response.json();

        if (data.status === '0' && data.message === 'NOTOK') {
            throw new Error(`Polygonscan error: ${data.result}`);
        }

        return data.result;
    }

    // ─── API Methods ──────────────────────────────────────────────

    /**
     * Get normal transaction list for an address.
     * @param {string} address - Wallet address
     * @param {number} startBlock - Start block (0 for genesis)
     * @param {string} sort - 'asc' or 'desc'
     * @param {number} page - Page number
     * @param {number} offset - Results per page (max 10000)
     * @returns {Array} Transaction objects
     */
    async getTxHistory(address, startBlock = 0, sort = 'desc', page = 1, offset = 100) {
        return this._fetch({
            module: 'account',
            action: 'txlist',
            address,
            startblock: startBlock,
            endblock: 99999999,
            page,
            offset,
            sort,
        });
    }

    /**
     * Get ERC20 token transfers for an address.
     * @param {string} address - Wallet address
     * @param {number} startBlock - Start block
     * @returns {Array} Token transfer objects
     */
    async getTokenTransfers(address, startBlock = 0) {
        return this._fetch({
            module: 'account',
            action: 'tokentx',
            address,
            startblock: startBlock,
            endblock: 99999999,
            sort: 'desc',
            page: 1,
            offset: 100,
        });
    }

    /**
     * Get ERC1155 token transfers (used by Polymarket CTF).
     * @param {string} address - Wallet address
     * @param {number} startBlock - Start block
     * @returns {Array} Transfer objects
     */
    async getERC1155Transfers(address, startBlock = 0) {
        return this._fetch({
            module: 'account',
            action: 'token1155tx',
            address,
            startblock: startBlock,
            endblock: 99999999,
            sort: 'desc',
            page: 1,
            offset: 100,
        });
    }

    /**
     * Get native token (POL/MATIC) balance.
     * @param {string} address - Wallet address
     * @returns {string} Balance in wei
     */
    async getBalance(address) {
        return this._fetch({
            module: 'account',
            action: 'balance',
            address,
            tag: 'latest',
        });
    }

    /**
     * Get internal transactions (contract calls).
     * Useful for tracing fund flows through contracts.
     * @param {string} address - Wallet address
     * @returns {Array} Internal transaction objects
     */
    async getInternalTx(address) {
        return this._fetch({
            module: 'account',
            action: 'txlistinternal',
            address,
            startblock: 0,
            endblock: 99999999,
            sort: 'desc',
            page: 1,
            offset: 100,
        });
    }

    // ─── Helpers ──────────────────────────────────────────────────

    /**
     * Get the first transaction (creation/funding) for an address.
     * Reveals who originally funded this wallet.
     * @param {string} address
     * @returns {Object|null} First transaction
     */
    async getGenesisTransaction(address) {
        const txs = await this.getTxHistory(address, 0, 'asc', 1, 1);
        return Array.isArray(txs) && txs.length > 0 ? txs[0] : null;
    }

    /**
     * Get unique addresses that sent funds TO this address.
     * @param {string} address
     * @returns {Array} Unique sender addresses with amounts
     */
    async getFundingSources(address) {
        const txs = await this.getTxHistory(address, 0, 'asc', 1, 500);
        if (!Array.isArray(txs)) return [];

        const senders = {};
        for (const tx of txs) {
            if (tx.to?.toLowerCase() === address.toLowerCase() && tx.value !== '0') {
                const from = tx.from.toLowerCase();
                if (!senders[from]) {
                    senders[from] = { address: from, totalWei: BigInt(0), txCount: 0, firstSeen: tx.timeStamp };
                }
                senders[from].totalWei += BigInt(tx.value);
                senders[from].txCount++;
            }
        }

        return Object.values(senders).map(s => ({
            address: s.address,
            totalPOL: parseFloat((Number(s.totalWei) / 1e18).toFixed(4)),
            txCount: s.txCount,
            firstSeen: new Date(parseInt(s.firstSeen) * 1000).toISOString(),
        })).sort((a, b) => b.totalPOL - a.totalPOL);
    }

    /**
     * Get unique addresses this wallet sent funds TO.
     * @param {string} address
     * @returns {Array} Unique recipient addresses with amounts
     */
    async getFundingTargets(address) {
        const txs = await this.getTxHistory(address, 0, 'asc', 1, 500);
        if (!Array.isArray(txs)) return [];

        const recipients = {};
        for (const tx of txs) {
            if (tx.from?.toLowerCase() === address.toLowerCase() && tx.value !== '0') {
                const to = tx.to?.toLowerCase();
                if (!to) continue;
                if (!recipients[to]) {
                    recipients[to] = { address: to, totalWei: BigInt(0), txCount: 0 };
                }
                recipients[to].totalWei += BigInt(tx.value);
                recipients[to].txCount++;
            }
        }

        return Object.values(recipients).map(r => ({
            address: r.address,
            totalPOL: parseFloat((Number(r.totalWei) / 1e18).toFixed(4)),
            txCount: r.txCount,
        })).sort((a, b) => b.totalPOL - a.totalPOL);
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const ps = new PolygonscanConnector();

    console.log('🔍 POLYGONSCAN CONNECTOR — SELF-TEST\n');

    // Use a known Polymarket-related address if available
    const testAddr = process.env.ETH_WALLET_ADDRESS || '0x0000000000000000000000000000000000000000';

    if (testAddr === '0x0000000000000000000000000000000000000000') {
        console.log('  ⚠️  No ETH_WALLET_ADDRESS set. Set it in .env to test with a real wallet.');
        console.log('  Testing API connectivity with zero address...\n');
    }

    try {
        // Test 1: Get balance
        console.log('1. Checking balance...');
        const balance = await ps.getBalance(testAddr);
        const polBalance = (parseInt(balance) / 1e18).toFixed(4);
        console.log(`   Balance: ${polBalance} POL\n`);

        // Test 2: Get recent transactions
        console.log('2. Fetching recent transactions...');
        const txs = await ps.getTxHistory(testAddr, 0, 'desc', 1, 5);
        if (Array.isArray(txs) && txs.length > 0) {
            console.log(`   Found ${txs.length} transactions:`);
            for (const tx of txs.slice(0, 3)) {
                const val = (parseInt(tx.value) / 1e18).toFixed(4);
                const dir = tx.from.toLowerCase() === testAddr.toLowerCase() ? 'OUT' : 'IN';
                console.log(`   ${dir} ${val} POL — ${new Date(tx.timeStamp * 1000).toISOString()}`);
            }
        } else {
            console.log('   No transactions found');
        }

        // Test 3: Genesis transaction
        console.log('\n3. Finding genesis (first) transaction...');
        const genesis = await ps.getGenesisTransaction(testAddr);
        if (genesis) {
            console.log(`   First funded by: ${genesis.from}`);
            console.log(`   Date: ${new Date(genesis.timeStamp * 1000).toISOString()}`);
            console.log(`   Amount: ${(parseInt(genesis.value) / 1e18).toFixed(4)} POL`);
        }

        // Test 4: Funding sources
        console.log('\n4. Mapping funding sources...');
        const sources = await ps.getFundingSources(testAddr);
        console.log(`   ${sources.length} unique funding sources:`);
        for (const s of sources.slice(0, 5)) {
            console.log(`   ${s.address.slice(0, 10)}... → ${s.totalPOL} POL (${s.txCount} txs)`);
        }
    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
        if (!ps.apiKey) {
            console.log('  💡 Set POLYGONSCAN_API_KEY in .env for API access');
        }
    }

    console.log('\n✅ Self-test complete.');
}

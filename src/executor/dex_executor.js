import 'dotenv/config';
/**
 * Oracle Trading Engine — Jupiter DEX Auto-Executor
 * 
 * NON-KYC | SELF-CUSTODIAL | YOUR KEYS = YOUR COINS
 * 
 * Automated trading on Jupiter (Solana DEX):
 * - Monitors RSI signals on your coins via CoinGecko
 * - RSI < 20 → BUY (panic buying = max alpha)
 * - RSI > 80 → SELL (euphoria selling = lock profits)
 * - All trades go through Jupiter aggregator for best price
 * - No middleman, no KYC, no tracking
 * 
 * Modes:
 *   --dry-run     Show what would trade, don't execute
 *   --live        Execute real swaps (CAREFUL)
 *   --loop        Run continuously, check every 15min
 * 
 * Usage:
 *   node src/executor/dex_executor.js --dry-run
 *   node src/executor/dex_executor.js --live --loop
 */

import { Connection, Keypair, VersionedTransaction } from '@solana/web3.js';
import { CoinGeckoConnector } from '../data/coingecko.js';
import { Indicators } from '../analysis/indicators.js';
import { readFileSync, appendFileSync, existsSync, mkdirSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const LOG_DIR = resolve(__dirname, '../../data/logs');
mkdirSync(LOG_DIR, { recursive: true });

// ─── Solana Token Mints (for Jupiter) ────────────────────────

const MINTS = {
    SOL: 'So11111111111111111111111111111111111111112',
    USDC: 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v',
    USDT: 'Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB',
    MAGIC: '7dgHoN8wBZCc5wbnQ2C47TDnBMAxG4Q5L3KjP67z8kNi', // MAGIC on Solana (wrapped)
    BONK: 'DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263',
    JTO: 'jtojtomepa8beP8AuQc6eXt5FriJwfFMwQx2v2f9mCL',
    WIF: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm',
    JUP: 'JUPyiwrYJFskUPiHa7hkeR8VUtAeFoSYbKedZNsDvCN',
    RAY: '4k3Dyjzvzp8eMZWUXbBCjEvwSkkk59S5iCNLY3QrkX6R',
};

// ─── Strategy Configuration ──────────────────────────────────

const STRATEGIES = {
    RSI_EXTREME: {
        name: 'RSI Extreme',
        buySignal: (rsi) => rsi.length > 0 && rsi[rsi.length - 1] < 25,
        sellSignal: (rsi) => rsi.length > 0 && rsi[rsi.length - 1] > 75,
        description: 'Buy at RSI < 25 (panic), sell at RSI > 75 (euphoria)',
    },
    MOMENTUM: {
        name: 'Momentum',
        buySignal: (rsi, ema20, ema50) => {
            if (!ema20?.length || !ema50?.length) return false;
            return ema20[ema20.length - 1] > ema50[ema50.length - 1] && rsi[rsi.length - 1] < 60;
        },
        sellSignal: (rsi, ema20, ema50) => {
            if (!ema20?.length || !ema50?.length) return false;
            return ema20[ema20.length - 1] < ema50[ema50.length - 1];
        },
        description: 'Buy when EMA20 > EMA50 (trend up), sell when it crosses down',
    },
};

class DexExecutor {
    constructor(options = {}) {
        this.dryRun = options.dryRun !== false; // Default to dry-run for safety
        this.strategy = options.strategy || 'RSI_EXTREME';
        this.scalp = options.scalp === true;
        this.cg = new CoinGeckoConnector();
        this.connection = new Connection(
            process.env.SOLANA_RPC_URL || 'https://api.mainnet-beta.solana.com'
        );

        // Load wallet if available
        if (process.env.SOLANA_PRIVATE_KEY) {
            try {
                const keyBytes = Buffer.from(process.env.SOLANA_PRIVATE_KEY, 'hex');
                this.wallet = Keypair.fromSecretKey(new Uint8Array(keyBytes));
                this.walletAddress = this.wallet.publicKey.toBase58();
            } catch (e) {
                console.log('  ⚠️ Could not load Solana wallet from .env');
                this.wallet = null;
            }
        }

        // Trading parameters
        this.maxTradeUSD = options.maxTradeUSD || 1.0; // Scaled down for Nano-Trades
        this.minTradeSOL = 0.005; // ~ $0.90
        this.slippageBps = options.slippageBps || 100;  // 1% slippage tolerance

        // 🥷 Ninja Mode (1m Candles, RSI 7)
        this.ninja = options.ninja === true;
        this.rsiPeriod = this.ninja ? 7 : 14;
        this.interval = this.ninja ? '1m' : '15m';
    }

    /**
     * Get a swap quote from Jupiter.
     */
    async getQuote(inputMint, outputMint, amountLamports) {
        const url = `https://quote-api.jup.ag/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amountLamports}&slippageBps=${this.slippageBps}`;

        const response = await fetch(url);
        if (!response.ok) throw new Error(`Jupiter quote failed: ${response.status}`);
        return response.json();
    }

    /**
     * Execute a swap on Jupiter.
     */
    async executeSwap(quote) {
        if (this.dryRun || !this.wallet) {
            return { status: 'DRY_RUN', quote };
        }

        try {
            // Get swap transaction from Jupiter
            const swapResponse = await fetch('https://quote-api.jup.ag/v6/swap', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                    quoteResponse: quote,
                    userPublicKey: this.walletAddress,
                    wrapAndUnwrapSol: true,
                }),
            });

            const { swapTransaction } = await swapResponse.json();

            // Deserialize and sign
            const txBuf = Buffer.from(swapTransaction, 'base64');
            const tx = VersionedTransaction.deserialize(txBuf);
            tx.sign([this.wallet]);

            // Send transaction
            const txId = await this.connection.sendTransaction(tx, {
                skipPreflight: true,
                maxRetries: 3,
            });

            // Confirm
            const confirmation = await this.connection.confirmTransaction(txId, 'confirmed');

            return {
                status: 'EXECUTED',
                txId,
                confirmation,
                explorer: `https://solscan.io/tx/${txId}`,
            };
        } catch (e) {
            return { status: 'FAILED', error: e.message };
        }
    }

    /**
     * Check signals for a coin and decide whether to trade.
     */
    async checkAndTrade(coinId, inputMint, outputMint) {
        try {
            // Ninja Mode: Pulse-check 1m candles for hyper-scalping
            const interval = this.ninja ? '1m' : (this.scalp ? '15m' : '1h');
            const rsiPeriod = this.ninja ? 7 : 14;

            console.log(`  🔍 Scanning ${coinId} [Mode: ${this.ninja ? 'Ninja' : 'Standard'}]...`);

            const period = this.scalp || this.ninja ? 30 : 90;
            const bars = await this.cg.getOHLCV(coinId, period);
            if (bars.length < rsiPeriod) return null;

            const closes = bars.map(b => b.close);
            const rsi = Indicators.rsi(closes, rsiPeriod);

            const strat = STRATEGIES[this.strategy];
            const latestRSI = rsi.length > 0 ? rsi[rsi.length - 1] : 50;
            const price = closes[closes.length - 1];

            let action = 'HOLD';

            // Adjust boundaries for scalping
            const buyThreshold = this.scalp ? 20 : 25;
            const sellThreshold = this.scalp ? 80 : 75;
            const stopLossPct = this.stopLossPct || 5; // Default 5% stop loss

            // Setup trade parameters if signaling
            let fromMint, toMint, amount;

            // Simplified Stop Loss Logic (Requires tracking entry price)
            // For now, we'll check if we are in a position and if price is significantly down from recent bars
            const maxPrice = Math.max(...closes.slice(-10));
            const drawdown = (maxPrice - price) / maxPrice * 100;

            if (latestRSI < buyThreshold) {
                action = 'BUY';
            } else if (latestRSI > sellThreshold) {
                action = 'SELL';
            } else if (drawdown > stopLossPct) {
                action = 'SELL';
                console.log(`  🛑 STOP LOSS TRIGGERED: Down ${drawdown.toFixed(2)}% from peak`);
            }
            if (action === 'BUY') {
                fromMint = MINTS.USDC;
                toMint = inputMint;
                amount = Math.floor(this.maxTradeUSD * 1e6); // 6 decimals
            } else if (action === 'SELL') {
                // To do: get balance from chain
                fromMint = inputMint;
                toMint = MINTS.USDC;
                amount = null;
            }

            const signal = {
                coinId,
                price,
                rsi: latestRSI,
                action,
                strategy: strat.name + (this.scalp ? ' (Scalp)' : ''),
                timestamp: new Date().toISOString(),
            };

            // Execute if we have a trade signal
            if (action !== 'HOLD' && amount) {
                try {
                    const quote = await this.getQuote(fromMint, toMint, amount);
                    const result = await this.executeSwap(quote);
                    signal.execution = result;

                    // 🥷 NINJA STACKING: If it was a win, move 50% to Hedge
                    if (action === 'SELL' && result.status === 'SUCCESS') {
                        console.log('  🥷 NINJA STACK: Compounding 50% profit into Hedge (MAGIC/ETH)...');
                        // Logic to bridge/swap 50% of USDC output to Arbitrum/Hedge
                    }
                } catch (e) {
                    signal.execution = { status: 'QUOTE_FAILED', error: e.message };
                }
            }

            // Log the signal
            this._log(signal);

            return signal;
        } catch (e) {
            return { coinId, action: 'ERROR', error: e.message };
        }
    }

    /**
     * Scan all configured coins and trade.
     */
    async scan() {
        const mode = this.dryRun ? '🧪 DRY RUN' : '🔴 LIVE TRADING';
        console.log(`\n⚡ DEX AUTO-EXECUTOR — ${mode}`);
        console.log(`  Strategy: ${STRATEGIES[this.strategy].name}`);
        console.log(`  ${STRATEGIES[this.strategy].description}`);
        console.log(`  Max trade: $${this.maxTradeUSD}`);
        console.log(`  Wallet: ${this.walletAddress || 'not loaded'}`);
        console.log('═'.repeat(60) + '\n');

        // Coins to monitor (CoinGecko ID → Solana mint)
        const watchlist = [
            // Blue Chips
            { coinId: 'solana', mint: MINTS.SOL, ticker: 'SOL' },
            { coinId: 'jupiter-exchange-solana', mint: MINTS.JUP, ticker: 'JUP' },
            // High-Alpha Memecoins (25% Allocation)
            { coinId: 'dogwifhat', mint: 'EKpQGSJtjMFqKZ9KQanSqYXRcF8fBopzLHYxdM65zcjm', ticker: 'WIF' },
            { coinId: 'popcat', mint: '7GCihgDB8fe6KNjn2MYtkzZcRjQy3t9GHdC8uHYmW2hr', ticker: 'POPCAT' },
            { coinId: 'bonk', mint: MINTS.BONK, ticker: 'BONK' },
            { coinId: 'fartcoin', mint: '9BB6NFEcjBCtnNLFko2FqVQBq8HHM13kCyYcdQbgpump', ticker: 'FARTCOIN' }
        ];

        const signals = [];

        for (const coin of watchlist) {
            const signal = await this.checkAndTrade(coin.coinId, coin.mint, MINTS.USDC);

            if (signal) {
                const icon = { 'BUY': '🟢', 'SELL': '🔴', 'HOLD': '⚪', 'ERROR': '❌' }[signal.action] || '⚪';
                const rsiStr = signal.rsi ? `RSI: ${signal.rsi.toFixed(0)}` : '';
                console.log(`  ${icon} ${coin.ticker.padEnd(6)} $${signal.price?.toFixed(4).padStart(10) || 'N/A'} | ${rsiStr.padEnd(10)} | ${signal.action}`);

                if (signal.execution) {
                    const exec = signal.execution;
                    if (exec.status === 'DRY_RUN') {
                        console.log(`         → Would ${signal.action} $${this.maxTradeUSD} via Jupiter`);
                    } else if (exec.status === 'EXECUTED') {
                        console.log(`         → ✅ EXECUTED: ${exec.explorer}`);
                    } else if (exec.status === 'QUOTE_FAILED') {
                        console.log(`         → ⚠️ Quote failed: ${exec.error?.slice(0, 60)}`);
                    }
                }

                signals.push(signal);
            }

            // Rate limit between coin checks
            await new Promise(r => setTimeout(r, 5000));
        }

        console.log('\n' + '═'.repeat(60));
        const buys = signals.filter(s => s.action === 'BUY').length;
        const sells = signals.filter(s => s.action === 'SELL').length;
        console.log(`  Signals: ${buys} BUY | ${sells} SELL | ${signals.length - buys - sells} HOLD`);
        console.log('═'.repeat(60) + '\n');

        return signals;
    }

    /**
     * Run in loop mode — check every interval.
     */
    async loop(intervalMinutes = 15) {
        console.log(`  🔁 Loop mode: checking every ${intervalMinutes} minutes`);
        console.log('  Press Ctrl+C to stop\n');

        while (true) {
            await this.scan();
            console.log(`  ⏰ Next check in ${intervalMinutes} minutes...\n`);
            await new Promise(r => setTimeout(r, intervalMinutes * 60 * 1000));
        }
    }

    _log(signal) {
        const logFile = resolve(LOG_DIR, `trades_${new Date().toISOString().split('T')[0]}.log`);
        const line = `${signal.timestamp} | ${signal.coinId} | ${signal.action} | RSI:${signal.rsi?.toFixed(0) || '?'} | $${signal.price?.toFixed(4) || '?'} | ${signal.execution?.status || 'no_trade'}\n`;
        appendFileSync(logFile, line);
    }
}

export { DexExecutor, MINTS, STRATEGIES };

// ─── CLI Entry Point ──────────────────────────────────────────

if (process.argv[1]?.endsWith('dex_executor.js')) {
    const args = process.argv.slice(2);
    const executor = new DexExecutor({
        dryRun: !args.includes('--live'),
        strategy: args.includes('--momentum') ? 'MOMENTUM' : 'RSI_EXTREME',
        scalp: args.includes('--scalp'),
        maxTradeUSD: parseInt(args.find((_, i) => args[i - 1] === '--max') || '50'),
    });

    if (args.includes('--loop')) {
        const interval = parseInt(args.find((_, i) => args[i - 1] === '--interval') || '15');
        await executor.loop(interval);
    } else {
        await executor.scan();
    }
}

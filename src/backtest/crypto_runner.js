import 'dotenv/config';
/**
 * Oracle Trading Engine — Crypto Backtester
 * 
 * Deep backtests on top 50 crypto coins using CoinGecko OHLCV data.
 * Crypto is 24/7 — no market hours, no waiting.
 * 
 * Usage:
 *   node src/backtest/crypto_runner.js                    # Top 15 coins, all strategies
 *   node src/backtest/crypto_runner.js --top 50           # Top 50 coins
 *   node src/backtest/crypto_runner.js --coin bitcoin     # Specific coin
 *   node src/backtest/crypto_runner.js --period 365       # 1 year
 */

import { CoinGeckoConnector, COIN_TICKERS } from '../data/coingecko.js';
import { Indicators } from '../analysis/indicators.js';

// ─── Crypto-Optimized Strategies ─────────────────────────────────
// Crypto is more volatile than stocks, so thresholds are adjusted.

const STRATEGIES = {
    momentum: {
        name: 'Momentum',
        description: 'Buy on RSI bounce from oversold + positive MACD histogram',
        analyze(bars, i, ind) {
            const rsiIdx = i - (bars.length - ind.rsi.length);
            const macdIdx = i - (bars.length - ind.macd.length);
            if (rsiIdx < 1 || macdIdx < 0) return null;

            const rsi = ind.rsi[rsiIdx];
            const prevRsi = ind.rsi[rsiIdx - 1];
            const macd = ind.macd[macdIdx];

            if (prevRsi < 35 && rsi >= 35 && macd?.histogram > 0) return 'BUY';
            if (rsi > 75) return 'SELL';
            return null;
        }
    },

    mean_reversion: {
        name: 'Mean Reversion',
        description: 'Buy at Bollinger lower band, sell at upper',
        analyze(bars, i, ind) {
            const bbIdx = i - (bars.length - ind.bb.length);
            if (bbIdx < 0) return null;

            const price = bars[i].close;
            const band = ind.bb[bbIdx];

            if (price <= band.lower) return 'BUY';
            if (price >= band.upper) return 'SELL';
            return null;
        }
    },

    ema_crossover: {
        name: 'EMA Crossover',
        description: 'Golden cross (EMA12 > EMA26), death cross sell',
        analyze(bars, i, ind) {
            // Use faster EMAs for crypto (12/26 instead of 20/50)
            const idx12 = i - (bars.length - ind.ema12.length);
            const idx26 = i - (bars.length - ind.ema26.length);
            if (idx12 < 1 || idx26 < 1) return null;

            const curr12 = ind.ema12[idx12];
            const prev12 = ind.ema12[idx12 - 1];
            const curr26 = ind.ema26[idx26];
            const prev26 = ind.ema26[idx26 - 1];

            if (prev12 <= prev26 && curr12 > curr26) return 'BUY';
            if (prev12 >= prev26 && curr12 < curr26) return 'SELL';
            return null;
        }
    },

    rsi_extreme: {
        name: 'RSI Extreme',
        description: 'Buy deep oversold (RSI<20), sell extreme overbought (RSI>80)',
        analyze(bars, i, ind) {
            const rsiIdx = i - (bars.length - ind.rsi.length);
            if (rsiIdx < 0) return null;

            if (ind.rsi[rsiIdx] < 20) return 'BUY';
            if (ind.rsi[rsiIdx] > 80) return 'SELL';
            return null;
        }
    },

    breakout: {
        name: 'Breakout',
        description: 'Buy on volume spike + new 20-day high',
        analyze(bars, i, ind) {
            if (i < 20) return null;

            const price = bars[i].close;
            const highest20 = Math.max(...bars.slice(i - 20, i).map(b => b.high));
            const lowest20 = Math.min(...bars.slice(i - 20, i).map(b => b.low));

            // Breakout above 20-day high
            if (price > highest20) return 'BUY';
            // Breakdown below 20-day low
            if (price < lowest20) return 'SELL';
            return null;
        }
    },
};

// ─── Backtester Engine ───────────────────────────────────────────

class CryptoBacktester {
    constructor() {
        this.cg = new CoinGeckoConnector();
    }

    async run(strategyKey, coinId, days = 365, startingCapital = 1000) {
        const strategy = STRATEGIES[strategyKey];
        const ticker = COIN_TICKERS[coinId] || coinId.toUpperCase();

        // Fetch OHLCV data
        let bars;
        try {
            bars = await this.cg.getOHLCV(coinId, days);
        } catch (e) {
            console.log(`  ⚠️ ${ticker}: ${e.message}`);
            return null;
        }

        if (bars.length < 30) {
            return null; // Not enough data
        }

        // Pre-calculate indicators
        const closes = bars.map(b => b.close);
        const highs = bars.map(b => b.high);
        const lows = bars.map(b => b.low);

        const indicators = {
            rsi: Indicators.rsi(closes, 14),
            macd: Indicators.macd(closes, 12, 26, 9),
            bb: Indicators.bollingerBands(closes, 20, 2),
            ema12: Indicators.ema(closes, 12),
            ema26: Indicators.ema(closes, 26),
            atr: Indicators.atr(highs, lows, closes, 14),
        };

        // Simulate trades
        let capital = startingCapital;
        let position = null;
        let peakCapital = startingCapital;
        let maxDrawdown = 0;
        const trades = [];

        const startIdx = 30; // Skip warmup period

        for (let i = startIdx; i < bars.length; i++) {
            const bar = bars[i];
            const signal = strategy.analyze(bars, i, indicators);

            const atrIdx = i - (bars.length - indicators.atr.length);
            const currentATR = atrIdx >= 0 ? indicators.atr[atrIdx] : bar.close * 0.03;

            // Check stop-loss / take-profit
            if (position) {
                const risk = position.entryPrice - position.stopLoss;
                const takeProfit = position.entryPrice + (risk * 2.5); // Crypto: 2.5:1 R:R

                if (bar.low <= position.stopLoss) {
                    const pnl = (position.stopLoss - position.entryPrice) * position.qty;
                    capital += position.qty * position.stopLoss;
                    trades.push({
                        type: 'SELL (STOP)', date: bar.timestamp, price: position.stopLoss,
                        qty: position.qty, pnl,
                        pnlPct: ((position.stopLoss / position.entryPrice) - 1) * 100,
                    });
                    position = null;
                } else if (bar.high >= takeProfit) {
                    const pnl = (takeProfit - position.entryPrice) * position.qty;
                    capital += position.qty * takeProfit;
                    trades.push({
                        type: 'SELL (TP)', date: bar.timestamp, price: takeProfit,
                        qty: position.qty, pnl,
                        pnlPct: ((takeProfit / position.entryPrice) - 1) * 100,
                    });
                    position = null;
                } else if (signal === 'SELL') {
                    const pnl = (bar.close - position.entryPrice) * position.qty;
                    capital += position.qty * bar.close;
                    trades.push({
                        type: 'SELL (SIG)', date: bar.timestamp, price: bar.close,
                        qty: position.qty, pnl,
                        pnlPct: ((bar.close / position.entryPrice) - 1) * 100,
                    });
                    position = null;
                }
            }

            // BUY
            if (!position && signal === 'BUY') {
                const posSize = capital * 0.95;
                const qty = posSize / bar.close;
                if (qty > 0 && capital > 1) {
                    const stopLoss = bar.close - (2.5 * currentATR); // Wider stops for crypto
                    position = { qty, entryPrice: bar.close, entryDate: bar.timestamp, stopLoss };
                    capital -= qty * bar.close;
                    trades.push({ type: 'BUY', date: bar.timestamp, price: bar.close, qty, pnl: 0, pnlPct: 0 });
                }
            }

            // Track equity
            const equity = capital + (position ? position.qty * bar.close : 0);
            if (equity > peakCapital) peakCapital = equity;
            const dd = (peakCapital - equity) / peakCapital;
            if (dd > maxDrawdown) maxDrawdown = dd;
        }

        // Close remaining position
        if (position) {
            const lastPrice = bars[bars.length - 1].close;
            const pnl = (lastPrice - position.entryPrice) * position.qty;
            capital += position.qty * lastPrice;
            trades.push({
                type: 'SELL (END)', date: bars[bars.length - 1].timestamp, price: lastPrice,
                qty: position.qty, pnl, pnlPct: ((lastPrice / position.entryPrice) - 1) * 100,
            });
        }

        // Stats
        const sellTrades = trades.filter(t => t.type.startsWith('SELL'));
        const wins = sellTrades.filter(t => t.pnl > 0);
        const losses = sellTrades.filter(t => t.pnl <= 0);
        const totalReturn = ((capital - startingCapital) / startingCapital) * 100;
        const buyHoldReturn = ((bars[bars.length - 1].close - bars[startIdx].close) / bars[startIdx].close) * 100;
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPct, 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPct, 0) / losses.length : 0;

        return {
            strategy: strategy.name,
            coin: ticker,
            coinId,
            period: `${bars[0].timestamp?.split('T')[0]} → ${bars[bars.length - 1].timestamp?.split('T')[0]}`,
            bars: bars.length,
            startingCapital,
            endingCapital: Math.round(capital * 100) / 100,
            totalReturn: Math.round(totalReturn * 100) / 100,
            buyHoldReturn: Math.round(buyHoldReturn * 100) / 100,
            totalTrades: sellTrades.length,
            winRate: sellTrades.length > 0 ? Math.round((wins.length / sellTrades.length) * 100) : 0,
            avgWin: Math.round(avgWin * 100) / 100,
            avgLoss: Math.round(avgLoss * 100) / 100,
            maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
            latestPrice: bars[bars.length - 1].close,
            trades,
        };
    }

    /**
     * Deep scan: run all strategies on many coins and find the best opportunities.
     */
    async deepScan(coinIds, days = 365) {
        const allResults = [];
        const total = coinIds.length * Object.keys(STRATEGIES).length;
        let count = 0;

        console.log(`\n🔮 ORACLE CRYPTO DEEP SCAN`);
        console.log(`   ${coinIds.length} coins × ${Object.keys(STRATEGIES).length} strategies = ${total} backtests`);
        console.log(`   Period: ${days} days | Starting capital: $1,000 each\n`);

        for (const coinId of coinIds) {
            const ticker = COIN_TICKERS[coinId] || coinId;
            process.stdout.write(`  Scanning ${ticker.padEnd(6)}...`);

            for (const key of Object.keys(STRATEGIES)) {
                count++;
                const result = await this.run(key, coinId, days);
                if (result) allResults.push(result);
            }

            const coinResults = allResults.filter(r => r.coinId === coinId);
            const best = coinResults.sort((a, b) => b.totalReturn - a.totalReturn)[0];
            if (best) {
                const icon = best.totalReturn > 0 ? '📈' : '📉';
                console.log(` ${icon} Best: ${best.strategy} → ${best.totalReturn >= 0 ? '+' : ''}${best.totalReturn}% (${best.winRate}% win rate)`);
            } else {
                console.log(' ⚠️ Insufficient data');
            }
        }

        // Sort all results by return
        allResults.sort((a, b) => b.totalReturn - a.totalReturn);

        // ─── Summary Table ──────────────────────────────────────

        console.log('\n' + '═'.repeat(80));
        console.log(' 🏆 TOP 20 STRATEGY-COIN COMBINATIONS');
        console.log('═'.repeat(80));
        console.log(`\n  ${'Coin'.padEnd(7)} ${'Strategy'.padEnd(16)} ${'Return'.padStart(10)} ${'Win%'.padStart(6)} ${'Trades'.padStart(7)} ${'MaxDD'.padStart(8)} ${'vs HODL'.padStart(10)}`);
        console.log('  ' + '─'.repeat(70));

        for (const r of allResults.slice(0, 20)) {
            const beat = r.totalReturn > r.buyHoldReturn ? '✅' : '❌';
            const returnStr = (r.totalReturn >= 0 ? '+' : '') + r.totalReturn + '%';
            const hodlStr = (r.buyHoldReturn >= 0 ? '+' : '') + r.buyHoldReturn + '%';
            console.log(`  ${r.coin.padEnd(7)} ${r.strategy.padEnd(16)} ${returnStr.padStart(10)} ${(r.winRate + '%').padStart(6)} ${String(r.totalTrades).padStart(7)} ${(r.maxDrawdown + '%').padStart(8)} ${beat} ${hodlStr.padStart(7)}`);
        }

        // ─── Best Strategy Per Coin ─────────────────────────────

        console.log('\n' + '═'.repeat(80));
        console.log(' 💎 BEST STRATEGY PER COIN');
        console.log('═'.repeat(80));

        const seenCoins = new Set();
        const bestPerCoin = [];
        for (const r of allResults) {
            if (!seenCoins.has(r.coin)) {
                seenCoins.add(r.coin);
                bestPerCoin.push(r);
            }
        }
        bestPerCoin.sort((a, b) => b.totalReturn - a.totalReturn);

        for (const r of bestPerCoin.slice(0, 15)) {
            const icon = r.totalReturn > 0 ? '💰' : '📉';
            console.log(`  ${icon} ${r.coin.padEnd(7)} → ${r.strategy.padEnd(16)} ${(r.totalReturn >= 0 ? '+' : '') + r.totalReturn + '%'} ($1K → $${r.endingCapital.toLocaleString()})`);
        }

        // ─── Actionable Summary ─────────────────────────────────

        const profitable = allResults.filter(r => r.totalReturn > 10);
        const beating = allResults.filter(r => r.totalReturn > r.buyHoldReturn && r.totalReturn > 0);

        console.log(`\n${'─'.repeat(80)}`);
        console.log(`  📊 Total backtests: ${allResults.length}`);
        console.log(`  💚 Profitable (>10%): ${profitable.length}`);
        console.log(`  ✅ Beat buy & hold: ${beating.length}`);
        console.log(`  🏆 Best overall: ${allResults[0]?.coin} ${allResults[0]?.strategy} → +${allResults[0]?.totalReturn}%`);
        console.log('─'.repeat(80) + '\n');

        return allResults;
    }
}

// ─── CLI Entry Point ──────────────────────────────────────────

const args = process.argv.slice(2);
const bt = new CryptoBacktester();

const topArg = parseInt(args.find((_, i) => args[i - 1] === '--top') || '15');
const coinArg = args.find((_, i) => args[i - 1] === '--coin');
const periodArg = parseInt(args.find((_, i) => args[i - 1] === '--period') || '365');

if (coinArg) {
    // Single coin, all strategies
    console.log(`\n🔮 Backtesting ${coinArg} with all strategies...\n`);
    for (const key of Object.keys(STRATEGIES)) {
        const result = await bt.run(key, coinArg, periodArg);
        if (result) {
            const beat = result.totalReturn > result.buyHoldReturn ? '✅' : '❌';
            console.log(`  ${result.strategy.padEnd(16)} → ${result.totalReturn >= 0 ? '+' : ''}${result.totalReturn}% | Win: ${result.winRate}% | MaxDD: ${result.maxDrawdown}% | ${beat} HODL (${result.buyHoldReturn}%)`);
        }
    }
} else {
    // Deep scan
    const { TOP_50_COINS: coins } = await import('../data/coingecko.js');
    const targetCoins = coins.slice(0, topArg);
    await bt.deepScan(targetCoins, periodArg);
}

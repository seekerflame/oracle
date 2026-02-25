import 'dotenv/config';
/**
 * Oracle Trading Engine — Backtester
 * 
 * Proves strategies work on historical data BEFORE risking any money.
 * 
 * Usage:
 *   node src/backtest/runner.js                          # All strategies on default tickers
 *   node src/backtest/runner.js --strategy momentum      # Specific strategy
 *   node src/backtest/runner.js --symbol AAPL             # Specific ticker
 *   node src/backtest/runner.js --symbol NVDA --period 1y # Custom period
 * 
 * Outputs:
 *   - Win rate, total return, max drawdown
 *   - Trade log (every entry/exit with P&L)
 *   - Strategy comparison table
 */

import { AlpacaConnector } from '../data/alpaca.js';
import { Indicators } from '../analysis/indicators.js';

// ─── Strategy Definitions ────────────────────────────────────────

const STRATEGIES = {
    /**
     * MOMENTUM — Buy when RSI crosses above 30 with MACD bullish crossover.
     * Sell when RSI crosses above 70 or stop-loss/take-profit hit.
     */
    momentum: {
        name: 'Momentum',
        description: 'Buy oversold bounces with MACD confirmation',

        analyze(bars, i, indicators) {
            const { rsi, macd, ema20, ema50 } = indicators;
            const rsiIdx = i - (bars.length - rsi.length);
            const macdIdx = i - (bars.length - macd.length);
            const ema20Idx = i - (bars.length - ema20.length);
            const ema50Idx = i - (bars.length - ema50.length);

            if (rsiIdx < 1 || macdIdx < 1 || ema20Idx < 0 || ema50Idx < 0) return null;

            const currentRSI = rsi[rsiIdx];
            const prevRSI = rsi[rsiIdx - 1];
            const currentMACD = macd[macdIdx];
            const prevMACD = macd[macdIdx - 1];

            // BUY: RSI crossing up from below 30 + MACD histogram positive
            if (prevRSI < 30 && currentRSI >= 30 && currentMACD?.histogram > 0) {
                return 'BUY';
            }

            // SELL: RSI above 70
            if (currentRSI > 70) {
                return 'SELL';
            }

            return null;
        }
    },

    /**
     * MEAN REVERSION — Buy at Bollinger Band lower, sell at upper.
     */
    mean_reversion: {
        name: 'Mean Reversion',
        description: 'Buy at BB lower band, sell at BB upper band',

        analyze(bars, i, indicators) {
            const { bb } = indicators;
            const bbIdx = i - (bars.length - bb.length);
            if (bbIdx < 0) return null;

            const price = bars[i].close;
            const band = bb[bbIdx];

            // BUY: Price touches or breaks below lower band
            if (price <= band.lower) return 'BUY';

            // SELL: Price touches or breaks above upper band
            if (price >= band.upper) return 'SELL';

            return null;
        }
    },

    /**
     * EMA CROSSOVER — Buy when EMA20 crosses above EMA50, sell on cross below.
     */
    ema_crossover: {
        name: 'EMA Crossover',
        description: 'Buy on golden cross (EMA20 > EMA50), sell on death cross',

        analyze(bars, i, indicators) {
            const { ema20, ema50 } = indicators;
            const idx20 = i - (bars.length - ema20.length);
            const idx50 = i - (bars.length - ema50.length);

            if (idx20 < 1 || idx50 < 1) return null;

            const curr20 = ema20[idx20];
            const prev20 = ema20[idx20 - 1];
            const curr50 = ema50[idx50];
            const prev50 = ema50[idx50 - 1];

            // BUY: Golden cross (EMA20 crosses above EMA50)
            if (prev20 <= prev50 && curr20 > curr50) return 'BUY';

            // SELL: Death cross (EMA20 crosses below EMA50)
            if (prev20 >= prev50 && curr20 < curr50) return 'SELL';

            return null;
        }
    },

    /**
     * RSI DIVERGENCE — Buy RSI < 25 (deep oversold), sell RSI > 75.
     * More aggressive thresholds for bigger moves.
     */
    rsi_extreme: {
        name: 'RSI Extreme',
        description: 'Buy deep oversold (RSI<25), sell deep overbought (RSI>75)',

        analyze(bars, i, indicators) {
            const { rsi } = indicators;
            const rsiIdx = i - (bars.length - rsi.length);
            if (rsiIdx < 0) return null;

            if (rsi[rsiIdx] < 25) return 'BUY';
            if (rsi[rsiIdx] > 75) return 'SELL';

            return null;
        }
    },
};

// ─── Backtester Engine ───────────────────────────────────────────

class Backtester {
    constructor() {
        this.alpaca = new AlpacaConnector({ paper: true });
    }

    /**
     * Run a backtest for a strategy on a symbol.
     * @param {string} strategyKey - Key in STRATEGIES
     * @param {string} symbol - Stock ticker
     * @param {number} days - How many days of history
     * @param {number} startingCapital - Initial capital
     */
    async run(strategyKey, symbol, days = 500, startingCapital = 10000) {
        const strategy = STRATEGIES[strategyKey];
        if (!strategy) throw new Error(`Unknown strategy: ${strategyKey}`);

        console.log(`\n📈 Backtesting: ${strategy.name} on ${symbol} (${days} days, $${startingCapital.toLocaleString()})`);

        // Fetch historical data
        const bars = await this.alpaca.getBars(symbol, '1Day', days);
        if (bars.length < 60) {
            console.log(`  ⚠️ Only ${bars.length} bars available. Need 60+. Skipping.`);
            return null;
        }

        console.log(`  📊 Got ${bars.length} bars (${bars[0].timestamp?.split('T')[0]} → ${bars[bars.length - 1].timestamp?.split('T')[0]})`);

        // Pre-calculate all indicators
        const closes = bars.map(b => b.close);
        const highs = bars.map(b => b.high);
        const lows = bars.map(b => b.low);

        const indicators = {
            rsi: Indicators.rsi(closes, 14),
            macd: Indicators.macd(closes),
            bb: Indicators.bollingerBands(closes),
            ema20: Indicators.ema(closes, 20),
            ema50: Indicators.ema(closes, 50),
            atr: Indicators.atr(highs, lows, closes, 14),
        };

        // Simulate trades
        let capital = startingCapital;
        let position = null; // { shares, entryPrice, entryDate, stopLoss }
        let peakCapital = startingCapital;
        let maxDrawdown = 0;
        const trades = [];
        const equityCurve = [];

        for (let i = 60; i < bars.length; i++) {
            const bar = bars[i];
            const signal = strategy.analyze(bars, i, indicators);

            // Calculate ATR for stop-loss
            const atrIdx = i - (bars.length - indicators.atr.length);
            const currentATR = atrIdx >= 0 ? indicators.atr[atrIdx] : bar.close * 0.02;

            // Check stop-loss / take-profit if in position
            if (position) {
                const risk = position.entryPrice - position.stopLoss;
                const takeProfit = position.entryPrice + (risk * 3); // 3:1 R:R

                if (bar.low <= position.stopLoss) {
                    // Stop-loss hit
                    const pnl = (position.stopLoss - position.entryPrice) * position.shares;
                    capital += position.shares * position.stopLoss;
                    trades.push({
                        type: 'SELL (STOP)',
                        date: bar.timestamp,
                        price: position.stopLoss,
                        shares: position.shares,
                        pnl,
                        pnlPercent: ((position.stopLoss / position.entryPrice) - 1) * 100,
                        holdDays: Math.round((new Date(bar.timestamp) - new Date(position.entryDate)) / 86400000),
                    });
                    position = null;
                } else if (bar.high >= takeProfit) {
                    // Take-profit hit
                    const pnl = (takeProfit - position.entryPrice) * position.shares;
                    capital += position.shares * takeProfit;
                    trades.push({
                        type: 'SELL (TP)',
                        date: bar.timestamp,
                        price: takeProfit,
                        shares: position.shares,
                        pnl,
                        pnlPercent: ((takeProfit / position.entryPrice) - 1) * 100,
                        holdDays: Math.round((new Date(bar.timestamp) - new Date(position.entryDate)) / 86400000),
                    });
                    position = null;
                } else if (signal === 'SELL') {
                    // Strategy sell signal
                    const pnl = (bar.close - position.entryPrice) * position.shares;
                    capital += position.shares * bar.close;
                    trades.push({
                        type: 'SELL (SIGNAL)',
                        date: bar.timestamp,
                        price: bar.close,
                        shares: position.shares,
                        pnl,
                        pnlPercent: ((bar.close / position.entryPrice) - 1) * 100,
                        holdDays: Math.round((new Date(bar.timestamp) - new Date(position.entryDate)) / 86400000),
                    });
                    position = null;
                }
            }

            // BUY signal (only if not already in position)
            if (!position && signal === 'BUY') {
                const positionSize = Math.floor(capital * 0.95); // Use 95% of capital
                const shares = Math.floor(positionSize / bar.close);

                if (shares > 0) {
                    const stopLoss = bar.close - (2 * currentATR);
                    position = {
                        shares,
                        entryPrice: bar.close,
                        entryDate: bar.timestamp,
                        stopLoss,
                    };
                    capital -= shares * bar.close;

                    trades.push({
                        type: 'BUY',
                        date: bar.timestamp,
                        price: bar.close,
                        shares,
                        pnl: 0,
                        pnlPercent: 0,
                        stopLoss,
                    });
                }
            }

            // Track equity curve
            const equity = capital + (position ? position.shares * bar.close : 0);
            equityCurve.push({ date: bar.timestamp, equity });

            if (equity > peakCapital) peakCapital = equity;
            const drawdown = (peakCapital - equity) / peakCapital;
            if (drawdown > maxDrawdown) maxDrawdown = drawdown;
        }

        // Close any remaining position at last bar price
        if (position) {
            const lastPrice = bars[bars.length - 1].close;
            const pnl = (lastPrice - position.entryPrice) * position.shares;
            capital += position.shares * lastPrice;
            trades.push({
                type: 'SELL (END)',
                date: bars[bars.length - 1].timestamp,
                price: lastPrice,
                shares: position.shares,
                pnl,
                pnlPercent: ((lastPrice / position.entryPrice) - 1) * 100,
            });
            position = null;
        }

        // Calculate stats
        const sellTrades = trades.filter(t => t.type.startsWith('SELL'));
        const winTrades = sellTrades.filter(t => t.pnl > 0);
        const loseTrades = sellTrades.filter(t => t.pnl <= 0);
        const totalReturn = ((capital - startingCapital) / startingCapital) * 100;
        const avgWin = winTrades.length > 0 ? winTrades.reduce((s, t) => s + t.pnlPercent, 0) / winTrades.length : 0;
        const avgLoss = loseTrades.length > 0 ? loseTrades.reduce((s, t) => s + t.pnlPercent, 0) / loseTrades.length : 0;

        // Buy & hold comparison
        const buyHoldReturn = ((bars[bars.length - 1].close - bars[60].close) / bars[60].close) * 100;

        const result = {
            strategy: strategy.name,
            symbol,
            period: `${bars[0].timestamp?.split('T')[0]} → ${bars[bars.length - 1].timestamp?.split('T')[0]}`,
            barsUsed: bars.length,
            startingCapital,
            endingCapital: Math.round(capital * 100) / 100,
            totalReturn: Math.round(totalReturn * 100) / 100,
            buyHoldReturn: Math.round(buyHoldReturn * 100) / 100,
            totalTrades: sellTrades.length,
            winRate: sellTrades.length > 0 ? Math.round((winTrades.length / sellTrades.length) * 100) : 0,
            avgWin: Math.round(avgWin * 100) / 100,
            avgLoss: Math.round(avgLoss * 100) / 100,
            maxDrawdown: Math.round(maxDrawdown * 10000) / 100,
            profitFactor: loseTrades.length > 0 && avgLoss !== 0
                ? Math.round(Math.abs((winTrades.length * avgWin) / (loseTrades.length * avgLoss)) * 100) / 100
                : winTrades.length > 0 ? Infinity : 0,
            trades,
        };

        return result;
    }

    /**
     * Format a single backtest result.
     */
    static formatResult(r) {
        if (!r) return '';
        const beat = r.totalReturn > r.buyHoldReturn ? '✅ BEATS' : '❌ LOSES TO';

        let out = `\n${'─'.repeat(60)}\n`;
        out += `  📈 ${r.strategy} on ${r.symbol}\n`;
        out += `  Period: ${r.period} (${r.barsUsed} bars)\n`;
        out += `${'─'.repeat(60)}\n`;
        out += `  💰 Return:     ${r.totalReturn >= 0 ? '+' : ''}${r.totalReturn}%  ($${r.startingCapital.toLocaleString()} → $${r.endingCapital.toLocaleString()})\n`;
        out += `  📊 Buy & Hold: ${r.buyHoldReturn >= 0 ? '+' : ''}${r.buyHoldReturn}%  ${beat} buy & hold\n`;
        out += `  🎯 Win Rate:   ${r.winRate}% (${r.totalTrades} trades)\n`;
        out += `  📈 Avg Win:    +${r.avgWin}%\n`;
        out += `  📉 Avg Loss:   ${r.avgLoss}%\n`;
        out += `  💎 Profit Factor: ${r.profitFactor}\n`;
        out += `  🔻 Max Drawdown:  ${r.maxDrawdown}%\n`;

        // Show last 5 trades
        if (r.trades.length > 0) {
            out += `\n  Recent Trades:\n`;
            const recent = r.trades.slice(-10);
            for (const t of recent) {
                const icon = t.type.startsWith('BUY') ? '🟢' : (t.pnl >= 0 ? '💚' : '🔴');
                out += `    ${icon} ${t.type.padEnd(14)} $${t.price?.toFixed(2).padStart(8)} × ${String(t.shares).padStart(4)}`;
                if (t.pnl) out += ` → ${t.pnl >= 0 ? '+' : ''}$${t.pnl.toFixed(2)} (${t.pnlPercent?.toFixed(1)}%)`;
                if (t.holdDays) out += ` [${t.holdDays}d]`;
                out += `\n`;
            }
        }

        return out;
    }

    /**
     * Run all strategies on a symbol and compare.
     */
    async compareAll(symbol, days = 500) {
        const results = [];
        for (const key of Object.keys(STRATEGIES)) {
            const result = await this.run(key, symbol, days);
            if (result) results.push(result);
            await new Promise(r => setTimeout(r, 500)); // Rate limiting
        }

        console.log('\n' + '═'.repeat(60));
        console.log(` STRATEGY COMPARISON — ${symbol}`);
        console.log('═'.repeat(60));

        // Sort by total return
        results.sort((a, b) => b.totalReturn - a.totalReturn);

        console.log(`\n  ${'Strategy'.padEnd(20)} ${'Return'.padStart(10)} ${'Win%'.padStart(6)} ${'Trades'.padStart(7)} ${'MaxDD'.padStart(8)} ${'vs B&H'.padStart(10)}`);
        console.log('  ' + '─'.repeat(65));

        for (const r of results) {
            const beat = r.totalReturn > r.buyHoldReturn ? '✅' : '❌';
            console.log(`  ${r.strategy.padEnd(20)} ${(r.totalReturn + '%').padStart(10)} ${(r.winRate + '%').padStart(6)} ${String(r.totalTrades).padStart(7)} ${(r.maxDrawdown + '%').padStart(8)} ${beat.padStart(2)} ${(r.buyHoldReturn + '%').padStart(7)}`);
        }

        // Print detailed results
        for (const r of results) {
            console.log(Backtester.formatResult(r));
        }

        return results;
    }
}

// ─── CLI Entry Point ──────────────────────────────────────────

const args = process.argv.slice(2);
const bt = new Backtester();

const symbolArg = args.find((_, i) => args[i - 1] === '--symbol') || 'SPY';
const strategyArg = args.find((_, i) => args[i - 1] === '--strategy');
const periodArg = args.find((_, i) => args[i - 1] === '--period');

let days = 500;
if (periodArg === '1y') days = 365;
else if (periodArg === '2y') days = 730;
else if (periodArg === '6m') days = 180;

if (args.includes('--all') || !strategyArg) {
    // Compare all strategies
    const symbols = args.filter(a => !a.startsWith('--') && !['--symbol', '--strategy', '--period', '--all'].some(f => args[args.indexOf(a) - 1] === f));
    const targetSymbols = symbols.length > 0 ? symbols : [symbolArg];

    for (const sym of targetSymbols) {
        await bt.compareAll(sym, days);
    }
} else {
    // Single strategy
    const result = await bt.run(strategyArg, symbolArg, days);
    if (result) {
        console.log(Backtester.formatResult(result));
    }
}

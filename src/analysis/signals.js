/**
 * Oracle Trading Engine — Signal Confluence Engine
 * 
 * Combines multiple indicator signals into a single confluence score.
 * Higher confluence = higher confidence = better trades.
 * 
 * Scoring:
 * - Each indicator contributes 0-2 points
 * - Insider signal adds 0-3 bonus points
 * - Total: 0-13 scale
 * - Trade when confluence >= 7
 */

import { Indicators } from './indicators.js';

export class SignalEngine {
    /**
     * Analyze a stock and return confluence score + signals.
     * @param {Array} bars - OHLCV data from Alpaca
     * @param {Object} insiderSignal - Optional insider signal from InsiderTracker
     * @returns {Object} Analysis result with score and signals
     */
    static analyze(bars, insiderSignal = null) {
        if (!bars || bars.length < 50) {
            return { score: 0, signals: [], recommendation: 'INSUFFICIENT_DATA', error: 'Need 50+ bars' };
        }

        const closes = bars.map(b => b.close);
        const highs = bars.map(b => b.high);
        const lows = bars.map(b => b.low);
        const volumes = bars.map(b => b.volume);

        const signals = [];
        let score = 0;

        // ─── RSI Signal ─────────────────────────────────────────

        const rsiValues = Indicators.rsi(closes);
        const latestRSI = rsiValues[rsiValues.length - 1];

        if (latestRSI !== undefined) {
            if (latestRSI < 30) {
                score += 2;
                signals.push({ indicator: 'RSI', value: latestRSI.toFixed(1), signal: 'OVERSOLD', strength: 2 });
            } else if (latestRSI < 40) {
                score += 1;
                signals.push({ indicator: 'RSI', value: latestRSI.toFixed(1), signal: 'APPROACHING_OVERSOLD', strength: 1 });
            } else if (latestRSI > 70) {
                score -= 2;
                signals.push({ indicator: 'RSI', value: latestRSI.toFixed(1), signal: 'OVERBOUGHT', strength: -2 });
            }
        }

        // ─── MACD Signal ────────────────────────────────────────

        const macdData = Indicators.macd(closes);

        if (macdData.length > 0) {
            if (Indicators.macdCrossover(macdData)) {
                score += 2;
                signals.push({ indicator: 'MACD', value: 'crossover', signal: 'BULLISH_CROSSOVER', strength: 2 });
            } else if (Indicators.macdCrossunder(macdData)) {
                score -= 2;
                signals.push({ indicator: 'MACD', value: 'crossunder', signal: 'BEARISH_CROSSUNDER', strength: -2 });
            }

            const latestMACD = macdData[macdData.length - 1];
            if (latestMACD && latestMACD.histogram > 0) {
                score += 1;
                signals.push({ indicator: 'MACD_HISTOGRAM', value: latestMACD.histogram.toFixed(2), signal: 'POSITIVE', strength: 1 });
            }
        }

        // ─── Bollinger Bands Signal ─────────────────────────────

        const bbData = Indicators.bollingerBands(closes);

        if (bbData.length > 0) {
            const latestBB = bbData[bbData.length - 1];
            const latestClose = closes[closes.length - 1];

            if (latestClose <= latestBB.lower) {
                score += 2;
                signals.push({ indicator: 'BB', value: 'at_lower', signal: 'BOUNCE_POTENTIAL', strength: 2 });
            } else if (latestClose >= latestBB.upper) {
                score -= 1;
                signals.push({ indicator: 'BB', value: 'at_upper', signal: 'OVEREXTENDED', strength: -1 });
            }
        }

        // ─── EMA Trend Signal ───────────────────────────────────

        const trend = Indicators.emaTrend(closes);

        if (trend === 'bullish') {
            score += 2;
            signals.push({ indicator: 'EMA', value: 'ema20 > ema50', signal: 'BULLISH_TREND', strength: 2 });
        } else if (trend === 'bearish') {
            score -= 1;
            signals.push({ indicator: 'EMA', value: 'ema20 < ema50', signal: 'BEARISH_TREND', strength: -1 });
        }

        // ─── Volume Confirmation ────────────────────────────────

        if (volumes.length >= 20) {
            const avgVolume = volumes.slice(-20).reduce((a, b) => a + b, 0) / 20;
            const latestVolume = volumes[volumes.length - 1];

            if (latestVolume > avgVolume * 1.5) {
                score += 1;
                signals.push({ indicator: 'VOLUME', value: `${(latestVolume / avgVolume).toFixed(1)}x avg`, signal: 'HIGH_VOLUME', strength: 1 });
            }
        }

        // ─── Insider Signal Bonus ───────────────────────────────

        if (insiderSignal) {
            const insiderBonus = Math.min(3, Math.floor(insiderSignal.signal_strength / 3));
            score += insiderBonus;
            signals.push({
                indicator: 'INSIDER',
                value: `${insiderSignal.insider_count} insiders, $${insiderSignal.total_value?.toLocaleString()}`,
                signal: insiderSignal.signal_type,
                strength: insiderBonus,
            });
        }

        // ─── ATR for stop-loss ──────────────────────────────────

        const atrValues = Indicators.atr(highs, lows, closes);
        const latestATR = atrValues[atrValues.length - 1];
        const latestClose = closes[closes.length - 1];

        // ─── Final Recommendation ───────────────────────────────

        let recommendation;
        if (score >= 7) recommendation = 'STRONG_BUY';
        else if (score >= 5) recommendation = 'BUY';
        else if (score >= 3) recommendation = 'LEAN_BUY';
        else if (score >= -1) recommendation = 'HOLD';
        else if (score >= -3) recommendation = 'LEAN_SELL';
        else recommendation = 'SELL';

        return {
            score,
            recommendation,
            signals,
            price: latestClose,
            atr: latestATR,
            suggestedStopLoss: latestClose && latestATR ? latestClose - (2 * latestATR) : null,
            suggestedTakeProfit: latestClose && latestATR ? latestClose + (3 * latestATR) : null,
            riskRewardRatio: 1.5,
        };
    }

    /**
     * Format analysis for human-readable output.
     */
    static formatReport(symbol, analysis) {
        let report = `\n📊 ${symbol} — Score: ${analysis.score}/13 — ${analysis.recommendation}\n`;
        report += `   Price: $${analysis.price?.toFixed(2)}\n`;

        if (analysis.suggestedStopLoss) {
            report += `   Stop-Loss: $${analysis.suggestedStopLoss.toFixed(2)} | Take-Profit: $${analysis.suggestedTakeProfit.toFixed(2)}\n`;
        }

        report += `   Signals:\n`;
        for (const s of analysis.signals) {
            const icon = s.strength > 0 ? '🟢' : s.strength < 0 ? '🔴' : '⚪';
            report += `     ${icon} ${s.indicator}: ${s.signal} (${s.value})\n`;
        }

        return report;
    }
}

// ─── Self-test with mock data ────────────────────────────────────

if (process.argv[1]?.endsWith('signals.js')) {
    // Generate mock bar data for testing
    const mockBars = [];
    let price = 150;
    for (let i = 0; i < 100; i++) {
        const change = (Math.random() - 0.48) * 3; // Slight upward bias
        price += change;
        mockBars.push({
            open: price - Math.random(),
            high: price + Math.random() * 2,
            low: price - Math.random() * 2,
            close: price,
            volume: Math.floor(1000000 + Math.random() * 5000000),
        });
    }

    const analysis = SignalEngine.analyze(mockBars);
    console.log(SignalEngine.formatReport('MOCK', analysis));
}

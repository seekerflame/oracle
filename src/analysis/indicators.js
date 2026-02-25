/**
 * Oracle Trading Engine — Technical Analysis Indicators
 * 
 * Wraps the `technicalindicators` npm library to provide
 * clean, composable indicator calculations for strategy use.
 * 
 * Indicators implemented:
 * - RSI (Relative Strength Index) — momentum
 * - MACD (Moving Average Convergence Divergence) — trend
 * - Bollinger Bands — volatility
 * - EMA (Exponential Moving Average) — trend
 * - ATR (Average True Range) — volatility/stop-loss sizing
 * - VWAP (Volume Weighted Average Price) — institutional fair value
 */

import { RSI, MACD, BollingerBands, EMA, ATR, SMA } from 'technicalindicators';

export class Indicators {
    /**
     * Calculate RSI (Relative Strength Index).
     * > 70 = overbought (potential sell)
     * < 30 = oversold (potential buy)
     */
    static rsi(closes, period = 14) {
        return RSI.calculate({ values: closes, period });
    }

    /**
     * Calculate MACD.
     * Signal: when MACD line crosses above signal line = bullish
     * When MACD line crosses below signal line = bearish
     */
    static macd(closes, fastPeriod = 12, slowPeriod = 26, signalPeriod = 9) {
        return MACD.calculate({
            values: closes,
            fastPeriod,
            slowPeriod,
            signalPeriod,
            SimpleMAOscillator: false,
            SimpleMASignal: false,
        });
    }

    /**
     * Calculate Bollinger Bands.
     * Price touching upper band = potential reversal down
     * Price touching lower band = potential reversal up
     */
    static bollingerBands(closes, period = 20, stdDev = 2) {
        return BollingerBands.calculate({
            values: closes,
            period,
            stdDev,
        });
    }

    /**
     * Calculate EMA (Exponential Moving Average).
     * EMA20 > EMA50 = bullish trend
     * EMA20 < EMA50 = bearish trend
     */
    static ema(closes, period = 20) {
        return EMA.calculate({ values: closes, period });
    }

    /**
     * Calculate SMA (Simple Moving Average).
     */
    static sma(closes, period = 20) {
        return SMA.calculate({ values: closes, period });
    }

    /**
     * Calculate ATR (Average True Range).
     * Used for stop-loss sizing: stop = entry - (2 * ATR)
     */
    static atr(highs, lows, closes, period = 14) {
        return ATR.calculate({ high: highs, low: lows, close: closes, period });
    }

    /**
     * Calculate VWAP (Volume Weighted Average Price).
     * Approximation: cumulative (price * volume) / cumulative volume
     */
    static vwap(highs, lows, closes, volumes) {
        const typicalPrices = closes.map((c, i) => (highs[i] + lows[i] + c) / 3);
        let cumTPV = 0;
        let cumVol = 0;
        return typicalPrices.map((tp, i) => {
            cumTPV += tp * volumes[i];
            cumVol += volumes[i];
            return cumVol > 0 ? cumTPV / cumVol : 0;
        });
    }

    /**
     * Detect MACD crossover (bullish signal).
     * Returns true if MACD just crossed above signal line.
     */
    static macdCrossover(macdData) {
        if (macdData.length < 2) return false;
        const prev = macdData[macdData.length - 2];
        const curr = macdData[macdData.length - 1];
        if (!prev || !curr) return false;
        return prev.MACD < prev.signal && curr.MACD > curr.signal;
    }

    /**
     * Detect MACD crossunder (bearish signal).
     */
    static macdCrossunder(macdData) {
        if (macdData.length < 2) return false;
        const prev = macdData[macdData.length - 2];
        const curr = macdData[macdData.length - 1];
        if (!prev || !curr) return false;
        return prev.MACD > prev.signal && curr.MACD < curr.signal;
    }

    /**
     * Get EMA trend direction.
     * Returns 'bullish', 'bearish', or 'neutral'.
     */
    static emaTrend(closes) {
        const ema20 = this.ema(closes, 20);
        const ema50 = this.ema(closes, 50);

        if (ema20.length === 0 || ema50.length === 0) return 'neutral';

        const latest20 = ema20[ema20.length - 1];
        const latest50 = ema50[ema50.length - 1];

        if (latest20 > latest50 * 1.005) return 'bullish';
        if (latest20 < latest50 * 0.995) return 'bearish';
        return 'neutral';
    }
}

/**
 * Oracle Trading Engine — Risk Manager
 * 
 * THE most important module. This is what separates
 * winners from gamblers.
 * 
 * Rules:
 * - Max 5% of portfolio per trade
 * - Stop-loss: 2x ATR below entry
 * - Take-profit: 3:1 reward-to-risk minimum
 * - Max drawdown: 10% = pause ALL trading
 * - Max 5 open positions
 * - Never 3+ positions in same sector
 * - Daily loss limit: -2% = stop for the day
 */

export class RiskManager {
    constructor(config = {}) {
        this.maxPositionPercent = config.maxPositionPercent || 0.05;  // 5% per trade
        this.maxDrawdownPercent = config.maxDrawdownPercent || 0.10;  // 10% total
        this.maxOpenPositions = config.maxOpenPositions || 5;
        this.maxSameSector = config.maxSameSector || 2;
        this.dailyLossLimit = config.dailyLossLimit || 0.02;  // 2% per day
        this.minRewardToRisk = config.minRewardToRisk || 3.0;  // 3:1 ratio

        this.dailyPL = 0;
        this.peakEquity = 0;
        this.isPaused = false;
        this.pauseReason = null;
    }

    /**
     * Check if a trade is allowed based on all risk rules.
     * Returns { allowed: bool, reason: string, positionSize: number }
     */
    checkTrade(params) {
        const {
            portfolioValue,
            currentPositions = [],
            symbol,
            sector = 'Unknown',
            entryPrice,
            stopLoss,
            takeProfit,
            signalScore = 0,
        } = params;

        // Track peak equity for drawdown
        if (portfolioValue > this.peakEquity) {
            this.peakEquity = portfolioValue;
        }

        // ─── Rule 1: Trading Paused? ────────────────────────────

        if (this.isPaused) {
            return { allowed: false, reason: `Trading PAUSED: ${this.pauseReason}`, positionSize: 0 };
        }

        // ─── Rule 2: Max Drawdown Check ─────────────────────────

        const drawdown = (this.peakEquity - portfolioValue) / this.peakEquity;
        if (drawdown >= this.maxDrawdownPercent) {
            this.isPaused = true;
            this.pauseReason = `Max drawdown hit: ${(drawdown * 100).toFixed(1)}% (limit: ${this.maxDrawdownPercent * 100}%)`;
            return { allowed: false, reason: this.pauseReason, positionSize: 0 };
        }

        // ─── Rule 3: Daily Loss Limit ───────────────────────────

        if (this.dailyPL < 0 && Math.abs(this.dailyPL) >= portfolioValue * this.dailyLossLimit) {
            return { allowed: false, reason: `Daily loss limit hit: $${this.dailyPL.toFixed(2)}`, positionSize: 0 };
        }

        // ─── Rule 4: Max Open Positions ─────────────────────────

        if (currentPositions.length >= this.maxOpenPositions) {
            return { allowed: false, reason: `Max ${this.maxOpenPositions} open positions reached`, positionSize: 0 };
        }

        // ─── Rule 5: No Duplicate Symbols ───────────────────────

        if (currentPositions.some(p => p.symbol === symbol)) {
            return { allowed: false, reason: `Already holding ${symbol}`, positionSize: 0 };
        }

        // ─── Rule 6: Sector Concentration ───────────────────────

        const sectorCount = currentPositions.filter(p => p.sector === sector).length;
        if (sectorCount >= this.maxSameSector) {
            return { allowed: false, reason: `Max ${this.maxSameSector} positions in ${sector} sector`, positionSize: 0 };
        }

        // ─── Rule 7: Risk-Reward Ratio ──────────────────────────

        if (entryPrice && stopLoss && takeProfit) {
            const risk = entryPrice - stopLoss;
            const reward = takeProfit - entryPrice;
            const rrRatio = risk > 0 ? reward / risk : 0;

            if (rrRatio < this.minRewardToRisk) {
                return {
                    allowed: false,
                    reason: `R:R ratio ${rrRatio.toFixed(1)} < minimum ${this.minRewardToRisk}`,
                    positionSize: 0
                };
            }
        }

        // ─── Rule 8: Minimum Signal Strength ────────────────────

        if (signalScore < 5) {
            return { allowed: false, reason: `Signal too weak (${signalScore}/13, need 5+)`, positionSize: 0 };
        }

        // ─── Calculate Position Size ────────────────────────────

        const maxDollars = portfolioValue * this.maxPositionPercent;
        let positionSize = Math.floor(maxDollars / entryPrice);

        // Scale position with signal strength
        if (signalScore >= 9) positionSize = positionSize; // Full position
        else if (signalScore >= 7) positionSize = Math.floor(positionSize * 0.75);
        else positionSize = Math.floor(positionSize * 0.5);

        if (positionSize < 1) {
            return { allowed: false, reason: 'Position size too small ($)', positionSize: 0 };
        }

        return {
            allowed: true,
            reason: 'All checks passed',
            positionSize,
            maxDollars: positionSize * entryPrice,
            percentOfPortfolio: ((positionSize * entryPrice) / portfolioValue * 100).toFixed(1) + '%',
        };
    }

    /**
     * Record daily P&L for tracking.
     */
    recordTrade(pnl) {
        this.dailyPL += pnl;
    }

    /**
     * Reset daily counters (call at market open).
     */
    resetDaily() {
        this.dailyPL = 0;
    }

    /**
     * Unpause trading (manual override after review).
     */
    unpause() {
        this.isPaused = false;
        this.pauseReason = null;
    }

    /**
     * Get current risk status.
     */
    getStatus() {
        return {
            isPaused: this.isPaused,
            pauseReason: this.pauseReason,
            dailyPL: this.dailyPL,
            peakEquity: this.peakEquity,
            drawdown: this.peakEquity > 0
                ? ((this.peakEquity - (this.peakEquity + this.dailyPL)) / this.peakEquity * 100).toFixed(2) + '%'
                : '0%',
        };
    }
}

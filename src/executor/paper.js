import 'dotenv/config';
/**
 * Oracle Trading Engine — Paper Trading Executor
 * 
 * Auto-executes trades when the scanner finds signals above threshold.
 * Uses Alpaca paper trading (fake money) to prove the system works.
 * 
 * Usage:
 *   node src/executor/paper.js                  # Run once (scan + execute)
 *   node src/executor/paper.js --loop           # Run every 5 minutes
 *   node src/executor/paper.js --dry-run        # Show what WOULD trade
 * 
 * Only goes live when:
 *   1. Paper trading shows consistent profit for 30+ days
 *   2. You manually flip paper: false in config
 */

import { AlpacaConnector } from '../data/alpaca.js';
import { InsiderTracker } from '../data/insider.js';
import { CongressTracker } from '../data/congress.js';
import { SignalEngine } from '../analysis/signals.js';
import { RiskManager } from '../risk/manager.js';

const WATCHLIST = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN',
    'META', 'TSLA', 'AMD', 'NFLX',
    'JPM', 'V', 'MA',
    'SPY', 'QQQ',
];

const MIN_SIGNAL_SCORE = 5;  // Minimum score to consider
const AUTO_TRADE_SCORE = 7;  // Auto-execute trades at this score

class PaperExecutor {
    constructor(dryRun = false) {
        this.alpaca = new AlpacaConnector({ paper: true });
        this.insider = new InsiderTracker();
        this.congress = new CongressTracker();
        this.risk = new RiskManager();
        this.dryRun = dryRun;
    }

    async execute() {
        const timestamp = new Date().toLocaleString();
        console.log(`\n🤖 Paper Executor — ${timestamp}`);
        console.log(`   Mode: ${this.dryRun ? '🔍 DRY RUN' : '📝 PAPER TRADING'}\n`);

        // Check market status
        let marketOpen;
        try {
            marketOpen = await this.alpaca.isMarketOpen();
            if (!marketOpen.isOpen) {
                console.log(`⏸️  Market is CLOSED. Next open: ${marketOpen.nextOpen}`);
                console.log(`   Running analysis anyway for review...\n`);
            }
        } catch (e) {
            console.log(`⚠️  Could not check market status: ${e.message}\n`);
        }

        // Get account + positions
        let account, positions;
        try {
            account = await this.alpaca.getAccount();
            positions = await this.alpaca.getPositions();
            console.log(`💰 Portfolio: $${account.portfolioValue.toFixed(2)} | Cash: $${account.cash.toFixed(2)} | Positions: ${positions.length}`);

            if (positions.length > 0) {
                console.log(`\n   Open Positions:`);
                for (const p of positions) {
                    const icon = p.unrealizedPL >= 0 ? '📈' : '📉';
                    console.log(`   ${icon} ${p.symbol}: ${p.qty} shares @ $${p.avgEntry.toFixed(2)} → $${p.currentPrice.toFixed(2)} (${p.unrealizedPLPercent.toFixed(1)}%)`);
                }
            }
            console.log('');
        } catch (e) {
            console.error(`❌ Cannot connect to Alpaca: ${e.message}`);
            return;
        }

        // Scan watchlist
        const opportunities = [];

        for (const symbol of WATCHLIST) {
            try {
                const bars = await this.alpaca.getBars(symbol, '1Day', 200);
                if (bars.length < 50) continue;

                // Get insider/congress signals
                const insiderSignal = this.insider.detectClusterBuys(symbol);
                const congressSignal = this.congress.detectCongressClusterBuy(symbol);
                const bestSignal = insiderSignal || congressSignal || null;

                // Analyze
                const analysis = SignalEngine.analyze(bars, bestSignal);

                if (analysis.score >= MIN_SIGNAL_SCORE) {
                    // Check risk
                    const riskCheck = this.risk.checkTrade({
                        portfolioValue: account.portfolioValue,
                        currentPositions: positions,
                        symbol,
                        entryPrice: analysis.price,
                        stopLoss: analysis.suggestedStopLoss,
                        takeProfit: analysis.suggestedTakeProfit,
                        signalScore: analysis.score,
                    });

                    opportunities.push({
                        symbol,
                        score: analysis.score,
                        recommendation: analysis.recommendation,
                        price: analysis.price,
                        stopLoss: analysis.suggestedStopLoss,
                        takeProfit: analysis.suggestedTakeProfit,
                        signals: analysis.signals,
                        riskCheck,
                    });
                }
            } catch (e) {
                // Skip errors silently — don't spam the log
            }

            await new Promise(r => setTimeout(r, 350));
        }

        // Sort by score
        opportunities.sort((a, b) => b.score - a.score);

        if (opportunities.length === 0) {
            console.log('📭 No opportunities above threshold. Standing by.\n');
            this.cleanup();
            return;
        }

        // Display opportunities
        console.log(`\n🎯 ${opportunities.length} Opportunities Found:\n`);

        for (const opp of opportunities) {
            console.log(`  ${opp.recommendation} ${opp.symbol} @ $${opp.price?.toFixed(2)} — Score: ${opp.score}/13`);

            if (opp.riskCheck.allowed) {
                console.log(`    ✅ ${opp.riskCheck.positionSize} shares (${opp.riskCheck.percentOfPortfolio})`);
                console.log(`    Stop: $${opp.stopLoss?.toFixed(2)} | Target: $${opp.takeProfit?.toFixed(2)}`);
            } else {
                console.log(`    🚫 ${opp.riskCheck.reason}`);
            }
        }

        // Execute trades for score >= AUTO_TRADE_SCORE with risk approval
        const executableTrades = opportunities.filter(o =>
            o.score >= AUTO_TRADE_SCORE && o.riskCheck.allowed
        );

        if (executableTrades.length > 0 && marketOpen?.isOpen) {
            console.log(`\n⚡ Executing ${executableTrades.length} trade(s)...\n`);

            for (const trade of executableTrades) {
                if (this.dryRun) {
                    console.log(`  🔍 [DRY RUN] Would buy ${trade.riskCheck.positionSize} ${trade.symbol} @ ~$${trade.price.toFixed(2)}`);
                    continue;
                }

                try {
                    const order = await this.alpaca.bracketOrder(
                        trade.symbol,
                        trade.riskCheck.positionSize,
                        trade.price,
                        trade.stopLoss,
                        trade.takeProfit
                    );
                    console.log(`  ✅ ORDER PLACED: ${trade.riskCheck.positionSize} ${trade.symbol}`);
                    console.log(`     Entry: ~$${trade.price.toFixed(2)} | Stop: $${trade.stopLoss.toFixed(2)} | Target: $${trade.takeProfit.toFixed(2)}`);
                    console.log(`     Order ID: ${order.id}`);
                } catch (e) {
                    console.log(`  ❌ ORDER FAILED for ${trade.symbol}: ${e.message}`);
                }
            }
        } else if (executableTrades.length > 0) {
            console.log(`\n⏸️  ${executableTrades.length} trades ready but market is CLOSED. Will execute when open.`);
        }

        console.log('');
        this.cleanup();
    }

    cleanup() {
        this.insider.close();
        this.congress.close();
    }

    /**
     * Run in loop mode (every N minutes).
     */
    async loop(intervalMinutes = 5) {
        console.log(`🔄 Loop mode: scanning every ${intervalMinutes} minutes. Ctrl+C to stop.\n`);

        while (true) {
            await this.execute();
            console.log(`\n⏳ Next scan in ${intervalMinutes} minutes...\n`);

            // Recreate DB connections (they were closed in execute)
            this.insider = new InsiderTracker();
            this.congress = new CongressTracker();

            await new Promise(r => setTimeout(r, intervalMinutes * 60 * 1000));
        }
    }
}

// ─── CLI Entry Point ──────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const executor = new PaperExecutor(dryRun);

if (args.includes('--loop')) {
    const interval = parseInt(args.find((_, i) => args[i - 1] === '--interval') || '5');
    await executor.loop(interval);
} else {
    await executor.execute();
}

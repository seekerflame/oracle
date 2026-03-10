import 'dotenv/config';
/**
 * Oracle Trading Engine — Market Scanner
 * 
 * The main entry point. Scans a watchlist, runs analysis,
 * and outputs trade recommendations.
 * 
 * Usage:
 *   node src/scan.js                    # Scan default watchlist
 *   node src/scan.js AAPL NVDA TSLA     # Scan specific tickers
 *   node src/scan.js --insider          # Run insider-only scan
 */

import { AlpacaConnector } from './data/alpaca.js';
import { InsiderTracker } from './data/insider.js';
import { CongressTracker } from './data/congress.js';
import { SignalEngine } from './analysis/signals.js';
import { RiskManager } from './risk/manager.js';
import { forwardBatch } from './bridge.js';

// ─── Default Watchlist ───────────────────────────────────────────
// High-liquidity stocks that are easy to trade
const DEFAULT_WATCHLIST = [
    'AAPL', 'MSFT', 'NVDA', 'GOOGL', 'AMZN',
    'META', 'TSLA', 'AMD', 'NFLX', 'DIS',
    'JPM', 'V', 'MA', 'UNH', 'JNJ',
    'SPY', 'QQQ', 'IWM',
];

class OracleScanner {
    constructor() {
        this.alpaca = new AlpacaConnector({ paper: true });
        this.insider = new InsiderTracker();
        this.congress = new CongressTracker();
        this.risk = new RiskManager();
    }

    /**
     * Full scan: market data + indicators + insider + congress signals.
     */
    async scan(symbols = DEFAULT_WATCHLIST) {
        console.log(`\n🔮 Oracle Scanner — ${new Date().toLocaleString()}`);
        console.log(`   Scanning ${symbols.length} symbols...\n`);

        // Get account info
        let account;
        try {
            account = await this.alpaca.getAccount();
            console.log(`💰 Account: $${account.portfolioValue.toFixed(2)} | Cash: $${account.cash.toFixed(2)} | Paper: ${account.isPaper}\n`);
        } catch (err) {
            console.log(`⚠️  No Alpaca connection. Running in analysis-only mode.`);
            console.log(`   Set ALPACA_API_KEY and ALPACA_SECRET_KEY to enable.\n`);
            account = { portfolioValue: 100000, cash: 100000, isPaper: true };
        }

        const results = [];
        let positions = [];

        try {
            positions = await this.alpaca.getPositions();
        } catch (e) {
            // No connection, empty positions
        }

        for (const symbol of symbols) {
            try {
                // Get 200 days of daily bars
                const bars = await this.alpaca.getBars(symbol, '1Day', 200);

                // Check for insider signals
                const insiderSignal = this.insider.detectClusterBuys(symbol);
                const congressSignal = this.congress.detectCongressClusterBuy(symbol);

                // Combine insider + congress into best signal
                const bestInsiderSignal = insiderSignal || congressSignal || null;

                // Run technical analysis
                const analysis = SignalEngine.analyze(bars, bestInsiderSignal);
                analysis.symbol = symbol;

                // Check risk manager
                if (analysis.score >= 5) {
                    const riskCheck = this.risk.checkTrade({
                        portfolioValue: account.portfolioValue,
                        currentPositions: positions,
                        symbol,
                        entryPrice: analysis.price,
                        stopLoss: analysis.suggestedStopLoss,
                        takeProfit: analysis.suggestedTakeProfit,
                        signalScore: analysis.score,
                    });
                    analysis.riskCheck = riskCheck;
                }

                results.push(analysis);
            } catch (err) {
                console.log(`  ⚠️ ${symbol}: ${err.message}`);
                results.push({ symbol, score: 0, recommendation: 'ERROR', error: err.message });
            }

            // Respect Alpaca rate limits (200 req/min)
            await new Promise(r => setTimeout(r, 350));
        }

        // Sort by score descending
        results.sort((a, b) => b.score - a.score);

        // Display results
        console.log('\n' + '═'.repeat(60));
        console.log(' ORACLE SCAN RESULTS');
        console.log('═'.repeat(60));

        for (const r of results) {
            if (r.error) {
                console.log(`  ❌ ${r.symbol}: ${r.error}`);
                continue;
            }
            console.log(SignalEngine.formatReport(r.symbol, r));
            if (r.riskCheck) {
                if (r.riskCheck.allowed) {
                    console.log(`   ✅ TRADE APPROVED: ${r.riskCheck.positionSize} shares (${r.riskCheck.percentOfPortfolio})`);
                } else {
                    console.log(`   🚫 BLOCKED: ${r.riskCheck.reason}`);
                }
            }
        }

        // Top picks
        const topPicks = results.filter(r => r.score >= 5 && !r.error);
        if (topPicks.length > 0) {
            console.log('\n' + '─'.repeat(60));
            console.log(' 🎯 TOP PICKS:');
            for (const p of topPicks) {
                console.log(`   ${p.recommendation} ${p.symbol} @ $${p.price?.toFixed(2)} — Score: ${p.score}/13`);
            }
        } else {
            console.log('\n  📭 No strong signals today. Patience is a virtue.');
        }

        console.log('\n' + '═'.repeat(60) + '\n');

        // Forward signals to Wealth Engine backend
        await forwardBatch(results);

        this.insider.close();
        this.congress.close();

        return results;
    }

    /**
     * Quick insider-only scan.
     */
    async insiderScan(tickers = DEFAULT_WATCHLIST) {
        console.log(`\n🕵️ Oracle Insider Scan — ${new Date().toLocaleString()}\n`);

        for (const ticker of tickers) {
            const filings = await this.insider.fetchForCompany(ticker);
            if (filings.length > 0) {
                console.log(`📋 ${ticker}: ${filings.length} Form 4 filings`);
                for (const f of filings.slice(0, 3)) {
                    console.log(`   ${f.filingDate} | ${f.form}`);
                }
            }
            await new Promise(r => setTimeout(r, 150)); // SEC rate limit
        }

        this.insider.close();
    }
}

// ─── CLI Entry Point ──────────────────────────────────────────────

const args = process.argv.slice(2);
const scanner = new OracleScanner();

if (args.includes('--insider')) {
    const tickers = args.filter(a => !a.startsWith('--'));
    await scanner.insiderScan(tickers.length > 0 ? tickers : undefined);
} else {
    const tickers = args.filter(a => !a.startsWith('--'));
    await scanner.scan(tickers.length > 0 ? tickers : undefined);
}

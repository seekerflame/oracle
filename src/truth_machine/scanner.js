import 'dotenv/config';
import { PolymarketConnector } from '../market/polymarket_api.js';
import { ConvictionEngine } from './conviction.js';
import { OrderStager } from './order_stager.js';
import { RssFetcher } from '../osint/rss_fetcher.js';
import { KeywordMatcher } from '../osint/keyword_matcher.js';
import { SignalScorer } from '../osint/signal_scorer.js';
import { PositionTracker } from '../whale/position_tracker.js';
import { fileURLToPath } from 'url';

/**
 * Oracle Truth Machine — Continuous Scanner Loop
 *
 * The main loop. Runs every N minutes:
 * 1. Fetch latest OSINT articles
 * 2. Match against active markets
 * 3. Check whale position changes
 * 4. Score market mechanics
 * 5. Calculate conviction for each market
 * 6. Stage orders for high-conviction opportunities
 * 7. Log everything to SQLite audit trail
 *
 * Run: node src/truth_machine/scanner.js
 * Single cycle: node src/truth_machine/scanner.js --once
 * Dry run: node src/truth_machine/scanner.js --dry-run
 */

const SCAN_INTERVAL = parseInt(process.env.SCANNER_INTERVAL || '600000'); // 10 min default

export class TruthMachineScanner {
    constructor(options = {}) {
        this.dryRun = options.dryRun || false;
        this.pm = new PolymarketConnector();
        this.conviction = new ConvictionEngine();
        this.orderStager = new OrderStager();
        this.rssFetcher = new RssFetcher();
        this.keywordMatcher = new KeywordMatcher();
        this.signalScorer = new SignalScorer();
        this.positionTracker = new PositionTracker();
        this.running = false;
        this.cycleCount = 0;
    }

    /**
     * Run a single scan cycle.
     * @returns {Object} Cycle results
     */
    async runCycle() {
        this.cycleCount++;
        const cycleStart = Date.now();

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`🔮 TRUTH MACHINE — CYCLE #${this.cycleCount} — ${new Date().toLocaleString()}`);
        console.log(`${'═'.repeat(60)}\n`);

        const results = {
            cycle: this.cycleCount,
            timestamp: cycleStart,
            markets: 0,
            articles: 0,
            signals: 0,
            convictions: [],
            orders: [],
            errors: [],
        };

        try {
            // ─── Step 1: Fetch OSINT ──────────────────────────────

            console.log('📡 Step 1: Fetching OSINT feeds...');
            try {
                const newArticles = await this.rssFetcher.fetchLatest();
                results.articles = newArticles.length;
                console.log(`   ${newArticles.length} new articles`);
            } catch (e) {
                results.errors.push(`OSINT fetch: ${e.message}`);
                console.log(`   ⚠️  OSINT fetch error: ${e.message}`);
            }

            // ─── Step 2: Get Markets ──────────────────────────────

            console.log('\n🔮 Step 2: Scanning prediction markets...');
            let geoMarkets = [];
            try {
                geoMarkets = await this.pm.getActiveGeopolitical();
                results.markets = geoMarkets.length;
                console.log(`   ${geoMarkets.length} geopolitical markets`);

                // Snapshot for historical tracking
                this.pm.snapshotMarkets(geoMarkets);

                // Auto-link markets to keyword registry
                this.keywordMatcher.autoLinkMarkets(geoMarkets);
            } catch (e) {
                results.errors.push(`Market scan: ${e.message}`);
                console.log(`   ⚠️  Market scan error: ${e.message}`);
            }

            // ─── Step 3: Match Signals ────────────────────────────

            console.log('\n🎯 Step 3: Matching OSINT to markets...');
            try {
                const recentArticles = this.rssFetcher.getRecent(6); // Last 6 hours
                const matches = this.keywordMatcher.matchSignals(recentArticles);
                results.signals = matches.length;
                console.log(`   ${matches.length} signal matches`);

                if (matches.length > 0) {
                    const scores = this.signalScorer.scoreSignals(matches);
                    const hot = scores.filter(s => s.strength >= 40);
                    if (hot.length > 0) {
                        console.log(`   🔥 ${hot.length} HOT signals:`);
                        for (const h of hot.slice(0, 3)) {
                            console.log(`      ${h.category}: ${h.strength}/100 (${h.sources.join(', ')})`);
                        }
                    }
                }
            } catch (e) {
                results.errors.push(`Signal match: ${e.message}`);
                console.log(`   ⚠️  Signal match error: ${e.message}`);
            }

            // ─── Step 4: Whale Check ──────────────────────────────

            console.log('\n🐋 Step 4: Checking whale positions...');
            const whaleWallets = process.env.WHALE_WALLETS
                ? process.env.WHALE_WALLETS.split(',').map(w => w.trim()).filter(Boolean)
                : [];

            if (whaleWallets.length > 0) {
                try {
                    const whaleResults = await this.positionTracker.scanAll(whaleWallets);
                    if (whaleResults.alerts.length > 0) {
                        console.log(`   🚨 ${whaleResults.alerts.length} whale alerts`);
                    } else {
                        console.log(`   No whale alerts`);
                    }
                } catch (e) {
                    results.errors.push(`Whale scan: ${e.message}`);
                    console.log(`   ⚠️  Whale scan error: ${e.message}`);
                }
            } else {
                console.log(`   No wallets configured (set WHALE_WALLETS in .env)`);
            }

            // ─── Step 5: Conviction Scoring ───────────────────────

            console.log('\n🧠 Step 5: Calculating conviction scores...');
            const topMarkets = geoMarkets
                .filter(m => m.oddsYes > 0 && m.oddsYes < 0.5) // Focus on asymmetric (<50% odds)
                .sort((a, b) => b.volume24h - a.volume24h)
                .slice(0, 5); // Top 5 by volume

            for (const market of topMarkets) {
                try {
                    const conv = await this.conviction.calculateConviction(market.id);
                    results.convictions.push(conv);

                    const icon = conv.score >= 60 ? '🔴' : conv.score >= 40 ? '🟡' : '⚪';
                    console.log(`   ${icon} ${conv.score}/100 | ${market.title.slice(0, 50)} | $${conv.suggestedSize}`);

                    // ─── Step 6: Auto-stage if high conviction ────

                    if (conv.score >= 60 && conv.suggestedSize > 0 && market.tokens?.length > 0) {
                        console.log(`\n   🎯 HIGH CONVICTION — staging order...`);

                        const orderResult = await this.orderStager.stageOrder({
                            marketId: market.id,
                            marketTitle: market.title,
                            tokenId: market.tokens[0], // YES token
                            side: 'BUY',
                            price: market.oddsYes + 0.01, // Slightly above market
                            size: Math.floor(conv.suggestedSize / (market.oddsYes + 0.01)),
                            convictionScore: conv.score,
                            dryRun: this.dryRun,
                        });

                        results.orders.push(orderResult);

                        if (orderResult.success) {
                            console.log(`   ✅ ${this.dryRun ? 'DRY RUN' : 'ORDER'} #${orderResult.orderId}: ${orderResult.returnMultiple}x potential`);
                        }
                    }
                } catch (e) {
                    results.errors.push(`Conviction ${market.id}: ${e.message}`);
                }
            }

        } catch (e) {
            results.errors.push(`Cycle error: ${e.message}`);
            console.log(`\n❌ Cycle error: ${e.message}`);
        }

        // ─── Summary ─────────────────────────────────────────────

        const elapsed = ((Date.now() - cycleStart) / 1000).toFixed(1);

        console.log(`\n${'─'.repeat(60)}`);
        console.log(`📊 CYCLE #${this.cycleCount} SUMMARY (${elapsed}s)`);
        console.log(`   Markets: ${results.markets} | Articles: ${results.articles} | Signals: ${results.signals}`);
        console.log(`   Convictions: ${results.convictions.length} scored`);
        console.log(`   Orders: ${results.orders.length} staged`);
        if (results.errors.length > 0) {
            console.log(`   Errors: ${results.errors.length}`);
        }
        console.log(`${'─'.repeat(60)}\n`);

        return results;
    }

    /**
     * Start the continuous scanner loop.
     */
    async start() {
        console.log(`\n🔮 TRUTH MACHINE — STARTING ${this.dryRun ? '(DRY RUN)' : '(LIVE)'}`);
        console.log(`   Interval: ${SCAN_INTERVAL / 1000}s | Max Positions: ${this.orderStager.maxPositions}`);
        console.log(`   Wallets: ${(process.env.WHALE_WALLETS || 'none').slice(0, 50)}`);

        this.running = true;

        while (this.running) {
            await this.runCycle();

            if (!this.running) break;

            console.log(`   ⏳ Next cycle in ${SCAN_INTERVAL / 1000}s...`);
            await new Promise(r => setTimeout(r, SCAN_INTERVAL));
        }
    }

    /**
     * Stop the scanner.
     */
    stop() {
        this.running = false;
        console.log('\n🛑 Truth Machine stopped.');
    }

    close() {
        this.stop();
        this.pm.close();
        this.conviction.close();
        this.orderStager.close();
        this.rssFetcher.close();
        this.keywordMatcher.close();
        this.signalScorer.close();
        this.positionTracker.close();
    }
}

// ─── CLI Entry Point ──────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const once = args.includes('--once');
    const dryRun = args.includes('--dry-run');

    const scanner = new TruthMachineScanner({ dryRun });

    // Handle graceful shutdown
    process.on('SIGINT', () => {
        console.log('\n\n⚡ Shutting down...');
        scanner.close();
        process.exit(0);
    });

    if (once) {
        console.log('Running single cycle...');
        await scanner.runCycle();
        scanner.close();
    } else {
        await scanner.start();
    }
}

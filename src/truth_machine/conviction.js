import 'dotenv/config';
import Database from 'better-sqlite3';
import { PolymarketConnector } from '../market/polymarket_api.js';
import { OrderBookAnalyzer } from '../market/orderbook.js';
import { EfficiencyScorer } from '../market/efficiency.js';
import { PositionTracker } from '../whale/position_tracker.js';
import { RssFetcher } from '../osint/rss_fetcher.js';
import { KeywordMatcher } from '../osint/keyword_matcher.js';
import { SignalScorer } from '../osint/signal_scorer.js';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Conviction Engine
 *
 * The BRAIN. Combines all intelligence layers into a single Conviction Score.
 * Mirrors signals.js architecture: component scores → total → recommendation.
 *
 * Conviction Score: 0-100
 *   Whale Activity:    0-30 pts (who's moving money)
 *   OSINT Signals:     0-30 pts (what's happening publicly)
 *   Market Mechanics:  0-20 pts (where are the inefficiencies)
 *   Momentum:          0-20 pts (which way is the wind blowing)
 *
 * This is the decision engine: should we bet, how much, and when.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

export class ConvictionEngine {
    constructor() {
        this.pm = new PolymarketConnector();
        this.orderbook = new OrderBookAnalyzer();
        this.efficiency = new EfficiencyScorer();
        this.positions = new PositionTracker();
        this.rssFetcher = new RssFetcher();
        this.keywordMatcher = new KeywordMatcher();
        this.signalScorer = new SignalScorer();
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS convictions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id TEXT,
                    market_title TEXT,
                    total_score REAL,
                    whale_score REAL,
                    osint_score REAL,
                    mechanics_score REAL,
                    momentum_score REAL,
                    recommendation TEXT,
                    suggested_size REAL,
                    odds_at_scoring REAL,
                    created_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_conv_market ON convictions(market_id);
                CREATE INDEX IF NOT EXISTS idx_conv_created ON convictions(created_at);
            `);
        }
        return this.db;
    }

    /**
     * Calculate conviction score for a specific market.
     * This is the main entry point — call this for each market you're evaluating.
     *
     * @param {string} marketId - Polymarket market ID
     * @param {Object} options - { whaleData, osintData, skipFetch }
     * @returns {Object} Full conviction analysis
     */
    async calculateConviction(marketId, options = {}) {
        const db = this._getDb();

        // Get market data
        const market = await this.pm.getMarket(marketId);
        if (!market) {
            return { score: 0, recommendation: 'MARKET_NOT_FOUND', error: `Market ${marketId} not found` };
        }

        // ─── Component 1: Whale Activity (0-30) ──────────────────

        const whaleScore = await this._scoreWhaleActivity(marketId, options.whaleData);

        // ─── Component 2: OSINT Signals (0-30) ───────────────────

        const osintScore = this._scoreOsintSignals(marketId);

        // ─── Component 3: Market Mechanics (0-20) ────────────────

        const mechanicsScore = await this._scoreMarketMechanics(marketId, market);

        // ─── Component 4: Momentum (0-20) ────────────────────────

        const momentumScore = this._scoreMomentum(marketId, market);

        // ─── Total Conviction ────────────────────────────────────

        const totalScore = Math.min(100, Math.round(
            whaleScore.score + osintScore.score + mechanicsScore.score + momentumScore.score
        ));

        // Recommendation thresholds
        let recommendation;
        if (totalScore >= 80) recommendation = 'HIGH_CONVICTION';
        else if (totalScore >= 60) recommendation = 'STRONG';
        else if (totalScore >= 40) recommendation = 'MODERATE';
        else if (totalScore >= 20) recommendation = 'WEAK';
        else recommendation = 'NO_SIGNAL';

        // Position sizing (Kelly Criterion adapted)
        const suggestedSize = this._calculatePosition(totalScore, market.oddsYes);

        const conviction = {
            marketId,
            marketTitle: market.title,
            score: totalScore,
            recommendation,
            suggestedSize,
            currentOdds: {
                yes: parseFloat((market.oddsYes * 100).toFixed(1)),
                no: parseFloat((market.oddsNo * 100).toFixed(1)),
            },
            components: {
                whale: whaleScore,
                osint: osintScore,
                mechanics: mechanicsScore,
                momentum: momentumScore,
            },
            timestamp: Date.now(),
        };

        // Persist
        db.prepare(`
            INSERT INTO convictions
            (market_id, market_title, total_score, whale_score, osint_score, mechanics_score, momentum_score, recommendation, suggested_size, odds_at_scoring, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `).run(
            marketId, market.title, totalScore,
            whaleScore.score, osintScore.score, mechanicsScore.score, momentumScore.score,
            recommendation, suggestedSize, market.oddsYes, Date.now()
        );

        return conviction;
    }

    // ─── Component Scorers ────────────────────────────────────────

    /**
     * Whale Activity Score (0-30)
     * Based on: recent position changes, cluster activity, new whale entries
     */
    async _scoreWhaleActivity(marketId, whaleData = null) {
        let score = 0;
        const details = [];

        // Check recent position changes
        const changes = this.positions.getRecentChanges(24);
        const marketChanges = changes.filter(c =>
            c.token_id && c.change_type === 'NEW_POSITION'
        );

        if (marketChanges.length > 0) {
            const changeScore = Math.min(15, marketChanges.length * 5);
            score += changeScore;
            details.push(`${marketChanges.length} new whale positions in 24h (+${changeScore})`);
        }

        // Check cluster activity
        const db = this._getDb();
        const recentClusters = db.prepare(`
            SELECT * FROM clusters WHERE updated_at > ? ORDER BY confidence DESC LIMIT 5
        `).all(Date.now() - 24 * 60 * 60 * 1000);

        if (recentClusters.length > 0) {
            const highConfidence = recentClusters.filter(c => c.confidence >= 70);
            if (highConfidence.length > 0) {
                score += 10;
                details.push(`${highConfidence.length} high-confidence clusters active (+10)`);
            } else {
                score += 5;
                details.push(`${recentClusters.length} clusters detected (+5)`);
            }
        }

        // Check for mother wallet activity
        const motherFlows = db.prepare(`
            SELECT DISTINCT from_addr, COUNT(*) as target_count FROM flows
            WHERE hop_depth = 1 GROUP BY from_addr HAVING target_count >= 2
        `).all();

        if (motherFlows.length > 0) {
            score += Math.min(5, motherFlows.length * 2);
            details.push(`${motherFlows.length} mother wallets identified (+${Math.min(5, motherFlows.length * 2)})`);
        }

        return {
            score: Math.min(30, score),
            maxScore: 30,
            details,
        };
    }

    /**
     * OSINT Signal Score (0-30)
     * Based on: signal strength from keyword matches, source count, recency
     */
    _scoreOsintSignals(marketId) {
        let score = 0;
        const details = [];

        const recentScores = this.signalScorer.getRecentScores(24);
        const marketScores = recentScores.filter(s => s.market_id === marketId);

        if (marketScores.length > 0) {
            const topStrength = Math.max(...marketScores.map(s => s.strength));

            // Map 0-100 signal strength to 0-20 conviction component
            score += Math.min(20, Math.round(topStrength * 0.2));
            details.push(`Top signal strength: ${topStrength}/100 (+${Math.min(20, Math.round(topStrength * 0.2))})`);

            // Source diversity bonus
            const uniqueSources = new Set();
            for (const s of marketScores) {
                if (s.sources) s.sources.split(',').forEach(src => uniqueSources.add(src));
            }
            if (uniqueSources.size >= 3) {
                score += 10;
                details.push(`${uniqueSources.size} independent sources (+10)`);
            } else if (uniqueSources.size >= 2) {
                score += 5;
                details.push(`${uniqueSources.size} sources (+5)`);
            }
        } else {
            // Check if there are any signals at all (unlinked)
            const allScores = recentScores.filter(s => !s.market_id);
            if (allScores.length > 0) {
                score += 3;
                details.push(`${allScores.length} unlinked signals detected (+3)`);
            }
        }

        return {
            score: Math.min(30, score),
            maxScore: 30,
            details,
        };
    }

    /**
     * Market Mechanics Score (0-20)
     * Based on: efficiency gap, thin liquidity, mispriced odds
     */
    async _scoreMarketMechanics(marketId, market) {
        let score = 0;
        const details = [];

        // Efficiency scoring
        const effResult = this.efficiency.scoreEfficiency(marketId);
        if (effResult.score >= 0) {
            const effScore = Math.min(10, effResult.score);
            score += effScore;
            details.push(`Efficiency: ${effResult.label} (${effResult.score}/10 → +${effScore})`);
        }

        // Odds asymmetry: extreme low odds = high potential return
        const odds = market.oddsYes;
        if (odds < 0.05) {
            score += 8; // <5% = extreme asymmetry (50x potential)
            details.push(`Extreme asymmetry: ${(odds * 100).toFixed(1)}% odds (+8)`);
        } else if (odds < 0.10) {
            score += 5; // <10% = strong asymmetry (10x potential)
            details.push(`Strong asymmetry: ${(odds * 100).toFixed(1)}% odds (+5)`);
        } else if (odds < 0.20) {
            score += 3;
            details.push(`Moderate asymmetry: ${(odds * 100).toFixed(1)}% odds (+3)`);
        }

        // Volume spike detection
        if (market.volume24h > 50000) {
            score += 2;
            details.push(`High volume: $${Math.floor(market.volume24h).toLocaleString()} (+2)`);
        }

        return {
            score: Math.min(20, score),
            maxScore: 20,
            details,
        };
    }

    /**
     * Momentum Score (0-20)
     * Based on: odds trend direction and velocity from historical snapshots
     */
    _scoreMomentum(marketId, market) {
        let score = 0;
        const details = [];

        // Get historical snapshots
        const history = this.pm.getHistory(marketId, 48); // 48 hours
        if (history.length < 2) {
            return { score: 0, maxScore: 20, details: ['Insufficient history for momentum'] };
        }

        // Calculate trend
        const oldest = history[0].odds_yes;
        const newest = history[history.length - 1].odds_yes;
        const change = newest - oldest;
        const changePct = oldest > 0 ? (change / oldest) * 100 : 0;

        // Recent acceleration (last quarter vs first quarter)
        const quarterLen = Math.floor(history.length / 4);
        if (quarterLen > 0) {
            const earlyChange = history[quarterLen].odds_yes - history[0].odds_yes;
            const lateChange = history[history.length - 1].odds_yes - history[history.length - 1 - quarterLen].odds_yes;
            const acceleration = lateChange - earlyChange;

            if (acceleration > 0.01) {
                score += 8;
                details.push(`Accelerating upward momentum (+8)`);
            } else if (acceleration > 0) {
                score += 4;
                details.push(`Slight upward acceleration (+4)`);
            }
        }

        // Overall trend direction
        if (changePct > 50) {
            score += 12;
            details.push(`Strong uptrend: +${changePct.toFixed(0)}% in 48h (+12)`);
        } else if (changePct > 20) {
            score += 8;
            details.push(`Uptrend: +${changePct.toFixed(0)}% in 48h (+8)`);
        } else if (changePct > 5) {
            score += 4;
            details.push(`Mild uptrend: +${changePct.toFixed(0)}% in 48h (+4)`);
        } else if (changePct < -20) {
            score -= 5; // Downtrend penalizes
            details.push(`Downtrend: ${changePct.toFixed(0)}% in 48h (-5)`);
        }

        return {
            score: Math.max(0, Math.min(20, score)),
            maxScore: 20,
            details,
        };
    }

    // ─── Position Sizing ──────────────────────────────────────────

    /**
     * Kelly Criterion adapted for prediction markets.
     * size = bankroll * (edge / odds)
     * Capped by risk limits.
     */
    _calculatePosition(convictionScore, odds) {
        const maxPositionUsd = parseFloat(process.env.MAX_POSITION_USD || '50');
        const bankroll = maxPositionUsd * 20; // Assume bankroll = 20x max position

        // Edge estimate: conviction translates to perceived probability
        const perceivedProb = Math.min(0.9, convictionScore / 100);
        const marketProb = odds;

        // Edge = perceived probability - market probability
        const edge = perceivedProb - marketProb;
        if (edge <= 0) return 0; // No edge = no bet

        // Kelly: f = edge / (odds - 1) for positive edge
        // Simplified: f = (edge * payout) / payout
        const payout = 1 / marketProb - 1; // e.g., 2% odds = 49:1
        const kellyFraction = edge / (payout > 0 ? payout : 1);

        // Half-Kelly for safety
        const halfKelly = kellyFraction * 0.5;

        // Size = bankroll * halfKelly, capped at max
        const size = Math.min(maxPositionUsd, Math.max(0, bankroll * halfKelly));

        return parseFloat(size.toFixed(2));
    }

    /**
     * Get conviction history for a market.
     */
    getHistory(marketId, limit = 20) {
        const db = this._getDb();
        return db.prepare(`
            SELECT * FROM convictions WHERE market_id = ? ORDER BY created_at DESC LIMIT ?
        `).all(marketId, limit);
    }

    /**
     * Get all recent convictions.
     */
    getRecent(hours = 24) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);
        return db.prepare(`
            SELECT * FROM convictions WHERE created_at > ? ORDER BY total_score DESC
        `).all(since);
    }

    /**
     * Format conviction for human-readable output.
     */
    static formatReport(conviction) {
        if (conviction.error) {
            return `\n❌ ${conviction.error}\n`;
        }

        const scoreIcon = conviction.score >= 80 ? '🔴' :
                          conviction.score >= 60 ? '🟠' :
                          conviction.score >= 40 ? '🟡' : '🟢';

        let r = `\n${scoreIcon} CONVICTION: ${conviction.marketTitle}\n`;
        r += `${'═'.repeat(60)}\n`;
        r += `  Score: ${conviction.score}/100 — ${conviction.recommendation}\n`;
        r += `  Odds: YES ${conviction.currentOdds.yes}% | NO ${conviction.currentOdds.no}%\n`;
        r += `  Suggested Position: $${conviction.suggestedSize}\n`;

        r += `\n  🐋 Whale Activity: ${conviction.components.whale.score}/${conviction.components.whale.maxScore}\n`;
        for (const d of conviction.components.whale.details) {
            r += `     ${d}\n`;
        }

        r += `\n  📡 OSINT Signals: ${conviction.components.osint.score}/${conviction.components.osint.maxScore}\n`;
        for (const d of conviction.components.osint.details) {
            r += `     ${d}\n`;
        }

        r += `\n  ⚙️  Market Mechanics: ${conviction.components.mechanics.score}/${conviction.components.mechanics.maxScore}\n`;
        for (const d of conviction.components.mechanics.details) {
            r += `     ${d}\n`;
        }

        r += `\n  📈 Momentum: ${conviction.components.momentum.score}/${conviction.components.momentum.maxScore}\n`;
        for (const d of conviction.components.momentum.details) {
            r += `     ${d}\n`;
        }

        r += `${'═'.repeat(60)}\n`;
        return r;
    }

    close() {
        this.pm.close();
        this.orderbook.close();
        this.efficiency.close();
        this.positions.close();
        this.rssFetcher.close();
        this.keywordMatcher.close();
        this.signalScorer.close();
        if (this.db) { this.db.close(); this.db = null; }
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const engine = new ConvictionEngine();

    console.log('🧠 CONVICTION ENGINE — SELF-TEST\n');

    // Step 1: Get geopolitical markets
    console.log('1. Fetching geopolitical markets...');
    const geoMarkets = await engine.pm.getActiveGeopolitical();
    console.log(`   Found ${geoMarkets.length} markets\n`);

    if (geoMarkets.length > 0) {
        // Snapshot for efficiency tracking
        engine.pm.snapshotMarkets(geoMarkets);

        // Auto-link markets to keyword registry
        const links = engine.keywordMatcher.autoLinkMarkets(geoMarkets);
        console.log(`   Auto-linked ${links} market-keyword pairs\n`);

        // Step 2: Score top 3 markets
        console.log('2. Scoring conviction...');
        const topMarkets = geoMarkets
            .sort((a, b) => b.volume24h - a.volume24h)
            .slice(0, 3);

        for (const market of topMarkets) {
            const conviction = await engine.calculateConviction(market.id);
            console.log(ConvictionEngine.formatReport(conviction));
        }
    } else {
        console.log('   No geopolitical markets found.');
    }

    engine.close();
    console.log('\n✅ Self-test complete.');
}

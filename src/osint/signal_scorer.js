import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — OSINT Signal Strength Engine
 *
 * Combines multiple factors into a single signal strength score (0-100):
 * - Source reliability (Reuters=9, blog=2)
 * - Keyword match score from keyword_matcher
 * - Recency (breaking news > old news)
 * - Corroboration (multiple sources = stronger signal)
 * - Historical accuracy (did past signals predict market moves?)
 *
 * This is the "confidence meter" for OSINT intelligence.
 * Higher score = more likely the market hasn't priced this in yet.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

export class SignalScorer {
    constructor() {
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS signal_scores (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id TEXT,
                    category TEXT,
                    strength REAL,
                    reliability_component REAL,
                    match_component REAL,
                    recency_component REAL,
                    corroboration_component REAL,
                    historical_component REAL,
                    source_count INTEGER,
                    sources TEXT,
                    created_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_scores_market ON signal_scores(market_id);
                CREATE INDEX IF NOT EXISTS idx_scores_created ON signal_scores(created_at);
            `);
        }
        return this.db;
    }

    /**
     * Score a group of keyword matches for a specific market/category.
     * Groups matches by market and calculates a combined strength score.
     *
     * @param {Array} matches - Signal matches from keyword_matcher
     * @returns {Array} Scored signals grouped by market
     */
    scoreSignals(matches) {
        // Group matches by market_id (or category if no market linked)
        const groups = {};
        for (const m of matches) {
            const key = m.marketId || m.category;
            if (!groups[key]) {
                groups[key] = {
                    marketId: m.marketId,
                    category: m.category,
                    marketTitle: m.marketTitle,
                    matches: [],
                };
            }
            groups[key].matches.push(m);
        }

        const scores = [];

        for (const [key, group] of Object.entries(groups)) {
            const score = this._calculateStrength(group);
            scores.push(score);

            // Persist
            if (score.marketId) {
                const db = this._getDb();
                db.prepare(`
                    INSERT INTO signal_scores
                    (market_id, category, strength, reliability_component, match_component, recency_component, corroboration_component, historical_component, source_count, sources, created_at)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                `).run(
                    score.marketId, score.category, score.strength,
                    score.components.reliability, score.components.matchScore,
                    score.components.recency, score.components.corroboration,
                    score.components.historical,
                    score.sourceCount, score.sources.join(','), Date.now()
                );
            }
        }

        // Sort by strength descending
        scores.sort((a, b) => b.strength - a.strength);
        return scores;
    }

    /**
     * Calculate signal strength for a group of matches.
     * @param {Object} group - { marketId, category, matches }
     * @returns {Object} Signal score breakdown
     */
    _calculateStrength(group) {
        const matches = group.matches;

        // 1. Reliability (0-25): weighted average of source reliability scores
        const reliabilityScores = matches.map(m => m.reliability || 5);
        const maxReliability = Math.max(...reliabilityScores);
        const avgReliability = reliabilityScores.reduce((s, r) => s + r, 0) / reliabilityScores.length;
        const reliabilityComponent = ((maxReliability * 0.6 + avgReliability * 0.4) / 10) * 25;

        // 2. Match Score (0-25): strongest keyword match
        const matchScores = matches.map(m => m.matchScore || 0);
        const maxMatch = Math.max(...matchScores);
        const matchComponent = Math.min(25, (maxMatch / 20) * 25); // Normalize: 20+ = full marks

        // 3. Recency (0-20): how fresh is the signal?
        const recencyMultipliers = matches.map(m => m.recencyMultiplier || 0.5);
        const maxRecency = Math.max(...recencyMultipliers);
        const recencyComponent = (maxRecency / 2) * 20; // 2.0 = full marks

        // 4. Corroboration (0-20): multiple independent sources = stronger
        const uniqueSources = [...new Set(matches.map(m => m.source))];
        const sourceCount = uniqueSources.length;
        const corroborationComponent = Math.min(20, sourceCount * 7); // 3+ sources = full marks

        // 5. Historical Accuracy (0-10): how well have past signals predicted?
        const historicalComponent = this._getHistoricalAccuracy(group.marketId, group.category);

        // Total: 0-100
        const strength = Math.min(100, Math.round(
            reliabilityComponent + matchComponent + recencyComponent + corroborationComponent + historicalComponent
        ));

        // Confidence label
        let confidence;
        if (strength >= 80) confidence = 'VERY_HIGH';
        else if (strength >= 60) confidence = 'HIGH';
        else if (strength >= 40) confidence = 'MODERATE';
        else if (strength >= 20) confidence = 'LOW';
        else confidence = 'VERY_LOW';

        return {
            marketId: group.marketId,
            category: group.category,
            marketTitle: group.marketTitle,
            strength,
            confidence,
            sourceCount,
            sources: uniqueSources,
            totalMatches: matches.length,
            topKeywords: [...new Set(matches.flatMap(m => m.keywords || []))],
            components: {
                reliability: parseFloat(reliabilityComponent.toFixed(1)),
                matchScore: parseFloat(matchComponent.toFixed(1)),
                recency: parseFloat(recencyComponent.toFixed(1)),
                corroboration: parseFloat(corroborationComponent.toFixed(1)),
                historical: parseFloat(historicalComponent.toFixed(1)),
            },
        };
    }

    /**
     * Get historical accuracy for a market/category.
     * Checks how well past signals correlated with odds movements.
     * @returns {number} Score component (0-10)
     */
    _getHistoricalAccuracy(marketId, category) {
        if (!marketId) return 5; // Default: neutral

        const db = this._getDb();

        // Check if we have efficiency events recorded for this market
        const events = db.prepare(`
            SELECT * FROM efficiency_events
            WHERE market_id = ? AND market_move_timestamp IS NOT NULL
            ORDER BY signal_timestamp DESC LIMIT 10
        `).all(marketId);

        if (events.length === 0) return 5; // No history: neutral

        // Calculate accuracy: did signals predict moves?
        const correct = events.filter(e => Math.abs(e.odds_change) > 0.01).length;
        const accuracy = correct / events.length;

        return parseFloat((accuracy * 10).toFixed(1));
    }

    /**
     * Get recent scored signals.
     * @param {number} hours
     * @returns {Array} Recent scores
     */
    getRecentScores(hours = 24) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);
        return db.prepare(`
            SELECT * FROM signal_scores WHERE created_at > ? ORDER BY strength DESC
        `).all(since);
    }

    /**
     * Format signal scores for human-readable output.
     */
    static formatReport(scores) {
        let r = `\n📡 OSINT SIGNAL STRENGTH REPORT\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Signals Scored: ${scores.length}\n`;

        for (const s of scores) {
            const icon = s.strength >= 60 ? '🔴' : s.strength >= 40 ? '🟡' : '🟢';
            r += `\n  ${icon} ${s.category} — Strength: ${s.strength}/100 (${s.confidence})\n`;
            if (s.marketTitle) {
                r += `     Market: ${s.marketTitle}\n`;
            }
            r += `     Sources: ${s.sources.join(', ')} (${s.sourceCount} independent)\n`;
            r += `     Keywords: ${s.topKeywords.join(', ')}\n`;
            r += `     Components:\n`;
            r += `       Reliability: ${s.components.reliability}/25\n`;
            r += `       Match Score: ${s.components.matchScore}/25\n`;
            r += `       Recency:     ${s.components.recency}/20\n`;
            r += `       Corroboration: ${s.components.corroboration}/20\n`;
            r += `       Historical:  ${s.components.historical}/10\n`;
        }

        return r;
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const scorer = new SignalScorer();

    console.log('📡 SIGNAL SCORER — SELF-TEST\n');

    // Mock keyword matches (simulating output from keyword_matcher)
    const mockMatches = [
        { articleId: 1, articleTitle: 'US Embassy Baghdad heightens security', source: 'Reuters', category: 'IRAQ_EMBASSY', marketId: '1301544', marketTitle: 'US evacuates Baghdad Embassy?', matchScore: 20, keywords: ['baghdad embassy', 'staff relocation iraq'], recencyMultiplier: 2.0, reliability: 9 },
        { articleId: 2, articleTitle: 'State Dept issues travel advisory for Iraq', source: 'State Dept', category: 'IRAQ_EMBASSY', marketId: '1301544', marketTitle: 'US evacuates Baghdad Embassy?', matchScore: 15, keywords: ['embassy evacuation'], recencyMultiplier: 1.5, reliability: 10 },
        { articleId: 3, articleTitle: 'Pentagon confirms carrier deployment to Gulf', source: 'DoD', category: 'US_MILITARY', marketId: null, marketTitle: null, matchScore: 18, keywords: ['pentagon orders', 'aircraft carrier'], recencyMultiplier: 2.0, reliability: 10 },
        { articleId: 4, articleTitle: 'Iran tensions rise amid nuclear talks collapse', source: 'Al Jazeera', category: 'IRAN_STRIKE', marketId: '1277921', marketTitle: 'Israel strikes Iran?', matchScore: 12, keywords: ['iran tensions'], recencyMultiplier: 1.0, reliability: 7 },
    ];

    console.log('1. Scoring mock signals...');
    const scores = scorer.scoreSignals(mockMatches);
    console.log(SignalScorer.formatReport(scores));

    // Show database stats
    console.log('\n2. Database stats:');
    const recent = scorer.getRecentScores(24);
    console.log(`   Recent scores (24h): ${recent.length}`);

    scorer.close();
    console.log('\n✅ Self-test complete.');
}

import 'dotenv/config';
import Database from 'better-sqlite3';
import { PolymarketConnector } from './polymarket_api.js';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Market Efficiency Scoring
 *
 * Measures how quickly prediction markets respond to news events.
 * Slow response = edge window = asymmetric opportunity.
 *
 * Scoring: 0-10
 *   0 = Perfectly efficient (odds move instantly with news)
 *   10 = Extremely slow (huge edge window for informed traders)
 *
 * This is the core "pentesting" module for prediction markets.
 * We're measuring the attack surface: how much time do you have
 * between a public signal and the market pricing it in?
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

export class EfficiencyScorer {
    constructor() {
        this.pm = new PolymarketConnector();
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS efficiency_events (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    market_id TEXT,
                    event_type TEXT,
                    odds_before REAL,
                    odds_after REAL,
                    odds_change REAL,
                    response_minutes REAL,
                    signal_timestamp INTEGER,
                    market_move_timestamp INTEGER,
                    created_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_eff_market ON efficiency_events(market_id);
            `);
        }
        return this.db;
    }

    /**
     * Score market efficiency based on historical snapshot data.
     * Looks at how volatile the odds have been (more volatility = less efficient).
     * @param {string} marketId
     * @returns {Object} Efficiency analysis
     */
    scoreEfficiency(marketId) {
        const db = this._getDb();

        // Get snapshots from last 7 days
        const since = Date.now() - (7 * 24 * 60 * 60 * 1000);
        const snapshots = db.prepare(`
            SELECT odds_yes, odds_no, volume_24h, captured_at
            FROM market_snapshots
            WHERE market_id = ? AND captured_at > ?
            ORDER BY captured_at ASC
        `).all(marketId, since);

        if (snapshots.length < 2) {
            return {
                score: -1,
                label: 'INSUFFICIENT_DATA',
                message: 'Need at least 2 snapshots. Run polymarket_api.js to collect data first.',
                dataPoints: snapshots.length,
            };
        }

        // Calculate odds volatility (standard deviation of price changes)
        const changes = [];
        for (let i = 1; i < snapshots.length; i++) {
            const delta = Math.abs(snapshots[i].odds_yes - snapshots[i - 1].odds_yes);
            const timeDelta = (snapshots[i].captured_at - snapshots[i - 1].captured_at) / 60000; // minutes
            changes.push({ delta, timeDelta, timestamp: snapshots[i].captured_at });
        }

        const avgChange = changes.reduce((s, c) => s + c.delta, 0) / changes.length;
        const variance = changes.reduce((s, c) => s + Math.pow(c.delta - avgChange, 2), 0) / changes.length;
        const volatility = Math.sqrt(variance);

        // Find spikes (changes > 2x average = likely news events)
        const spikes = changes.filter(c => c.delta > avgChange * 2);

        // Average time between spikes and preceding snapshots (response time proxy)
        let avgResponseMinutes = 0;
        if (spikes.length > 0) {
            avgResponseMinutes = spikes.reduce((s, sp) => s + sp.timeDelta, 0) / spikes.length;
        }

        // Edge window: average time odds are "stale" (below 1% change rate)
        const staleWindows = changes.filter(c => c.delta < 0.01);
        const avgStaleMinutes = staleWindows.length > 0
            ? staleWindows.reduce((s, c) => s + c.timeDelta, 0) / staleWindows.length
            : 0;

        // Score: higher = less efficient = more edge
        // Factors: volatility (how much it moves), response time, stale windows
        let score = 0;
        score += Math.min(3, volatility * 30);           // Volatility component (0-3)
        score += Math.min(3, avgResponseMinutes / 30);    // Response time component (0-3)
        score += Math.min(2, spikes.length / 2);          // Spike frequency (0-2)
        score += Math.min(2, avgStaleMinutes / 60);       // Stale window component (0-2)
        score = Math.min(10, Math.round(score * 10) / 10);

        let label;
        if (score >= 8) label = 'HIGHLY_INEFFICIENT';
        else if (score >= 6) label = 'INEFFICIENT';
        else if (score >= 4) label = 'MODERATE';
        else if (score >= 2) label = 'EFFICIENT';
        else label = 'HIGHLY_EFFICIENT';

        // Odds range
        const allOdds = snapshots.map(s => s.odds_yes);
        const oddsMin = Math.min(...allOdds);
        const oddsMax = Math.max(...allOdds);
        const oddsRange = oddsMax - oddsMin;

        return {
            score,
            label,
            dataPoints: snapshots.length,
            volatility: parseFloat(volatility.toFixed(4)),
            avgResponseMinutes: parseFloat(avgResponseMinutes.toFixed(1)),
            avgStaleMinutes: parseFloat(avgStaleMinutes.toFixed(1)),
            spikeCount: spikes.length,
            oddsRange: {
                min: parseFloat((oddsMin * 100).toFixed(1)),
                max: parseFloat((oddsMax * 100).toFixed(1)),
                rangePct: parseFloat((oddsRange * 100).toFixed(1)),
            },
            edgeWindow: score >= 6
                ? `~${Math.round(avgResponseMinutes)} min window to act on news`
                : 'Market responds quickly — limited edge',
        };
    }

    /**
     * Record a known signal event for accuracy tracking.
     * Call this when you detect an OSINT signal, then compare to when odds moved.
     * @param {string} marketId
     * @param {string} eventType - e.g., 'rss_headline', 'whale_position', 'social_mention'
     * @param {number} signalTimestamp - When the signal was detected
     * @param {number} oddsBefore - Odds at signal time
     */
    recordSignalEvent(marketId, eventType, signalTimestamp, oddsBefore) {
        const db = this._getDb();
        db.prepare(`
            INSERT INTO efficiency_events (market_id, event_type, odds_before, signal_timestamp, created_at)
            VALUES (?, ?, ?, ?, ?)
        `).run(marketId, eventType, oddsBefore, signalTimestamp, Date.now());
    }

    /**
     * Update a signal event with the market's response.
     * Call this after the market moves post-signal.
     * @param {string} marketId
     * @param {number} oddsAfter
     * @param {number} moveTimestamp
     */
    recordMarketResponse(marketId, oddsAfter, moveTimestamp) {
        const db = this._getDb();

        // Find the most recent unresolved event for this market
        const event = db.prepare(`
            SELECT id, odds_before, signal_timestamp FROM efficiency_events
            WHERE market_id = ? AND market_move_timestamp IS NULL
            ORDER BY signal_timestamp DESC LIMIT 1
        `).get(marketId);

        if (event) {
            const responseMinutes = (moveTimestamp - event.signal_timestamp) / 60000;
            const oddsChange = oddsAfter - event.odds_before;

            db.prepare(`
                UPDATE efficiency_events
                SET odds_after = ?, odds_change = ?, response_minutes = ?, market_move_timestamp = ?
                WHERE id = ?
            `).run(oddsAfter, oddsChange, responseMinutes, moveTimestamp, event.id);
        }
    }

    /**
     * Get historical accuracy: how well do signals predict market moves?
     * @param {string} marketId
     * @returns {Object} Accuracy stats
     */
    getAccuracy(marketId) {
        const db = this._getDb();
        const events = db.prepare(`
            SELECT * FROM efficiency_events
            WHERE market_id = ? AND market_move_timestamp IS NOT NULL
            ORDER BY signal_timestamp DESC
        `).all(marketId);

        if (events.length === 0) {
            return { totalEvents: 0, message: 'No completed signal events recorded yet.' };
        }

        const avgResponse = events.reduce((s, e) => s + e.response_minutes, 0) / events.length;
        const avgOddsChange = events.reduce((s, e) => s + Math.abs(e.odds_change), 0) / events.length;
        const correctDirection = events.filter(e => e.odds_change > 0).length; // Odds moved up after signal

        return {
            totalEvents: events.length,
            avgResponseMinutes: parseFloat(avgResponse.toFixed(1)),
            avgOddsChange: parseFloat((avgOddsChange * 100).toFixed(1)),
            correctDirectionPct: parseFloat(((correctDirection / events.length) * 100).toFixed(1)),
        };
    }

    /**
     * Format efficiency report for human-readable output.
     */
    static formatReport(marketTitle, analysis) {
        if (analysis.score === -1) {
            return `\n⚡ ${marketTitle}: ${analysis.message}\n`;
        }

        const icon = analysis.score >= 6 ? '🎯' : analysis.score >= 4 ? '⚡' : '🔒';

        let r = `\n${icon} EFFICIENCY: ${marketTitle}\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Score: ${analysis.score}/10 — ${analysis.label}\n`;
        r += `  Data Points: ${analysis.dataPoints} snapshots over 7 days\n`;
        r += `\n  📈 Odds Range: ${analysis.oddsRange.min}% → ${analysis.oddsRange.max}% (${analysis.oddsRange.rangePct}% swing)\n`;
        r += `  📊 Volatility: ${analysis.volatility}\n`;
        r += `  ⏱️  Avg Response: ${analysis.avgResponseMinutes} min\n`;
        r += `  💤 Avg Stale Window: ${analysis.avgStaleMinutes} min\n`;
        r += `  🔥 Spike Events: ${analysis.spikeCount}\n`;
        r += `\n  🎯 Edge: ${analysis.edgeWindow}\n`;

        return r;
    }

    close() {
        if (this.db) {
            this.db.close();
            this.db = null;
        }
        this.pm.close();
    }
}

// ─── Self-test ─────────────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const scorer = new EfficiencyScorer();

    console.log('⚡ MARKET EFFICIENCY SCORER — SELF-TEST\n');

    // First, collect some snapshot data
    console.log('1. Collecting market snapshots...');
    const geoMarkets = await scorer.pm.getActiveGeopolitical();

    if (geoMarkets.length > 0) {
        scorer.pm.snapshotMarkets(geoMarkets);
        console.log(`   Snapshotted ${geoMarkets.length} markets`);

        // Score efficiency for top markets
        console.log('\n2. Scoring efficiency...');
        for (const m of geoMarkets.slice(0, 5)) {
            const analysis = scorer.scoreEfficiency(m.id);
            console.log(EfficiencyScorer.formatReport(m.title, analysis));
        }
    } else {
        console.log('  No geopolitical markets found.');
    }

    scorer.close();
    console.log('\n✅ Self-test complete.');
}

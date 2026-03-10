import 'dotenv/config';
import Database from 'better-sqlite3';
import { PolymarketConnector } from '../market/polymarket_api.js';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — CLI Dashboard
 *
 * Rich terminal output showing the state of the Truth Machine:
 * - Active markets with current odds
 * - Conviction scores per market
 * - Recent whale movements
 * - OSINT signal feed
 * - Open positions and P&L
 * - Audit trail of decisions
 *
 * Run: node src/truth_machine/dashboard.js
 * Auto-refresh: node src/truth_machine/dashboard.js --watch
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

export class Dashboard {
    constructor() {
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            try {
                this.db = new Database(DB_PATH, { readonly: true });
            } catch (e) {
                // DB doesn't exist yet — create it writable, then reopen readonly
                const initDb = new Database(DB_PATH);
                initDb.pragma('journal_mode = WAL');
                initDb.close();
                this.db = new Database(DB_PATH, { readonly: true });
            }
        }
        return this.db;
    }

    /**
     * Render the full dashboard to terminal.
     */
    render() {
        const db = this._getDb();

        console.clear();
        this._renderHeader();
        this._renderMarkets(db);
        this._renderConvictions(db);
        this._renderWhaleActivity(db);
        this._renderOsintFeed(db);
        this._renderOrders(db);
        this._renderPnL(db);
        this._renderFooter();
    }

    _renderHeader() {
        console.log('');
        console.log(`  ╔${'═'.repeat(58)}╗`);
        console.log(`  ║   🔮 TRUTH MACHINE — ORACLE TRANSPARENCY ENGINE           ║`);
        console.log(`  ║   ${new Date().toLocaleString().padEnd(55)}║`);
        console.log(`  ╚${'═'.repeat(58)}╝`);
        console.log('');
    }

    _renderMarkets(db) {
        console.log(`  ┌${'─'.repeat(58)}┐`);
        console.log(`  │ 📊 ACTIVE GEOPOLITICAL MARKETS                            │`);
        console.log(`  ├${'─'.repeat(58)}┤`);

        try {
            const markets = db.prepare(`
                SELECT * FROM markets WHERE active = 1 ORDER BY volume_24h DESC LIMIT 10
            `).all();

            if (markets.length === 0) {
                console.log(`  │ No markets tracked yet. Run: npm run truth -- --once     │`);
            } else {
                for (const m of markets) {
                    const odds = `${(m.odds_yes * 100).toFixed(1)}%`.padStart(6);
                    const vol = `$${Math.floor(m.volume_24h || 0).toLocaleString()}`.padStart(10);
                    const title = (m.title || '').slice(0, 35).padEnd(35);
                    const age = this._timeAgo(m.updated_at);
                    console.log(`  │ ${odds} │ ${title} │ ${vol} │ ${age.padEnd(4)} │`);
                }
            }
        } catch (e) {
            console.log(`  │ ⚠️  Database not initialized: ${e.message.slice(0, 35).padEnd(35)}│`);
        }

        console.log(`  └${'─'.repeat(58)}┘`);
        console.log('');
    }

    _renderConvictions(db) {
        console.log(`  ┌${'─'.repeat(58)}┐`);
        console.log(`  │ 🧠 CONVICTION SCORES (Last 24h)                           │`);
        console.log(`  ├${'─'.repeat(58)}┤`);

        try {
            const since = Date.now() - 24 * 60 * 60 * 1000;
            const convictions = db.prepare(`
                SELECT * FROM convictions WHERE created_at > ? ORDER BY total_score DESC LIMIT 8
            `).all(since);

            if (convictions.length === 0) {
                console.log(`  │ No convictions scored yet.                                │`);
            } else {
                for (const c of convictions) {
                    const icon = c.total_score >= 80 ? '🔴' : c.total_score >= 60 ? '🟠' : c.total_score >= 40 ? '🟡' : '⚪';
                    const score = `${c.total_score}`.padStart(3);
                    const rec = c.recommendation.padEnd(16);
                    const title = (c.market_title || '').slice(0, 28).padEnd(28);
                    const size = `$${c.suggested_size?.toFixed(0) || '0'}`.padStart(4);
                    console.log(`  │ ${icon} ${score}/100 │ ${rec} │ ${title} │ ${size} │`);
                }
            }
        } catch (e) {
            console.log(`  │ ⚠️  ${e.message.slice(0, 52).padEnd(52)}│`);
        }

        console.log(`  └${'─'.repeat(58)}┘`);
        console.log('');
    }

    _renderWhaleActivity(db) {
        console.log(`  ┌${'─'.repeat(58)}┐`);
        console.log(`  │ 🐋 WHALE ACTIVITY (Last 24h)                              │`);
        console.log(`  ├${'─'.repeat(58)}┤`);

        try {
            const since = Date.now() - 24 * 60 * 60 * 1000;
            const changes = db.prepare(`
                SELECT * FROM position_changes WHERE detected_at > ? ORDER BY detected_at DESC LIMIT 5
            `).all(since);

            if (changes.length === 0) {
                console.log(`  │ No whale movements detected.                             │`);
            } else {
                for (const c of changes) {
                    const wallet = `${c.wallet.slice(0, 8)}...${c.wallet.slice(-4)}`;
                    const type = c.change_type.padEnd(15);
                    const amount = `${c.amount_change || 0}`.padStart(8);
                    const age = this._timeAgo(c.detected_at);
                    console.log(`  │ ${wallet} │ ${type} │ ${amount} shares │ ${age.padEnd(4)} │`);
                }
            }

            // Clusters
            const clusters = db.prepare(`SELECT * FROM clusters ORDER BY confidence DESC LIMIT 3`).all();
            if (clusters.length > 0) {
                console.log(`  ├${'─'.repeat(58)}┤`);
                console.log(`  │ 👑 Known Clusters:                                        │`);
                for (const cl of clusters) {
                    const mother = `${cl.mother_wallet.slice(0, 10)}...`;
                    console.log(`  │   ${mother} → ${cl.wallet_count} wallets (${cl.confidence}% conf)${' '.repeat(Math.max(0, 17 - String(cl.wallet_count).length - String(cl.confidence).length))}│`);
                }
            }
        } catch (e) {
            console.log(`  │ ⚠️  ${e.message.slice(0, 52).padEnd(52)}│`);
        }

        console.log(`  └${'─'.repeat(58)}┘`);
        console.log('');
    }

    _renderOsintFeed(db) {
        console.log(`  ┌${'─'.repeat(58)}┐`);
        console.log(`  │ 📡 OSINT SIGNAL FEED (Last 6h)                            │`);
        console.log(`  ├${'─'.repeat(58)}┤`);

        try {
            const since = Date.now() - 6 * 60 * 60 * 1000;

            // Show signal scores
            const signals = db.prepare(`
                SELECT * FROM signal_scores WHERE created_at > ? ORDER BY strength DESC LIMIT 5
            `).all(since);

            if (signals.length === 0) {
                // Show recent articles instead
                const articles = db.prepare(`
                    SELECT * FROM articles WHERE fetched_at > ? ORDER BY published_at DESC LIMIT 5
                `).all(since);

                if (articles.length === 0) {
                    console.log(`  │ No OSINT data yet. Run: npm run osint                    │`);
                } else {
                    for (const a of articles) {
                        const title = a.title.slice(0, 45).padEnd(45);
                        const src = (a.source || '').slice(0, 8).padEnd(8);
                        console.log(`  │ ${src} │ ${title} │`);
                    }
                }
            } else {
                for (const s of signals) {
                    const icon = s.strength >= 60 ? '🔴' : s.strength >= 40 ? '🟡' : '🟢';
                    const str = `${s.strength}`.padStart(3);
                    const cat = (s.category || '').padEnd(14);
                    const srcs = `${s.source_count}src`.padEnd(4);
                    const age = this._timeAgo(s.created_at);
                    console.log(`  │ ${icon} ${str}/100 │ ${cat} │ ${srcs} │ ${age.padEnd(4)}${' '.repeat(Math.max(0, 20 - age.length))}│`);
                }
            }
        } catch (e) {
            console.log(`  │ ⚠️  ${e.message.slice(0, 52).padEnd(52)}│`);
        }

        console.log(`  └${'─'.repeat(58)}┘`);
        console.log('');
    }

    _renderOrders(db) {
        console.log(`  ┌${'─'.repeat(58)}┐`);
        console.log(`  │ 📋 ORDERS                                                 │`);
        console.log(`  ├${'─'.repeat(58)}┤`);

        try {
            const orders = db.prepare(`
                SELECT * FROM orders ORDER BY created_at DESC LIMIT 5
            `).all();

            if (orders.length === 0) {
                console.log(`  │ No orders staged yet.                                    │`);
            } else {
                for (const o of orders) {
                    const status = o.status.padEnd(8);
                    const side = o.side.padEnd(4);
                    const price = `$${o.price?.toFixed(2) || '0'}`.padStart(6);
                    const size = `${o.size || 0}`.padStart(5);
                    const title = (o.market_title || '').slice(0, 22).padEnd(22);
                    const icon = o.status === 'FILLED' ? '✅' : o.status === 'FAILED' ? '❌' : '📋';
                    console.log(`  │ ${icon} ${status} │ ${side} ${price} × ${size} │ ${title} │`);
                }
            }
        } catch (e) {
            console.log(`  │ ⚠️  ${e.message.slice(0, 52).padEnd(52)}│`);
        }

        console.log(`  └${'─'.repeat(58)}┘`);
        console.log('');
    }

    _renderPnL(db) {
        console.log(`  ┌${'─'.repeat(58)}┐`);
        console.log(`  │ 💰 P&L SUMMARY                                            │`);
        console.log(`  ├${'─'.repeat(58)}┤`);

        try {
            const filled = db.prepare("SELECT * FROM orders WHERE status = 'FILLED'").all();
            const dryRuns = db.prepare("SELECT * FROM orders WHERE status = 'DRY_RUN'").all();

            let totalInvested = 0;
            for (const o of filled) {
                if (o.side === 'BUY') totalInvested += (o.price || 0) * (o.size || 0);
            }

            console.log(`  │ Live Orders: ${String(filled.length).padStart(4)} │ Total Invested: $${totalInvested.toFixed(2).padStart(8)}         │`);
            console.log(`  │ Dry Runs:    ${String(dryRuns.length).padStart(4)} │                                          │`);
        } catch (e) {
            console.log(`  │ ⚠️  ${e.message.slice(0, 52).padEnd(52)}│`);
        }

        console.log(`  └${'─'.repeat(58)}┘`);
    }

    _renderFooter() {
        console.log('');
        console.log(`  Commands: npm run truth          (start scanner)`);
        console.log(`           npm run truth -- --once (single cycle)`);
        console.log(`           npm run truth:dash      (this dashboard)`);
        console.log(`           npm run whale:trace     (trace funding)`);
        console.log(`           npm run osint           (fetch news)`);
        console.log('');
    }

    _timeAgo(timestamp) {
        if (!timestamp) return '?';
        const mins = Math.floor((Date.now() - timestamp) / 60000);
        if (mins < 1) return 'now';
        if (mins < 60) return `${mins}m`;
        const hours = Math.floor(mins / 60);
        if (hours < 24) return `${hours}h`;
        return `${Math.floor(hours / 24)}d`;
    }

    close() {
        if (this.db) { this.db.close(); this.db = null; }
    }
}

// ─── CLI Entry Point ──────────────────────────────────────────

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
    const args = process.argv.slice(2);
    const watch = args.includes('--watch');

    const dash = new Dashboard();

    if (watch) {
        // Auto-refresh every 30 seconds
        const refresh = () => {
            try {
                // Re-open DB to get fresh data
                dash.db = null;
                dash.render();
            } catch (e) {
                console.log(`\n  ⚠️  Refresh error: ${e.message}`);
            }
        };

        refresh();
        const interval = setInterval(refresh, 30000);

        process.on('SIGINT', () => {
            clearInterval(interval);
            dash.close();
            process.exit(0);
        });
    } else {
        dash.render();
        dash.close();
    }
}

import 'dotenv/config';
import Database from 'better-sqlite3';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Event-to-Market Keyword Matcher
 *
 * Maps OSINT articles to Polymarket prediction markets using keyword matching.
 * When a news article contains terms related to an active market,
 * it generates a signal match with a strength score.
 *
 * The keyword registry is the bridge between real-world events
 * and market opportunities.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

// Keyword registry: maps terms to market categories and specific market IDs
// Market IDs are updated dynamically from the polymarket_api snapshots
const KEYWORD_REGISTRY = [
    {
        category: 'IRAQ_EMBASSY',
        keywords: ['baghdad embassy', 'us embassy iraq', 'embassy evacuation', 'embassy closure', 'staff relocation iraq', 'diplomatic withdrawal iraq'],
        weight: 10,
    },
    {
        category: 'IRAN_STRIKE',
        keywords: ['iran strike', 'strike iran', 'iran attack', 'iran military', 'iran nuclear', 'iran bomb', 'iran retaliation', 'iran tensions'],
        weight: 10,
    },
    {
        category: 'ISRAEL_GAZA',
        keywords: ['israel strike', 'gaza strike', 'idf operation', 'gaza offensive', 'hamas', 'hezbollah', 'iron dome', 'west bank raid'],
        weight: 9,
    },
    {
        category: 'CEASEFIRE',
        keywords: ['ceasefire', 'peace deal', 'peace agreement', 'peace talks', 'negotiations', 'truce', 'armistice', 'diplomatic solution'],
        weight: 8,
    },
    {
        category: 'US_MILITARY',
        keywords: ['us troops deploy', 'military deployment', 'pentagon orders', 'aircraft carrier', 'military buildup', 'troop movement', 'base activation'],
        weight: 9,
    },
    {
        category: 'UKRAINE_RUSSIA',
        keywords: ['ukraine offensive', 'russia attack', 'kherson', 'crimea', 'donbas', 'zaporizhzhia', 'ukraine ceasefire', 'nato ukraine'],
        weight: 8,
    },
    {
        category: 'CHINA_TAIWAN',
        keywords: ['taiwan strait', 'china military', 'taiwan invasion', 'pla exercise', 'south china sea', 'taiwan defense'],
        weight: 8,
    },
    {
        category: 'SANCTIONS',
        keywords: ['sanctions', 'economic sanctions', 'trade embargo', 'asset freeze', 'sanctions package', 'treasury sanctions'],
        weight: 7,
    },
    {
        category: 'NUCLEAR',
        keywords: ['nuclear test', 'nuclear weapon', 'nuclear threat', 'nuclear deal', 'enrichment', 'warhead', 'icbm', 'ballistic missile'],
        weight: 10,
    },
    {
        category: 'DIPLOMATIC',
        keywords: ['summit', 'state visit', 'foreign minister', 'secretary of state', 'un general assembly', 'security council vote', 'emergency session'],
        weight: 6,
    },
];

export class KeywordMatcher {
    constructor() {
        this.registry = KEYWORD_REGISTRY;
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS signals (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    article_id INTEGER,
                    market_id TEXT,
                    category TEXT,
                    match_score REAL,
                    keywords TEXT,
                    created_at INTEGER
                );
                CREATE TABLE IF NOT EXISTS keyword_market_map (
                    category TEXT,
                    market_id TEXT,
                    market_title TEXT,
                    updated_at INTEGER,
                    PRIMARY KEY(category, market_id)
                );
                CREATE INDEX IF NOT EXISTS idx_signals_market ON signals(market_id);
                CREATE INDEX IF NOT EXISTS idx_signals_created ON signals(created_at);
            `);
        }
        return this.db;
    }

    /**
     * Link a market category to a specific Polymarket market ID.
     * Call this after scanning markets to create the keyword->market mapping.
     * @param {string} category - Registry category (e.g., 'IRAN_STRIKE')
     * @param {string} marketId - Polymarket market ID
     * @param {string} marketTitle - Market title for reference
     */
    linkMarket(category, marketId, marketTitle) {
        const db = this._getDb();
        db.prepare(`
            INSERT INTO keyword_market_map (category, market_id, market_title, updated_at)
            VALUES (?, ?, ?, ?)
            ON CONFLICT(category, market_id) DO UPDATE SET
                market_title = excluded.market_title,
                updated_at = excluded.updated_at
        `).run(category, marketId, marketTitle, Date.now());
    }

    /**
     * Auto-link markets by scanning market titles against keyword registry.
     * @param {Array} markets - Parsed market objects from polymarket_api
     * @returns {number} Number of links created
     */
    autoLinkMarkets(markets) {
        let links = 0;

        for (const market of markets) {
            const title = (market.title || '').toLowerCase();

            for (const entry of this.registry) {
                const match = entry.keywords.some(kw => title.includes(kw));
                if (match) {
                    this.linkMarket(entry.category, market.id, market.title);
                    links++;
                }
            }
        }

        return links;
    }

    /**
     * Match articles against keyword registry and linked markets.
     * @param {Array} articles - Articles from rss_fetcher
     * @returns {Array} Signal matches with scores
     */
    matchSignals(articles) {
        const db = this._getDb();
        const matches = [];

        // Get all linked markets
        const linkedMarkets = db.prepare('SELECT * FROM keyword_market_map').all();
        const marketsByCategory = {};
        for (const lm of linkedMarkets) {
            if (!marketsByCategory[lm.category]) marketsByCategory[lm.category] = [];
            marketsByCategory[lm.category].push(lm);
        }

        for (const article of articles) {
            const text = `${article.title || ''} ${article.summary || ''}`.toLowerCase();

            for (const entry of this.registry) {
                const matchedKeywords = entry.keywords.filter(kw => text.includes(kw));

                if (matchedKeywords.length === 0) continue;

                // Calculate match score
                const keywordScore = matchedKeywords.length * entry.weight;
                const recency = this._recencyMultiplier(article.published_at || article.publishedAt);
                const reliability = (article.reliability || 5) / 10;

                const score = keywordScore * recency * reliability;

                // Get linked markets for this category
                const markets = marketsByCategory[entry.category] || [];

                if (markets.length === 0) {
                    // Category match but no linked market yet
                    matches.push({
                        articleId: article.id,
                        articleTitle: article.title,
                        source: article.source,
                        category: entry.category,
                        marketId: null,
                        marketTitle: null,
                        matchScore: parseFloat(score.toFixed(2)),
                        keywords: matchedKeywords,
                        recencyMultiplier: recency,
                        reliability: article.reliability,
                    });
                } else {
                    for (const market of markets) {
                        const signal = {
                            articleId: article.id,
                            articleTitle: article.title,
                            source: article.source,
                            category: entry.category,
                            marketId: market.market_id,
                            marketTitle: market.market_title,
                            matchScore: parseFloat(score.toFixed(2)),
                            keywords: matchedKeywords,
                            recencyMultiplier: recency,
                            reliability: article.reliability,
                        };

                        matches.push(signal);

                        // Persist signal
                        db.prepare(`
                            INSERT INTO signals (article_id, market_id, category, match_score, keywords, created_at)
                            VALUES (?, ?, ?, ?, ?, ?)
                        `).run(article.id || null, market.market_id, entry.category, score, matchedKeywords.join(','), Date.now());
                    }
                }
            }
        }

        // Sort by score descending
        matches.sort((a, b) => b.matchScore - a.matchScore);
        return matches;
    }

    /**
     * Recency multiplier: recent articles get higher weight.
     * Last hour = 2x, last 6h = 1.5x, last 24h = 1x, older = 0.5x
     */
    _recencyMultiplier(publishedAt) {
        if (!publishedAt) return 0.5;

        const ageMs = Date.now() - publishedAt;
        const ageHours = ageMs / (1000 * 60 * 60);

        if (ageHours < 1) return 2.0;
        if (ageHours < 6) return 1.5;
        if (ageHours < 24) return 1.0;
        if (ageHours < 72) return 0.7;
        return 0.5;
    }

    /**
     * Get recent signals from database.
     * @param {number} hours
     * @returns {Array} Recent signals
     */
    getRecentSignals(hours = 24) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);
        return db.prepare(`
            SELECT s.*, a.title as article_title, a.source as article_source, a.url as article_url
            FROM signals s
            LEFT JOIN articles a ON s.article_id = a.id
            WHERE s.created_at > ?
            ORDER BY s.match_score DESC
        `).all(since);
    }

    /**
     * Get linked markets.
     */
    getLinkedMarkets() {
        const db = this._getDb();
        return db.prepare('SELECT * FROM keyword_market_map ORDER BY category').all();
    }

    /**
     * Format match results for human-readable output.
     */
    static formatReport(matches) {
        let r = `\n🎯 KEYWORD MATCH REPORT\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Total Matches: ${matches.length}\n`;

        // Group by category
        const byCategory = {};
        for (const m of matches) {
            if (!byCategory[m.category]) byCategory[m.category] = [];
            byCategory[m.category].push(m);
        }

        for (const [cat, catMatches] of Object.entries(byCategory)) {
            const topScore = Math.max(...catMatches.map(m => m.matchScore));
            const icon = topScore >= 15 ? '🔴' : topScore >= 8 ? '🟡' : '🟢';

            r += `\n  ${icon} ${cat} (${catMatches.length} matches, top score: ${topScore})\n`;

            for (const m of catMatches.slice(0, 3)) {
                r += `     Score: ${m.matchScore} | "${m.articleTitle?.slice(0, 50)}..." (${m.source})\n`;
                r += `     Keywords: ${m.keywords.join(', ')}\n`;
                if (m.marketTitle) {
                    r += `     Market: ${m.marketTitle}\n`;
                }
            }
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
    const matcher = new KeywordMatcher();

    console.log('🎯 KEYWORD MATCHER — SELF-TEST\n');

    // Test with some mock articles
    const mockArticles = [
        { id: 1, title: 'US Embassy in Baghdad increases security amid rising tensions', summary: 'Staff relocation plans underway as regional conflict escalates', source: 'Reuters', reliability: 9, publishedAt: Date.now() - 3600000 },
        { id: 2, title: 'Iran warns of retaliation following military buildup', summary: 'Iranian officials issue statement about potential strike response', source: 'AP', reliability: 9, publishedAt: Date.now() - 7200000 },
        { id: 3, title: 'Local weather forecast for the weekend', summary: 'Sunny skies expected', source: 'WeatherBlog', reliability: 2, publishedAt: Date.now() },
        { id: 4, title: 'Pentagon orders aircraft carrier to Persian Gulf region', summary: 'Military deployment signals increased US presence', source: 'DoD', reliability: 10, publishedAt: Date.now() - 1800000 },
    ];

    console.log('1. Matching mock articles...');
    const matches = matcher.matchSignals(mockArticles);
    console.log(KeywordMatcher.formatReport(matches));

    // Show linked markets
    console.log('\n2. Linked markets:');
    const linked = matcher.getLinkedMarkets();
    if (linked.length > 0) {
        for (const l of linked) {
            console.log(`   ${l.category} → ${l.market_id} (${l.market_title})`);
        }
    } else {
        console.log('   No markets linked yet. Run polymarket_api.js first, then autoLinkMarkets()');
    }

    matcher.close();
    console.log('\n✅ Self-test complete.');
}

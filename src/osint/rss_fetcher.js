import 'dotenv/config';
import Database from 'better-sqlite3';
import fetch from 'node-fetch';
import crypto from 'crypto';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — OSINT RSS Feed Aggregator
 *
 * Monitors public news feeds for geopolitical signals.
 * Sources: State Dept, DoD, Reuters, AP, UN, and configurable RSS feeds.
 *
 * Fetches, deduplicates, and persists articles to SQLite.
 * Designed as the intake layer for the keyword_matcher and signal_scorer.
 *
 * All sources are PUBLIC. This is open-source intelligence, not surveillance.
 *
 * Note: Uses a lightweight XML parser instead of rss-parser to avoid
 * additional dependencies. Falls back to JSON APIs where available.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

// Default RSS/API feeds — all public sources
const DEFAULT_FEEDS = [
    {
        name: 'Reuters World',
        url: 'https://www.rss-bridge.org/bridge01/?action=display&bridge=Reuters&feed=world&format=Atom',
        type: 'rss',
        reliability: 9,
    },
    {
        name: 'AP News International',
        url: 'https://rss.app/feeds/v1.1/ts3qvvZlPCqfhSPt.json',
        type: 'json',
        reliability: 9,
    },
    {
        name: 'State Dept Briefings',
        url: 'https://www.state.gov/rss-feed/press-releases/feed/',
        type: 'rss',
        reliability: 10,
    },
    {
        name: 'DoD News',
        url: 'https://www.defense.gov/DesktopModules/ArticleCS/RSS.ashx?max=20&ContentType=1&Site=945',
        type: 'rss',
        reliability: 10,
    },
    {
        name: 'Al Jazeera',
        url: 'https://www.aljazeera.com/xml/rss/all.xml',
        type: 'rss',
        reliability: 7,
    },
    {
        name: 'BBC World',
        url: 'https://feeds.bbci.co.uk/news/world/rss.xml',
        type: 'rss',
        reliability: 8,
    },
];

export class RssFetcher {
    constructor(customFeeds = null) {
        this.feeds = customFeeds || DEFAULT_FEEDS;
        this.db = null;
        this.lastFetch = {};
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS articles (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    url_hash TEXT UNIQUE,
                    source TEXT,
                    title TEXT,
                    summary TEXT,
                    url TEXT,
                    reliability INTEGER DEFAULT 5,
                    published_at INTEGER,
                    fetched_at INTEGER
                );
                CREATE INDEX IF NOT EXISTS idx_articles_source ON articles(source);
                CREATE INDEX IF NOT EXISTS idx_articles_published ON articles(published_at);
            `);
        }
        return this.db;
    }

    /**
     * Fetch latest articles from all configured feeds.
     * Deduplicates by URL hash. Persists to SQLite.
     * @returns {Array} New articles (not previously seen)
     */
    async fetchLatest() {
        const allNew = [];

        for (const feed of this.feeds) {
            try {
                const articles = await this._fetchFeed(feed);
                const newArticles = this._persistArticles(articles, feed);
                allNew.push(...newArticles);
            } catch (e) {
                console.log(`  ⚠️  ${feed.name}: ${e.message}`);
            }
        }

        return allNew;
    }

    /**
     * Fetch a single feed and parse articles.
     * Supports RSS/Atom XML and JSON feeds.
     */
    async _fetchFeed(feed) {
        const response = await fetch(feed.url, {
            headers: {
                'Accept': 'application/rss+xml, application/atom+xml, application/json, text/xml',
                'User-Agent': 'OracleOSINT/1.0 (Research)',
            },
            timeout: 15000,
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
        }

        const text = await response.text();

        if (feed.type === 'json') {
            return this._parseJsonFeed(text, feed);
        } else {
            return this._parseRssFeed(text, feed);
        }
    }

    /**
     * Lightweight RSS/Atom XML parser.
     * Extracts title, link, description, pubDate from items/entries.
     */
    _parseRssFeed(xml, feed) {
        const articles = [];

        // Try RSS <item> format
        const itemPattern = /<item[^>]*>([\s\S]*?)<\/item>/gi;
        // Also try Atom <entry> format
        const entryPattern = /<entry[^>]*>([\s\S]*?)<\/entry>/gi;

        const items = [...xml.matchAll(itemPattern), ...xml.matchAll(entryPattern)];

        for (const match of items) {
            const item = match[1];

            const title = this._extractTag(item, 'title');
            const link = this._extractLink(item);
            const description = this._extractTag(item, 'description') ||
                               this._extractTag(item, 'summary') ||
                               this._extractTag(item, 'content');
            const pubDate = this._extractTag(item, 'pubDate') ||
                           this._extractTag(item, 'published') ||
                           this._extractTag(item, 'updated');

            if (title && link) {
                articles.push({
                    source: feed.name,
                    title: this._stripHtml(title).trim(),
                    summary: this._stripHtml(description || '').trim().slice(0, 500),
                    url: link,
                    reliability: feed.reliability,
                    publishedAt: pubDate ? new Date(pubDate).getTime() : Date.now(),
                });
            }
        }

        return articles;
    }

    /**
     * Parse JSON feed format (e.g., rss.app, custom APIs).
     */
    _parseJsonFeed(text, feed) {
        const data = JSON.parse(text);
        const items = data.items || data.articles || data.entries || [];

        return items.map(item => ({
            source: feed.name,
            title: (item.title || '').trim(),
            summary: (item.summary || item.description || item.content_text || '').trim().slice(0, 500),
            url: item.url || item.link || '',
            reliability: feed.reliability,
            publishedAt: item.date_published
                ? new Date(item.date_published).getTime()
                : (item.pubDate ? new Date(item.pubDate).getTime() : Date.now()),
        }));
    }

    /**
     * Persist articles to SQLite, deduplicating by URL hash.
     * @returns {Array} Only newly inserted articles
     */
    _persistArticles(articles, feed) {
        const db = this._getDb();
        const newArticles = [];
        const now = Date.now();

        const insert = db.prepare(`
            INSERT OR IGNORE INTO articles (url_hash, source, title, summary, url, reliability, published_at, fetched_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const txn = db.transaction((arts) => {
            for (const a of arts) {
                const urlHash = crypto.createHash('md5').update(a.url || a.title).digest('hex');
                const result = insert.run(urlHash, a.source, a.title, a.summary, a.url, a.reliability, a.publishedAt, now);
                if (result.changes > 0) {
                    newArticles.push({ ...a, urlHash });
                }
            }
        });

        txn(articles);
        return newArticles;
    }

    /**
     * Get recent articles from database.
     * @param {number} hours - How far back
     * @param {string} source - Optional source filter
     * @returns {Array} Articles
     */
    getRecent(hours = 24, source = null) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);

        if (source) {
            return db.prepare(`
                SELECT * FROM articles WHERE fetched_at > ? AND source = ? ORDER BY published_at DESC
            `).all(since, source);
        }

        return db.prepare(`
            SELECT * FROM articles WHERE fetched_at > ? ORDER BY published_at DESC
        `).all(since);
    }

    /**
     * Search articles by keyword.
     * @param {string} keyword
     * @param {number} hours - Time window
     * @returns {Array} Matching articles
     */
    search(keyword, hours = 168) {
        const db = this._getDb();
        const since = Date.now() - (hours * 60 * 60 * 1000);
        const pattern = `%${keyword}%`;

        return db.prepare(`
            SELECT * FROM articles
            WHERE (title LIKE ? OR summary LIKE ?) AND fetched_at > ?
            ORDER BY published_at DESC
        `).all(pattern, pattern, since);
    }

    // ─── XML Helpers ──────────────────────────────────────────────

    _extractTag(xml, tagName) {
        // Handle CDATA: <![CDATA[content]]>
        const cdataPattern = new RegExp(`<${tagName}[^>]*>\\s*<!\\[CDATA\\[([\\s\\S]*?)\\]\\]>\\s*</${tagName}>`, 'i');
        const cdataMatch = xml.match(cdataPattern);
        if (cdataMatch) return cdataMatch[1];

        const pattern = new RegExp(`<${tagName}[^>]*>([\\s\\S]*?)</${tagName}>`, 'i');
        const match = xml.match(pattern);
        return match ? match[1] : null;
    }

    _extractLink(xml) {
        // RSS: <link>url</link>
        const linkTag = this._extractTag(xml, 'link');
        if (linkTag && linkTag.startsWith('http')) return linkTag;

        // Atom: <link href="url"/>
        const atomLink = xml.match(/<link[^>]+href=["']([^"']+)["'][^>]*\/?>/i);
        if (atomLink) return atomLink[1];

        // Fallback: <guid>url</guid>
        const guid = this._extractTag(xml, 'guid');
        if (guid && guid.startsWith('http')) return guid;

        return linkTag || '';
    }

    _stripHtml(html) {
        return html
            .replace(/<[^>]*>/g, '')
            .replace(/&amp;/g, '&')
            .replace(/&lt;/g, '<')
            .replace(/&gt;/g, '>')
            .replace(/&quot;/g, '"')
            .replace(/&#39;/g, "'")
            .replace(/\s+/g, ' ');
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
    const fetcher = new RssFetcher();

    console.log('📡 RSS FETCHER — SELF-TEST\n');

    console.log('1. Fetching from all feeds...');
    const newArticles = await fetcher.fetchLatest();
    console.log(`   New articles: ${newArticles.length}\n`);

    // Show latest by source
    for (const feed of DEFAULT_FEEDS) {
        const articles = fetcher.getRecent(24, feed.name);
        console.log(`   📰 ${feed.name} (reliability: ${feed.reliability}/10): ${articles.length} articles`);
        for (const a of articles.slice(0, 2)) {
            console.log(`      "${a.title.slice(0, 70)}..."`);
        }
    }

    // Search test
    console.log('\n2. Searching for geopolitical keywords...');
    const geoTerms = ['iran', 'military', 'embassy', 'strike', 'troops'];
    for (const term of geoTerms) {
        const results = fetcher.search(term, 168);
        if (results.length > 0) {
            console.log(`   🔍 "${term}": ${results.length} matches`);
            console.log(`      Latest: "${results[0].title.slice(0, 60)}..." (${results[0].source})`);
        }
    }

    // Stats
    const db = fetcher._getDb();
    const total = db.prepare('SELECT COUNT(*) as c FROM articles').get();
    const sources = db.prepare('SELECT source, COUNT(*) as c FROM articles GROUP BY source').all();
    console.log(`\n3. Database stats:`);
    console.log(`   Total articles: ${total.c}`);
    for (const s of sources) {
        console.log(`   ${s.source}: ${s.c}`);
    }

    fetcher.close();
    console.log('\n✅ Self-test complete.');
}

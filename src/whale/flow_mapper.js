import 'dotenv/config';
import Database from 'better-sqlite3';
import { PolygonscanConnector } from './polygonscan.js';
import { fileURLToPath } from 'url';
import path from 'path';

/**
 * Oracle Truth Machine — Funding Flow Network Mapper
 *
 * Builds a directed graph of money flow between wallets.
 * Traces funding origins up to N hops deep.
 * Identifies "mother wallets" — wallets that fund multiple PM traders.
 *
 * Output: JSON adjacency list for visualization + SQLite persistence.
 *
 * All data is PUBLIC on-chain. This is the transparency X-ray.
 */

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const DB_PATH = path.join(__dirname, '..', '..', 'truth_machine.db');

export class FlowMapper {
    constructor() {
        this.ps = new PolygonscanConnector();
        this.db = null;
    }

    _getDb() {
        if (!this.db) {
            this.db = new Database(DB_PATH);
            this.db.pragma('journal_mode = WAL');
            this.db.exec(`
                CREATE TABLE IF NOT EXISTS flows (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    from_addr TEXT,
                    to_addr TEXT,
                    amount_pol REAL,
                    tx_count INTEGER,
                    first_seen TEXT,
                    hop_depth INTEGER,
                    root_target TEXT,
                    UNIQUE(from_addr, to_addr, root_target)
                );
                CREATE INDEX IF NOT EXISTS idx_flows_root ON flows(root_target);
                CREATE INDEX IF NOT EXISTS idx_flows_from ON flows(from_addr);
                CREATE INDEX IF NOT EXISTS idx_flows_to ON flows(to_addr);
            `);
        }
        return this.db;
    }

    /**
     * Trace funding origins for an address, up to N hops deep.
     * Builds a directed graph: funder → funded → funded → ...
     *
     * @param {string} address - Starting address to trace
     * @param {number} maxHops - Maximum depth (default 3)
     * @returns {Object} { nodes: [], edges: [], motherWallets: [] }
     */
    async traceOrigin(address, maxHops = 3) {
        const normalAddr = address.toLowerCase();
        const db = this._getDb();

        const nodes = new Map(); // address -> { address, label, depth, balance }
        const edges = []; // { from, to, amount, txCount }
        const visited = new Set();
        const queue = [{ address: normalAddr, depth: 0 }];

        // Add root node
        nodes.set(normalAddr, {
            address: normalAddr,
            label: 'TARGET',
            depth: 0,
            isRoot: true,
        });

        console.log(`  🔍 Tracing funding origin for ${normalAddr.slice(0, 10)}... (max ${maxHops} hops)`);

        while (queue.length > 0) {
            const { address: currentAddr, depth } = queue.shift();

            if (visited.has(currentAddr) || depth >= maxHops) continue;
            visited.add(currentAddr);

            try {
                const sources = await this.ps.getFundingSources(currentAddr);

                for (const source of sources) {
                    const funderAddr = source.address;

                    // Add funder node
                    if (!nodes.has(funderAddr)) {
                        nodes.set(funderAddr, {
                            address: funderAddr,
                            label: `HOP_${depth + 1}`,
                            depth: depth + 1,
                        });
                    }

                    // Add edge
                    edges.push({
                        from: funderAddr,
                        to: currentAddr,
                        amount: source.totalPOL,
                        txCount: source.txCount,
                        firstSeen: source.firstSeen,
                    });

                    // Persist flow
                    db.prepare(`
                        INSERT INTO flows (from_addr, to_addr, amount_pol, tx_count, first_seen, hop_depth, root_target)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(from_addr, to_addr, root_target) DO UPDATE SET
                            amount_pol = excluded.amount_pol,
                            tx_count = excluded.tx_count
                    `).run(funderAddr, currentAddr, source.totalPOL, source.txCount, source.firstSeen, depth + 1, normalAddr);

                    // Queue next hop (only trace significant funders)
                    if (source.totalPOL > 0.1 && depth + 1 < maxHops) {
                        queue.push({ address: funderAddr, depth: depth + 1 });
                    }
                }

                console.log(`     Hop ${depth}: ${currentAddr.slice(0, 10)}... → ${sources.length} funders`);
            } catch (e) {
                console.log(`     ⚠️  Error at ${currentAddr.slice(0, 10)}: ${e.message}`);
            }
        }

        // Identify mother wallets (nodes that fund 2+ tracked wallets)
        const outDegree = {};
        for (const edge of edges) {
            outDegree[edge.from] = (outDegree[edge.from] || 0) + 1;
        }

        const motherWallets = Object.entries(outDegree)
            .filter(([, count]) => count >= 2)
            .map(([addr, count]) => ({
                address: addr,
                fundedCount: count,
                totalFunded: edges
                    .filter(e => e.from === addr)
                    .reduce((s, e) => s + e.amount, 0),
                targets: edges
                    .filter(e => e.from === addr)
                    .map(e => e.to),
            }))
            .sort((a, b) => b.fundedCount - a.fundedCount);

        // Tag mother wallets in nodes
        for (const mw of motherWallets) {
            const node = nodes.get(mw.address);
            if (node) node.label = 'MOTHER_WALLET';
        }

        return {
            rootAddress: normalAddr,
            nodes: Array.from(nodes.values()),
            edges,
            motherWallets,
            totalNodes: nodes.size,
            totalEdges: edges.length,
            maxDepthReached: Math.max(...Array.from(nodes.values()).map(n => n.depth)),
        };
    }

    /**
     * Get persisted flow graph for a root address.
     * @param {string} rootAddress
     * @returns {Array} Stored flow edges
     */
    getStoredFlows(rootAddress) {
        const db = this._getDb();
        return db.prepare(`
            SELECT * FROM flows WHERE root_target = ? ORDER BY hop_depth ASC, amount_pol DESC
        `).all(rootAddress.toLowerCase());
    }

    /**
     * Export flow graph as JSON adjacency list for visualization.
     * Compatible with D3.js, vis.js, or Cytoscape.
     */
    exportForVisualization(flowGraph) {
        return {
            nodes: flowGraph.nodes.map(n => ({
                id: n.address,
                label: `${n.label}\n${n.address.slice(0, 8)}...`,
                group: n.label,
                level: n.depth,
            })),
            edges: flowGraph.edges.map((e, i) => ({
                id: `e${i}`,
                from: e.from,
                to: e.to,
                label: `${e.amount.toFixed(2)} POL`,
                arrows: 'to',
            })),
        };
    }

    /**
     * Format flow graph for terminal output.
     */
    static formatReport(flowGraph) {
        let r = `\n🌊 FUNDING FLOW MAP\n`;
        r += `${'─'.repeat(60)}\n`;
        r += `  Root: ${flowGraph.rootAddress}\n`;
        r += `  Nodes: ${flowGraph.totalNodes} | Edges: ${flowGraph.totalEdges}\n`;
        r += `  Max Depth: ${flowGraph.maxDepthReached} hops\n`;

        if (flowGraph.motherWallets.length > 0) {
            r += `\n  👑 Mother Wallets (${flowGraph.motherWallets.length}):\n`;
            for (const mw of flowGraph.motherWallets) {
                r += `     ${mw.address.slice(0, 10)}...${mw.address.slice(-6)}\n`;
                r += `       Funded ${mw.fundedCount} wallets | Total: ${mw.totalFunded.toFixed(2)} POL\n`;
                for (const t of mw.targets) {
                    r += `       → ${t.slice(0, 10)}...${t.slice(-6)}\n`;
                }
            }
        }

        r += `\n  🔗 Flow Edges:\n`;
        for (const e of flowGraph.edges.slice(0, 20)) {
            r += `     ${e.from.slice(0, 8)}... → ${e.to.slice(0, 8)}... | ${e.amount.toFixed(2)} POL (${e.txCount} txs)\n`;
        }
        if (flowGraph.edges.length > 20) {
            r += `     ... and ${flowGraph.edges.length - 20} more edges\n`;
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
    const mapper = new FlowMapper();

    console.log('🌊 FLOW MAPPER — SELF-TEST\n');

    const targetAddr = process.argv[2] || process.env.ETH_WALLET_ADDRESS;
    const maxHops = parseInt(process.argv[3]) || 2;

    if (!targetAddr) {
        console.log('  Usage: node flow_mapper.js <address> [maxHops]');
        console.log('  Or set ETH_WALLET_ADDRESS in .env\n');

        // Show stored flows
        const db = mapper._getDb();
        const stored = db.prepare('SELECT DISTINCT root_target FROM flows').all();
        if (stored.length > 0) {
            console.log('  Stored flow graphs:');
            for (const s of stored) {
                const edgeCount = db.prepare('SELECT COUNT(*) as c FROM flows WHERE root_target = ?').get(s.root_target);
                console.log(`    ${s.root_target.slice(0, 10)}... — ${edgeCount.c} edges`);
            }
        }
    } else {
        console.log(`  Target: ${targetAddr}`);
        console.log(`  Max Hops: ${maxHops}\n`);

        const graph = await mapper.traceOrigin(targetAddr, maxHops);
        console.log(FlowMapper.formatReport(graph));

        // Export for visualization
        const vizData = mapper.exportForVisualization(graph);
        console.log('\n  📊 Visualization data (JSON):');
        console.log(`     ${vizData.nodes.length} nodes, ${vizData.edges.length} edges`);
    }

    mapper.close();
    console.log('\n✅ Self-test complete.');
}

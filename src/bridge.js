/**
 * 🌉 Oracle → Solo-Mode-MVP Bridge
 * Forwards trading signals to the Wealth Engine backend.
 *
 * WE-002: Create Oracle Signal Forwarder
 *
 * Usage:
 *   import { forwardSignal } from './bridge.js';
 *   await forwardSignal(analysisResult);
 */

const SOLO_MODE_URL = process.env.SOLO_MODE_URL || 'http://localhost:8080';

/**
 * Forward a single analysis result to Solo-Mode-MVP.
 * Gracefully fails if backend is down.
 */
export async function forwardSignal(analysis) {
    if (!analysis || !analysis.symbol || analysis.score === undefined) return;

    // Only forward signals with score >= 5 (worth tracking)
    if (analysis.score < 5) return;

    const payload = {
        ticker: analysis.symbol,
        score: analysis.score,
        direction: analysis.recommendation === 'SHORT' ? 'SHORT' : 'LONG',
        conviction: Math.min(100, analysis.score * 10),
        sources: buildSourceList(analysis),
        price_at_signal: analysis.price || 0,
        metadata: {
            rsi: analysis.rsi,
            macd_signal: analysis.macdSignal,
            bollinger_position: analysis.bollingerPosition,
            atr: analysis.atr,
            risk_check: analysis.riskCheck || null,
            scanned_at: new Date().toISOString()
        }
    };

    try {
        const response = await fetch(`${SOLO_MODE_URL}/api/oracle/signal`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload),
            signal: AbortSignal.timeout(5000), // 5s timeout
        });

        if (response.ok) {
            const result = await response.json();
            console.log(`  🌉 Bridge: ${analysis.symbol} → Solo-Mode (signal_id: ${result.signal_id})`);
        } else {
            console.log(`  🌉 Bridge: ${analysis.symbol} → Failed (HTTP ${response.status})`);
        }
    } catch (err) {
        // Graceful failure — don't interrupt scanning
        console.log(`  🌉 Bridge: ${analysis.symbol} → Offline (${err.message})`);
    }
}

/**
 * Forward all results from a scan batch.
 */
export async function forwardBatch(results) {
    const forwarded = [];
    for (const r of results) {
        if (r.score >= 5 && !r.error) {
            await forwardSignal(r);
            forwarded.push(r.symbol);
        }
    }
    if (forwarded.length > 0) {
        console.log(`\n  🌉 Bridge: Forwarded ${forwarded.length} signals to Wealth Engine`);
    }
    return forwarded;
}

/**
 * Build source list from analysis flags.
 */
function buildSourceList(analysis) {
    const sources = [];
    if (analysis.rsi) sources.push(analysis.rsi < 30 ? 'RSI_OVERSOLD' : analysis.rsi > 70 ? 'RSI_OVERBOUGHT' : 'RSI');
    if (analysis.macdSignal) sources.push('MACD');
    if (analysis.bollingerPosition) sources.push('BOLLINGER');
    if (analysis.atr) sources.push('ATR');
    if (analysis.insiderSignal) sources.push('INSIDER');
    if (analysis.congressSignal) sources.push('CONGRESS');
    if (analysis.whaleSignal) sources.push('WHALE');
    return sources;
}

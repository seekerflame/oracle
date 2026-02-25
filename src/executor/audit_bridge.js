import { ethers } from 'ethers';

/**
 * audit_bridge.js
 * 🏹 ARBITRUM BRIDGE AUDIT
 * 
 * Scans recent blocks to find the bridge initiation transaction.
 */

async function findBridgeTx() {
    const p = new ethers.JsonRpcProvider('https://arb1.arbitrum.io/rpc');
    const w = process.env.ETH_WALLET_ADDRESS;

    console.log('--- 🏹 ARBITRUM BRIDGE TRACE ---');
    try {
        const latest = await p.getBlockNumber();
        console.log(`Latest Block: ${latest}`);

        // Scan last 10,000 blocks (~40 mins on Arbitrum Nitro)
        for (let i = 0; i < 10000; i++) {
            const block = await p.getBlock(latest - i, true);
            if (!block) continue;

            const txs = block.transactions.filter(tx => tx && tx.from && tx.from.toLowerCase() === w.toLowerCase());
            txs.forEach(tx => {
                console.log('\n--- MATCH FOUND ---');
                console.log(`  Block: ${latest - i}`);
                console.log(`  Hash:  ${tx.hash}`);
                console.log(`  To:    ${tx.to}`);
                console.log(`  Val:   ${ethers.formatEther(tx.value)} ETH`);
            });
        }
        console.log('\n--- SCAN COMPLETE ---');

    } catch (e) {
        console.log(`  ❌ Error: ${e.message}`);
    }
}

findBridgeTx();

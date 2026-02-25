import { ethers } from 'ethers';

async function run() {
    const RPCS = [
        'https://polygon-rpc.com',
        'https://rpc.ankr.com/polygon',
        'https://polygon-bor-rpc.publicnode.com'
    ];
    let rpcIdx = 0;
    let p = new ethers.JsonRpcProvider(RPCS[rpcIdx]);

    const targets = [
        '0x22f6eb410e30c8f1c6971f0b04e11cfbcf9047b1'.toLowerCase(),
        '0x5A7FF38139B8468f1b9d06A13A308788Bd20Aca9'.toLowerCase()
    ];
    const latest = await p.getBlockNumber();
    console.log(`--- 🐋 GENESIS TRACE: SCANNING BLOCKS (Latest: ${latest}) ---`);
    console.log(`Targets: ${targets.join(', ')}`);

    // Segmented Scan: 500 blocks at a time, 10s delay
    const totalToScan = 500;
    for (let i = 0; i < totalToScan; i++) {
        const blockNum = latest - i;
        let block;
        let retries = 0;

        while (!block && retries < 3) {
            try {
                block = await p.getBlock(blockNum, true);
                // Heavy delay to bypass aggressive rate limits
                await new Promise(r => setTimeout(r, 10000));
            } catch (e) {
                console.log(`  ⚠️  RPC Error/Limit on ${RPCS[rpcIdx]}, rotating...`);
                rpcIdx = (rpcIdx + 1) % RPCS.length;
                p = new ethers.JsonRpcProvider(RPCS[rpcIdx]);
                await new Promise(r => setTimeout(r, 15000));
                retries++;
            }
        }

        if (!block) {
            console.log(`  ❌ Failed to fetch block ${blockNum} after 5 retries.`);
            continue;
        }

        for (const tx of block.transactions) {
            if (tx.to && targets.includes(tx.to.toLowerCase())) {
                console.log('  🎯 FUNDING FOUND!');
                console.log('  To:', tx.to);
                console.log('  From:', tx.from);
                console.log('  Value:', ethers.formatEther(tx.value), 'POL');
                console.log('  Time:', new Date(block.timestamp * 1000).toISOString());
                console.log('  Hash:', tx.hash);
            }
        }

        if (i % 500 === 0 && i !== 0) {
            console.log(`    ...scanned ${i} blocks`);
        }
    }
    console.log('--- 🐋 TRACE COMPLETE ---');
}

run();

import { ethers } from 'ethers';

async function run() {
    const rpcs = [
        'https://polygon-rpc.com',
        'https://rpc.ankr.com/polygon',
        'https://1rpc.io/matic'
    ];
    const oracle = process.env.ETH_WALLET_ADDRESS;
    let bal = 0n;
    let successRpc = '';

    for (const rpc of rpcs) {
        try {
            const p = new ethers.JsonRpcProvider(rpc);
            await p.getNetwork(); // Verify connection
            bal = await p.getBalance(oracle);
            successRpc = rpc;
            break;
        } catch (e) { }
    }

    const initial = 9.69;
    const current = parseFloat(ethers.formatEther(bal));
    const burn = initial - current;

    console.log('--- 🛑 FINAL GAS AUDIT ---');
    console.log('Provider:', successRpc);
    console.log('Initial POL:', initial);
    console.log('Current POL:', current.toFixed(4));
    console.log('Total Burned (Gas):', burn.toFixed(4), 'POL');
    console.log('USD Equivalent Spend: ~$' + (burn * 0.40).toFixed(4));
    console.log('--------------------------');
}
run();

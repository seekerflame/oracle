import 'dotenv/config';
import { ethers } from 'ethers';

/**
 * swap_usdc.js
 * 🔄 THE RUDY RAID: Asset Conversion
 * 
 * Swaps Native USDC (0x3c49...) for Bridged USDC (USDC.e, 0x2791...) on Polygon
 * to satisfy PolyMarket liquidity requirements.
 */

const ETH_PRIVATE_KEY = process.env.ETH_PRIVATE_KEY;
const NATIVE_USDC = '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359';
const BRIDGED_USDC = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
const UNISWAP_V3_ROUTER = '0xE592427A0AEce92De3Edee1F18E0157C05861564';

async function performSwap() {
    console.log('--- 🔄 CURRENCY CONVERSION: NATIVE -> BRIDGED ---');

    const provider = new ethers.JsonRpcProvider('https://polygon.drpc.org');
    const wallet = new ethers.Wallet(ETH_PRIVATE_KEY, provider);

    const abi = [
        "function balanceOf(address) view returns (uint256)",
        "function approve(address, uint256) returns (bool)",
        "function exactInputSingle((address tokenIn, address tokenOut, uint24 fee, address recipient, uint256 deadline, uint256 amountIn, uint256 amountOutMinimum, uint160 sqrtPriceLimitX96)) external returns (uint256)"
    ];

    const nativeContract = new ethers.Contract(NATIVE_USDC, abi, wallet);
    const balance = await nativeContract.balanceOf(wallet.address);

    console.log(`     Available Native USDC: ${ethers.formatUnits(balance, 6)}`);

    if (balance === 0n) {
        console.log('  🛑 No Native USDC found. Verify bridge status.');
        return;
    }

    // Amount to swap: All available native USDC
    const amountIn = balance;

    // 1. Approve Router
    console.log('  🔓 Approving Uniswap V3 Router...');
    const approveTx = await nativeContract.approve(UNISWAP_V3_ROUTER, amountIn);
    await approveTx.wait();
    console.log('     Approval Confirmed.');

    // 2. Perform Swap
    const router = new ethers.Contract(UNISWAP_V3_ROUTER, abi, wallet);

    const params = {
        tokenIn: NATIVE_USDC,
        tokenOut: BRIDGED_USDC,
        fee: 500, // 0.05% fee tier (usually most liquid for stables)
        recipient: wallet.address,
        deadline: Math.floor(Date.now() / 1000) + 60 * 10, // 10 minutes
        amountIn: amountIn,
        amountOutMinimum: 0, // In production, use a slippage check
        sqrtPriceLimitX96: 0
    };

    console.log('  🚀 Executing Swap on Uniswap V3...');
    try {
        const tx = await router.exactInputSingle(params);
        console.log('     Transaction Sent:', tx.hash);
        const receipt = await tx.wait();
        console.log('  ✅ Swap Complete. USDC.e is now LIVE.');
    } catch (e) {
        console.log('  ❌ Swap Failed:', e.message);
        console.log('     Trying 100 fee tier...');
        params.fee = 100; // Try 0.01%
        const tx2 = await router.exactInputSingle(params);
        await tx2.wait();
        console.log('  ✅ Swap Complete (0.01% tier).');
    }
}

performSwap();

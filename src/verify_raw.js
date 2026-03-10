import { ethers } from 'ethers';
import 'dotenv/config';

async function verifyAllowance() {
    const provider = new ethers.JsonRpcProvider('https://polygon-bor-rpc.publicnode.com');
    const wallet = new ethers.Wallet(process.env.ETH_PRIVATE_KEY, provider);
    
    // USDC.e on Polygon
    const collateralAddress = '0x2791Bca1f2de4661ED88A30C99A7a9449Aa84174';
    // CTF Exchange / Proxy address for Polymarket
    const spenderAddress = '0x4bFb41d5B3570DeFd03C39a9A4D8dE6Bd8B8982E'; // Expected spender

    const abi = ["function allowance(address owner, address spender) view returns (uint256)", "function balanceOf(address account) view returns (uint256)"];
    const contract = new ethers.Contract(collateralAddress, abi, provider);

    console.log(`🧪 RAW VERIFICATION: Checking ${wallet.address}...`);
    try {
        const balance = await contract.balanceOf(wallet.address);
        console.log(`💰 USDC.e Balance: ${ethers.formatUnits(balance, 6)}`);
        
        const allowance = await contract.allowance(wallet.address, spenderAddress);
        console.log(`💰 Allowance for Polymarket: ${ethers.formatUnits(allowance, 6)}`);
        
    } catch (e) {
        console.error(`❌ Raw Verification Failed: ${e.message}`);
    }
}

verifyAllowance();

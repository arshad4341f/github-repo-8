const Web3 = require('web3');
const { ChainId, Fetcher, Route, Trade, TokenAmount, TradeType, Percent } = require('@uniswap/sdk');
const axios = require('axios');
const WebSocket = require('ws');
const { ethers } = require('ethers');
const dotenv = require('dotenv');

// Load environment variables from a .env file
dotenv.config();

// Setup Web3 and connect to the blockchain
const web3 = new Web3(process.env.INFURA_OR_NODE_URL);
const myAccount = web3.eth.accounts.privateKeyToAccount(process.env.PRIVATE_KEY);
web3.eth.accounts.wallet.add(myAccount);

// Define ABI and addresses for Aave and USDT
const AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI = require('./AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI.json');
const AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS = process.env.AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS;
const AAVE_LENDING_POOL_ABI = require('./AAVE_LENDING_POOL_ABI.json');
const USDT_ABI = require('./USDT_ABI.json');
const USDT_ADDRESS = process.env.USDT_ADDRESS;

// DEX APIs and WebSocket endpoints
const DEX_APIS = {
    uniswapV2: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v2',
    uniswapV3: 'https://api.thegraph.com/subgraphs/name/uniswap/uniswap-v3',
    // Add more DEX endpoints as needed
};
const WEBSOCKET_ENDPOINTS = {
    uniswapV2: 'wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID,
    uniswapV3: 'wss://mainnet.infura.io/ws/v3/' + process.env.INFURA_PROJECT_ID,
    // Add more WebSocket endpoints as needed
};

// Fetch pairs from Uniswap subgraphs
async function fetchPairs(dex) {
    const query = `{ pairs(first: 1000) { id token0 { id } token1 { id } reserve0 reserve1 } }`;
    const response = await axios.post(DEX_APIS[dex], { query });
    return response.data.data.pairs;
}

// WebSocket setup to receive real-time data
function setupWebSocket(dex, callback) {
    const ws = new WebSocket(WEBSOCKET_ENDPOINTS[dex]);
    ws.on('open', () => {
        console.log(`Connected to ${dex} WebSocket`);
        // Subscribe to token pair updates (replace with appropriate subscription logic for the dex)
        ws.send(JSON.stringify({ method: 'subscribe', params: ['newPendingTransactions'], id: 1, jsonrpc: '2.0' }));
    });
    ws.on('message', (data) => {
        const parsedData = JSON.parse(data);
        if (parsedData && parsedData.params && parsedData.params.result) {
            callback(parsedData.params.result);
        }
    });
    ws.on('error', (error) => {
        console.error(`WebSocket error on ${dex}:`, error);
    });
    ws.on('close', () => {
        console.log(`WebSocket connection to ${dex} closed`);
        // Reconnect after a delay
        setTimeout(() => setupWebSocket(dex, callback), 1000); // Reduced delay for quicker reconnection
    });
}

// Fetch real-time gas price from the Infura API
async function fetchRealTimeGasPrice() {
    const response = await axios.get(`https://mainnet.infura.io/v3/${process.env.INFURA_PROJECT_ID}/eth_gasPrice`);
    return parseFloat(web3.utils.fromWei(response.data.result, 'gwei'));
}

// Function to fetch price data from various DEXs using The Graph API
async function fetchPriceFromGraphAPI(dex, token0Address, token1Address) {
    const query = `{ pair(id: "${token0Address.toLowerCase()}-${token1Address.toLowerCase()}") { token0 { id } token1 { id } reserve0 reserve1 } }`;
    const response = await axios.post(DEX_APIS[dex], { query });
    const pair = response.data.data.pair;
    if (pair) {
        const price = parseFloat(pair.reserve1) / parseFloat(pair.reserve0);
        return price;
    }
    throw new Error(`Failed to fetch price from ${dex}`);
}

// Function to fetch price data from multiple DEXs
async function getPriceData(token0Address, token1Address) {
    const pricePromises = Object.keys(DEX_APIS).map(dex => fetchPriceFromGraphAPI(dex, token0Address, token1Address));
    const prices = await Promise.all(pricePromises);
    return prices.reduce((acc, price, index) => {
        acc[Object.keys(DEX_APIS)[index]] = price;
        return acc;
    }, {});
}

// Function to calculate potential profit considering fees and slippage
async function calculateProfit(price1, price2, amount) {
    const tradingFee = 0.003; // Example trading fee of 0.3%
    const gasPriceGwei = await fetchRealTimeGasPrice();
    const gasPriceEth = web3.utils.fromWei(gasPriceGwei.toString(), 'gwei');
    const gasFee = gasPriceEth * 21000; // Example gas fee in ETH for a simple transaction
    const profit = (price1 - price2) * amount;
    const netProfit = profit - (profit * tradingFee * 2) - gasFee;
    return netProfit;
}

// Function to detect arbitrage opportunities
async function detectArbitrage() {
    try {
        const pairsV2 = await fetchPairs('uniswapV2');
        const pairsV3 = await fetchPairs('uniswapV3');
        const pairs = [...pairsV2, ...pairsV3];
        for (const pair of pairs) {
            const prices = await getPriceData(pair.token0.id, pair.token1.id);
            console.log('Prices:', prices);
            // Identify arbitrage opportunities
            const priceEntries = Object.entries(prices);
            for (let i = 0; i < priceEntries.length; i++) {
                for (let j = i + 1; j < priceEntries.length; j++) {
                    const [dex1, price1] = priceEntries[i];
                    const [dex2, price2] = priceEntries[j];
                    const amount = 10; // Example amount to trade
                    if (price1 > price2) {
                        const profit = await calculateProfit(price1, price2, amount);
                        if (profit > 0.5) { // Ensure profit is more than $0.5
                            console.log(`Arbitrage opportunity detected between ${dex1} and ${dex2}! Profit: ${profit}`);
                            // Execute flash loan and arbitrage trade
                            await executeFlashLoanAndTrade(pair.token0.id, amount, dex1, dex2, profit);
                        }
                    }
                }
            }
        }
    } catch (error) {
        console.error('Error detecting arbitrage:', error);
    }
}

// Function to execute flash loan and arbitrage trade
async function executeFlashLoanAndTrade(tokenAddress, amount, dex1, dex2, expectedProfit) {
    // Recheck the profit potential before executing the transaction
    const prices = await getPriceData(tokenAddress, 'ETH'); // Example with ETH as the second token
    const price1 = prices[dex1];
    const price2 = prices[dex2];
    const profit = await calculateProfit(price1, price2, amount);
    if (profit < 0.5) {
        console.log('Profit potential decreased, transaction aborted.');
        return;
    }

    // Flash loan logic using Aave protocol
    const lendingPoolAddressProvider = new web3.eth.Contract(
        AAVE_LENDING_POOL_ADDRESS_PROVIDER_ABI,
        AAVE_LENDING_POOL_ADDRESS_PROVIDER_ADDRESS
    );
    const lendingPoolAddress = await lendingPoolAddressProvider.methods.getLendingPool().call();
    const lendingPool = new web3.eth.Contract(AAVE_LENDING_POOL_ABI, lendingPoolAddress);

    const flashLoanParams = web3.eth.abi.encodeParameters(
        ['address', 'address', 'uint256', 'address', 'bytes'],
        [
            dex1, // DEX 1 address
            dex2, // DEX 2 address
            amount,
            tokenAddress,
            web3.eth.abi.encodeParameters(
                ['address', 'address', 'uint256'],
                [dex1, dex2, amount]
            )
        ]
    );

    const flashLoanTx = lendingPool.methods.flashLoan(
        myAccount.address,
        [tokenAddress],
        [amount],
        [0], // no debt
        myAccount.address,
        flashLoanParams,
        0
    );

    const gas = await flashLoanTx.estimateGas({ from: myAccount.address });
    const gasPrice = await web3.eth.getGasPrice();
    const tx = {
        from: myAccount.address,
        to: lendingPoolAddress,
        data: flashLoanTx.encodeABI(),
        gas,
        gasPrice
    };
    const receipt = await web3.eth.sendTransaction(tx);
    console.log('Flash loan executed', receipt);
}

// Function to detect sandwich opportunities
async function detectSandwich() {
    web3.eth.subscribe('pendingTransactions', async (error, txHash) => {
        if (error) console.error('Error subscribing to pending transactions:', error);
        try {
            const tx = await web3.eth.getTransaction(txHash);
            // Analyze the transaction for sandwich opportunities (e.g., check if it's a large trade that can be sandwiched)
            // Implement sandwich logic
        } catch (error) {
            console.error('Error processing pending transaction:', error);
        }
    });
}

// Setup WebSockets and start monitoring
setupWebSocket('uniswapV2', detectArbitrage);
setupWebSocket('uniswapV3', detectArbitrage);
detectSandwich();

console.log('Arbitrage and sandwich bot running...');

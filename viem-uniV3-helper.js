import { getContract, hexToBigInt } from "viem";
import { computePoolAddress } from "@uniswap/v3-sdk";
import IUniswapV3PoolABI from "@uniswap/v3-core/artifacts/contracts/interfaces/IUniswapV3Pool.sol/IUniswapV3Pool.json" assert { type: "json" };
import ContractAddresses from "./contract_addresses.json" assert { type: "json" };
import { getERC20Balance } from "./viem-chain-helper.js";

export const getPoolString = (chainKey, token0Symbol, token1Symbol, fee) =>
  `[${chainKey} - UniV3 ${token0Symbol} ${token1Symbol} ${
    (fee / 10 ** 6) * 100 * 100
  }bps]`;

const getPoolContract = async (chain, client, token0, token1, fee) => {
  const poolAddress = computePoolAddress({
    factoryAddress: ContractAddresses[chain.key].uniV3FactoryAddress,
    tokenA: token0,
    tokenB: token1,
    fee: fee,
  });

  const contract = getContract({
    address: poolAddress,
    abi: IUniswapV3PoolABI.abi,
    client: client,
  });

  const tickSpacing = await contract.read.tickSpacing().then((v) => Number(v));

  console.log(
    `${getPoolString(
      chain.key,
      token0.symbol,
      token1.symbol,
      fee
    )}[Init] ${tickSpacing}ts | ${poolAddress}`
  );

  getInitializedTicks(client, contract, tickSpacing);

  return [contract, tickSpacing];
};

function tickToWord(tick, tickSpacing) {
  let compressed = Math.floor(tick / tickSpacing);
  if (tick < 0 && tick % tickSpacing !== 0) {
    compressed -= 1;
  }
  return compressed >> 8;
}

const getInitializedTicks = async (client, contract, tickSpacing) => {
  const minWord = tickToWord(-887272, tickSpacing);
  const maxWord = tickToWord(887272, tickSpacing);

  let calls = [];
  let wordPosIndices = [];
  for (let i = minWord; i <= maxWord; i++) {
    wordPosIndices.push(i);
    calls.push({
      address: contract.address,
      abi: contract.abi,
      functionName: "tickBitmap",
      args: [i],
    });
  }

  const results = await client.multicall({
    contracts: calls,
    allowFailure: false,
  });

  const tickIndices = [];
  for (let j = 0; j < wordPosIndices.length; j++) {
    const ind = wordPosIndices[j];
    const bitmap = results[j];

    if (bitmap !== 0n) {
      for (let i = 0; i < 256; i++) {
        const bit = 1n;
        const initialized = (bitmap & (bit << BigInt(i))) !== 0n;
        if (initialized) {
          const tickIndex = (ind * 256 + i) * tickSpacing;
          tickIndices.push(tickIndex);
        }
      }
    }
  }

  return tickIndices;
};

const getTickInfo = async (client, contract, tickIndices) => {
  return client.multicall({
    contracts: tickIndices.map((v) => ({
      address: contract.address,
      abi: contract.abi,
      functionName: "ticks",
      args: [v],
    })),
    allowFailure: false,
  });
};

export const getInitPoolData = async (chain, client, tokenA, tokenB, fee) => {
  const [token0, token1] =
    hexToBigInt(tokenA.address) < hexToBigInt(tokenB.address)
      ? [tokenA, tokenB]
      : [tokenB, tokenA];

  const [contract, tickSpacing] = await getPoolContract(
    chain,
    client,
    token0,
    token1,
    fee
  );
  const tickIndices = await getInitializedTicks(client, contract, tickSpacing);
  const tickInfos = await getTickInfo(client, contract, tickIndices);

  const [slot0, liquidity, token0Bal, token1Bal, blockNumber] =
    await Promise.all([
      contract.read.slot0(),
      contract.read.liquidity(),
      getERC20Balance(contract.address, token0.address, client),
      getERC20Balance(contract.address, token1.address, client),
      client.getBlockNumber(),
    ]);

  const pool = {
    blockNumber: blockNumber,
    ticks: {},
    slot0,
    liquidity,
    poolAddress: contract.address.toLowerCase(),
    reserve: [token0Bal, token1Bal],
    poolKey: {
      base: token0.address,
      quote: token1.address,
      tickSpacing,
      fee,
      extra: "",
    },
  };
  tickIndices.forEach((v, i) => {
    pool["ticks"][v] = [tickInfos[i][0], tickInfos[i][1]];
  });

  return pool;
};

export const updatePoolData = (pool, log) => {
  if (log.eventName === "Swap") {
    pool.reserve[0] += log.args.amount0;
    pool.reserve[1] += log.args.amount1;
    pool.slot0[0] = log.args.sqrtPriceX96;
    pool.slot0[1] = log.args.tick;
    pool.liquidity = log.args.liquidity;
  } else if (log.eventName === "Mint") {
    pool.reserve[0] += log.args.amount0;
    pool.reserve[1] += log.args.amount1;
    if (
      pool.slot0.tick >= log.args.tickLower &&
      pool.slot0.tick < log.args.tickUpper
    ) {
      pool.liquidity += log.args.amount;
    }
    updateTick(pool.ticks, log.args.tickLower, log.args.amount, false);
    updateTick(pool.ticks, log.args.tickUpper, log.args.amount, true);
  } else if (log.eventName === "Burn") {
    pool.reserve[0] -= log.args.amount0;
    pool.reserve[1] -= log.args.amount1;
    if (
      pool.slot0.tick >= log.args.tickLower &&
      pool.slot0.tick < log.args.tickUpper
    ) {
      pool.liquidity -= log.args.amount;
    }
    updateTick(pool.ticks, log.args.tickLower, -log.args.amount, false);
    updateTick(pool.ticks, log.args.tickUpper, -log.args.amount, true);
  }
  pool.blockNumber = log.blockNumber;
};

const updateTick = (ticks, tick, liquidityDelta, isUpper) => {
  const liquidityBefore = ticks?.[tick]?.[0] ?? BigInt(0);
  const liquidityAfter = liquidityBefore + liquidityDelta;
  const liquidityNet = ticks?.[tick]?.[1] ?? BigInt(0);
  ticks[tick] = [
    liquidityAfter,
    isUpper ? liquidityNet - liquidityDelta : liquidityNet + liquidityDelta,
  ];
};
